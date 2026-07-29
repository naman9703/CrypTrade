/**
 * LIQ_CASCADE — liquidation cascade event-driven scalping (bar-close backtest + tick live).
 *
 * Features are computed on the liquidation series' own timeline: each Coinalyze
 * bar is stamped at interval START, so it only becomes observable at its CLOSE
 * (ts + intervalMs). This removes look-ahead and hour-boundary artifacts.
 *
 * Trigger (per completed liq bar, once): liq z-score spike vs prior liq bars +
 * side dominance + price displacement across the bar span + OI drop bar-over-bar.
 * Confirm: stall/reclaim candle within one liq interval of candles.
 * Default direction: fade forced flow (mean-revert overshoot).
 */

import { atr as atrFn } from "../indicators.js";

export const LIQ_CASCADE_WARMUP = 120;
export const LIQ_CASCADE_PAD_BARS = 240;

export const LIQ_CASCADE_DEFAULTS = Object.freeze({
  liqInterval: "5min",
  liqZScoreMin: 2.0,
  liqLookbackBars: 48,
  cascadeWindowBars: 3,
  minDispAtrMult: 1.0,
  minOiDropPct: 0.12,
  exhaustionDecayRatio: 0.55,
  directionMode: "fade",
  minAtrPct: 0.035,
  slBufferPct: 0.0015,
  tpAtrMult: 1.25,
  minRr: 0.8,
  maxHoldBars: 24,
  maxTradesPerDay: 8,
  minBarGap: 2,
  tradeSides: "BOTH",
  minLiqUsdBar: 50_000,
});

const DOM_RATIO = 1.2;
const MIN_Z_BASELINE_BARS = 8;
const MAX_BRACKET_SCAN_BARS = 300;

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function liqIntervalToMs(interval) {
  const s = String(interval || "5min");
  if (s === "1min") return 60_000;
  if (s === "5min") return 300_000;
  if (s === "15min") return 900_000;
  if (s === "30min") return 1_800_000;
  if (s === "1hour") return 3_600_000;
  if (s === "4hour") return 14_400_000;
  if (s === "daily") return 86_400_000;
  return 300_000;
}

/** Binary search: latest entry with entry.ts <= ts. @param {number} ts @param {{ ts: number }[]} series */
export function lookupAtOrBefore(ts, series) {
  if (!series?.length) return null;
  let lo = 0;
  let hi = series.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = Number(series[mid].ts);
    if (t <= ts) {
      best = series[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function candleIdxAtOrBefore(candles, ts) {
  let lo = 0;
  let hi = candles.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Number(candles[mid].ts) <= ts) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/** Sum liq long/short USD in (fromTs, toTs] from raw interval rows (open-stamped). */
export function sumLiqInWindow(liqSeries, fromTs, toTs) {
  let longUsd = 0;
  let shortUsd = 0;
  for (const row of liqSeries ?? []) {
    const t = Number(row.ts);
    if (t <= fromTs || t > toTs) continue;
    longUsd += Number(row.liqLongUsd ?? 0);
    shortUsd += Number(row.liqShortUsd ?? 0);
  }
  return { longUsd, shortUsd, totalUsd: longUsd + shortUsd };
}

/**
 * Convert raw Coinalyze liq rows (ts = interval start) into causal bars keyed at
 * close time, with per-bar z-score vs prior bars, side dominance and decay ratio.
 * @param {{ ts: number, liqLongUsd?: number, liqShortUsd?: number }[]} liqSeries
 * @param {{ intervalMs?: number, lookbackBars?: number }} opts
 */
export function prepareLiqBars(liqSeries, { intervalMs = 300_000, lookbackBars = 48 } = {}) {
  const bars = (liqSeries ?? [])
    .map((r) => {
      const longUsd = Number(r.liqLongUsd ?? 0);
      const shortUsd = Number(r.liqShortUsd ?? 0);
      return {
        tsOpen: Number(r.ts),
        ts: Number(r.ts) + intervalMs,
        longUsd,
        shortUsd,
        totalUsd: longUsd + shortUsd,
        z: null,
        dom: "neutral",
        decayFromPeak: null,
      };
    })
    .sort((a, b) => a.ts - b.ts);

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const from = Math.max(0, i - lookbackBars);
    const nBase = i - from;
    if (nBase >= MIN_Z_BASELINE_BARS) {
      let sum = 0;
      for (let k = from; k < i; k++) sum += bars[k].totalUsd;
      const mean = sum / nBase;
      let varSum = 0;
      for (let k = from; k < i; k++) varSum += (bars[k].totalUsd - mean) ** 2;
      const std = Math.sqrt(varSum / nBase);
      b.z = std > 0 ? (b.totalUsd - mean) / std : b.totalUsd > mean ? 99 : 0;
    }
    if (b.longUsd > b.shortUsd * DOM_RATIO) b.dom = "longs";
    else if (b.shortUsd > b.longUsd * DOM_RATIO) b.dom = "shorts";
    let peak = 0;
    for (let k = Math.max(0, i - 3); k < i; k++) peak = Math.max(peak, bars[k].totalUsd);
    b.decayFromPeak = peak > 0 ? b.totalUsd / peak : null;
  }
  return bars;
}

/**
 * Convert raw Coinalyze OI rows (ts = interval start) into causal bars keyed at
 * close time, with bar-over-bar drop pct.
 * @param {{ ts: number, oiCloseUsd?: number }[]} oiSeries
 */
export function prepareOiBars(oiSeries, intervalMs = 300_000) {
  const bars = (oiSeries ?? [])
    .map((r) => ({ ts: Number(r.ts) + intervalMs, oi: Number(r.oiCloseUsd ?? 0), dropPct: null }))
    .sort((a, b) => a.ts - b.ts);
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    if (prev.oi > 0) bars[i].dropPct = ((prev.oi - bars[i].oi) / prev.oi) * 100;
  }
  return bars;
}

function stallReclaimBar(candles, idx, dom) {
  const c = candles[idx];
  const p = candles[idx - 1];
  const close = Number(c.close);
  const open = Number(c.open);
  const body = Math.abs(close - open);
  const range = Math.max(Number(c.high) - Number(c.low), 1e-12);
  const smallBody = body / range < 0.55;
  if (dom === "longs") {
    return close >= Number(p.close) || smallBody;
  }
  if (dom === "shorts") {
    return close <= Number(p.close) || smallBody;
  }
  return smallBody;
}

function resolveAction(dom, directionMode) {
  const mode = String(directionMode || "fade").toLowerCase();
  if (dom === "longs") return mode === "continuation" ? "SELL" : "BUY";
  if (dom === "shorts") return mode === "continuation" ? "BUY" : "SELL";
  return null;
}

function buildBrackets(candles, startIdx, idx, action, atrArr, closes, opts) {
  const close = closes[idx];
  const atrVal = atrArr[idx];
  if (!(close > 0) || !(atrVal > 0)) return null;
  const buf = num(opts.slBufferPct, LIQ_CASCADE_DEFAULTS.slBufferPct);
  const tpMult = num(opts.tpAtrMult, LIQ_CASCADE_DEFAULTS.tpAtrMult);
  const from = Math.max(0, Math.min(startIdx, idx), idx - MAX_BRACKET_SCAN_BARS);
  let extreme = action === "BUY" ? Infinity : -Infinity;
  for (let k = from; k <= idx; k++) {
    extreme =
      action === "BUY"
        ? Math.min(extreme, Number(candles[k].low))
        : Math.max(extreme, Number(candles[k].high));
  }
  const slPx = action === "BUY" ? extreme * (1 - buf) : extreme * (1 + buf);
  const slPct = Math.abs(close - slPx) / close;
  const tpPct = (atrVal * tpMult) / close;
  if (slPct <= 0 || tpPct / slPct < num(opts.minRr, LIQ_CASCADE_DEFAULTS.minRr)) return null;
  return {
    slPct,
    tpPct,
    entryPrice: close,
    level: Number(candles[from].close),
    sweepWick: extreme,
  };
}

/**
 * @param {object[]} candles
 * @param {{ liqSeries?: object[], oiSeries?: object[], opts?: object }} ctx
 */
export function buildLiqCascadeSeries(candles, ctx = {}) {
  const opts = { ...LIQ_CASCADE_DEFAULTS, ...ctx.opts };
  const n = candles?.length ?? 0;
  const series = new Array(n).fill(null);
  if (n < LIQ_CASCADE_WARMUP + 2) return { series, feat: null };

  const intervalMs = liqIntervalToMs(opts.liqInterval);
  const liqBars = prepareLiqBars(ctx.liqSeries, {
    intervalMs,
    lookbackBars: num(opts.liqLookbackBars, LIQ_CASCADE_DEFAULTS.liqLookbackBars),
  });
  const oiBars = prepareOiBars(ctx.oiSeries, intervalMs);

  const closes = candles.map((c) => Number(c.close));
  const atr = atrFn(candles, 14);
  const tfMs = Number(candles[1].ts) - Number(candles[0].ts) || 60_000;
  const confirmBars = Math.max(3, Math.round(intervalMs / tfMs));
  const sides = String(opts.tradeSides || "BOTH").toUpperCase();

  const signaledBars = new Set();
  let cascade = null;

  for (let i = LIQ_CASCADE_WARMUP + 1; i < n; i++) {
    const ts = Number(candles[i].ts);
    const atrVal = atr[i];
    const atrPct = closes[i] > 0 && atrVal > 0 ? (atrVal / closes[i]) * 100 : 0;

    // Latest COMPLETED liq bar (bars keyed at close time — no look-ahead).
    const lb = lookupAtOrBefore(ts, liqBars);
    if (lb && !signaledBars.has(lb.ts) && (!cascade || cascade.liqBarTs !== lb.ts)) {
      const ob = lookupAtOrBefore(ts, oiBars);
      const oiDrop = ob?.dropPct ?? null;
      const oiOk =
        num(opts.minOiDropPct, 0) <= 0 ? true : oiDrop != null && oiDrop >= opts.minOiDropPct;
      const startIdx = candleIdxAtOrBefore(candles, lb.tsOpen);
      const disp =
        atrVal > 0 && startIdx != null ? Math.abs(closes[i] - closes[startIdx]) / atrVal : null;
      if (
        lb.z != null &&
        lb.z >= opts.liqZScoreMin &&
        (lb.dom === "longs" || lb.dom === "shorts") &&
        lb.totalUsd >= opts.minLiqUsdBar &&
        disp != null &&
        disp >= opts.minDispAtrMult &&
        oiOk &&
        atrPct >= opts.minAtrPct
      ) {
        cascade = {
          dom: lb.dom,
          liqBarTs: lb.ts,
          startIdx: startIdx ?? i,
          expiresIdx: i + confirmBars,
          z: lb.z,
          liqUsd: lb.totalUsd,
          oiDrop,
          disp,
        };
      }
    }

    if (!cascade) continue;
    if (i > cascade.expiresIdx) {
      cascade = null;
      continue;
    }
    if (!stallReclaimBar(candles, i, cascade.dom)) continue;

    const action = resolveAction(cascade.dom, opts.directionMode);
    if (!action) {
      cascade = null;
      continue;
    }
    if (sides === "LONG" && action !== "BUY") {
      cascade = null;
      continue;
    }
    if (sides === "SHORT" && action !== "SELL") {
      cascade = null;
      continue;
    }

    const liqBrackets = buildBrackets(candles, cascade.startIdx, i, action, atr, closes, opts);
    if (!liqBrackets) continue;

    series[i] = {
      action,
      reason: `liq_cascade_${cascade.dom}_${opts.directionMode}`,
      trigger: cascade.dom === "longs" ? "long_liq_cascade_fade" : "short_liq_cascade_fade",
      playbook: "LIQ_CASCADE",
      liqZ: cascade.z,
      liqUsd: cascade.liqUsd,
      oiDropPct: cascade.oiDrop,
      dispAtr: cascade.disp,
      liqBrackets,
    };
    signaledBars.add(cascade.liqBarTs);
    cascade = null;
  }
  return { series, feat: { liqBars, oiBars, atr, closes, tfMs, intervalMs } };
}

/** Live tick tracker — mirrors bar logic on rolling forceOrder window. */
export function createCascadeTickTracker(opts = {}) {
  const o = { ...LIQ_CASCADE_DEFAULTS, ...opts };
  return {
    opts: o,
    ticks: [],
    cascadeActive: false,
    cascadeDom: null,
    cascadeStartMs: 0,
    peakLiqRate: 0,
    prePrice: null,
    lastSignalMs: 0,
  };
}

/** @param {ReturnType<typeof createCascadeTickTracker>} tracker @param {{ time: number, side: string, notionalUsd: number, price?: number }} event */
export function updateCascadeFromTick(tracker, event) {
  const windowMs = tracker.opts.cascadeWindowBars * 60_000;
  tracker.ticks.push(event);
  const cutoff = event.time - windowMs * 4;
  tracker.ticks = tracker.ticks.filter((t) => t.time >= cutoff);

  const recent = tracker.ticks.filter((t) => t.time >= event.time - windowMs);
  let longUsd = 0;
  let shortUsd = 0;
  for (const t of recent) {
    if (t.side === "SELL") longUsd += t.notionalUsd;
    else shortUsd += t.notionalUsd;
  }
  const total = longUsd + shortUsd;
  const rate = total / (windowMs / 60_000);
  let dom = "neutral";
  if (longUsd > shortUsd * DOM_RATIO) dom = "longs";
  else if (shortUsd > longUsd * DOM_RATIO) dom = "shorts";

  const prior = tracker.ticks.filter((t) => t.time >= event.time - 2 * windowMs && t.time < event.time - windowMs);
  let pLong = 0;
  let pShort = 0;
  for (const t of prior) {
    if (t.side === "SELL") pLong += t.notionalUsd;
    else pShort += t.notionalUsd;
  }
  const priorTotal = pLong + pShort;
  const zLike = priorTotal > 0 ? total / priorTotal : total > tracker.opts.minLiqUsdBar ? 2 : 0;

  if (
    dom !== "neutral" &&
    total >= tracker.opts.minLiqUsdBar &&
    zLike >= 1.5 &&
    rate >= tracker.peakLiqRate * 0.5
  ) {
    if (!tracker.cascadeActive) {
      tracker.cascadeActive = true;
      tracker.cascadeDom = dom;
      tracker.cascadeStartMs = event.time;
      tracker.prePrice = event.price ?? null;
      tracker.peakLiqRate = rate;
    } else if (rate > tracker.peakLiqRate) {
      tracker.peakLiqRate = rate;
    }
  }

  if (tracker.cascadeActive && priorTotal > 0 && total / priorTotal <= tracker.opts.exhaustionDecayRatio) {
    return { exhausted: true, dom: tracker.cascadeDom, totalUsd: total, rate };
  }
  return { exhausted: false, dom, totalUsd: total, rate };
}

/** @param {ReturnType<typeof createCascadeTickTracker>} tracker @param {number} lastPrice */
export function evaluateCascadeTickSignal(tracker, lastPrice) {
  if (!tracker.cascadeActive || !tracker.cascadeDom || !(lastPrice > 0)) return null;
  const action = resolveAction(tracker.cascadeDom, tracker.opts.directionMode);
  if (!action) return null;
  const buf = tracker.opts.slBufferPct;
  const pre = tracker.prePrice ?? lastPrice;
  const move = Math.abs(lastPrice - pre) / pre;
  if (move < tracker.opts.minAtrPct / 100) return null;

  const slPx = action === "BUY" ? lastPrice * (1 - buf * 3) : lastPrice * (1 + buf * 3);
  const slPct = Math.abs(lastPrice - slPx) / lastPrice;
  const tpPct = slPct * tracker.opts.minRr;
  tracker.cascadeActive = false;
  tracker.lastSignalMs = Date.now();
  return {
    action,
    reason: `liq_cascade_tick_${tracker.cascadeDom}`,
    trigger: "tick_cascade_exhaustion",
    playbook: "LIQ_CASCADE",
    liqBrackets: { slPct, tpPct, entryPrice: lastPrice, level: pre },
  };
}
