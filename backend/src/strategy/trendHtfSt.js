/**
 * TREND_HTF_ST — HTF trend + Supertrend flip entries.
 *
 * Production stack:
 * 1. HTF EMA21/50 alignment (min separation)
 * 2. Spike bar filter (range ≤ 2× ATR14)
 * 3. Optional surgical loss filter — blocks only loss-correlated flags (cross/sideways-triple)
 * 4. Full regime gate (optional) — cuts ~50% of trades; use only for H2 protection
 *
 * Max return: trendHtfStRegimeGate: false. Loss fix: trendHtfStSurgicalLossFilter: true
 */

import { ema, adx as computeAdx, atr as computeAtr } from "./indicators.js";
import { dirStore } from "./adapterPersisted.js";
import { computeSupertrendSeries } from "./supertrend.js";
import {
  shouldAllowTrendHtfStEntry,
  isTrendHtfStRegimeGateEnabled,
  isTrendHtfStSurgicalLossFilterEnabled,
} from "./trendHtfStRegime.js";

const WARMUP = 80;
const DEFAULT_MIN_HTF_SEP = 0.0005;
const DEFAULT_MIN_ADX = 0;
export const TREND_HTF_ST_MIN_SEP_STRICT = 0.0012;
export const TREND_HTF_ST_MIN_ADX_STRICT = 20;
export const TREND_HTF_ST_MAX_ENTRY_RANGE_ATR = 2;

function aggregateToHourly(candles) {
  if (!candles.length) return [];
  const hourly = [];
  let cur = null;
  for (const c of candles) {
    const hourTs = Math.floor(c.ts / 3600000) * 3600000;
    if (!cur || cur.ts !== hourTs) {
      if (cur) hourly.push(cur);
      cur = {
        ts: hourTs,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: Number(c.volume) || 0,
      };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += Number(c.volume) || 0;
    }
  }
  if (cur) hourly.push(cur);
  return hourly;
}

function hourIndexForBar(barTs, hourly) {
  const hourTs = Math.floor(barTs / 3600000) * 3600000;
  let lo = 0;
  let hi = hourly.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (hourly[mid].ts <= hourTs) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/**
 * @param {object} [opts]
 * @param {object} [opts.regimeCfg] — full bot cfg for regime gate
 */
export function buildTrendHtfStSignalSeries(candles, opts = {}) {
  const period = Number(opts.period ?? 10);
  const mult = Number(opts.multiplier ?? 2.5);
  const regimeCfg = opts.regimeCfg ?? {};
  const regimeOn = isTrendHtfStRegimeGateEnabled(regimeCfg);
  const surgicalOn = isTrendHtfStSurgicalLossFilterEnabled(regimeCfg);
  const entryFilterOn = regimeOn || surgicalOn;
  const minSep = regimeOn ? 0 : Number(opts.minHtfSep ?? DEFAULT_MIN_HTF_SEP);
  const minAdx = Number(opts.minAdx ?? DEFAULT_MIN_ADX);
  const requireBarQuality = opts.requireBarQuality === true;
  const maxRangeAtr = Number(opts.maxEntryRangeAtr ?? 0);
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < WARMUP) return out;

  const hourly = aggregateToHourly(candles);
  if (hourly.length < 55) return out;
  const hCloses = hourly.map((c) => c.close);
  const hEma21 = ema(hCloses, 21);
  const hEma50 = ema(hCloses, 50);
  const st = computeSupertrendSeries(candles, { period, multiplier: mult, wilderAtr: true });
  const adxSeries = minAdx > 0 ? computeAdx(candles, 14) : null;
  const atrSeries = maxRangeAtr > 0 ? computeAtr(candles, 14) : null;

  for (let i = WARMUP; i < n; i++) {
    const hIdx = hourIndexForBar(candles[i].ts, hourly);
    if (hIdx < 50) continue;
    const e21 = hEma21[hIdx];
    const e50 = hEma50[hIdx];
    if (!Number.isFinite(e21) || !Number.isFinite(e50) || e50 === 0) continue;
    const sep = Math.abs(e21 - e50) / Math.abs(e50);
    if (sep < minSep) continue;
    const htfUp = e21 > e50;
    const htfDown = e21 < e50;
    const bar = st[i];
    if (!bar?.ready) continue;

    if (maxRangeAtr > 0) {
      const atrVal = atrSeries[i];
      const c = candles[i];
      const range = (c.high - c.low) || 0;
      if (atrVal > 0 && range / atrVal > maxRangeAtr) continue;
    }

    if (minAdx > 0) {
      const adxVal = adxSeries[i];
      if (!Number.isFinite(adxVal) || adxVal < minAdx) continue;
    }

    const c = candles[i];
    if (requireBarQuality) {
      if (bar.buySignal && htfUp && c.close < c.open) continue;
      if (bar.sellSignal && htfDown && c.close > c.open) continue;
    }

    if (bar.buySignal && htfUp) {
      if (entryFilterOn && !shouldAllowTrendHtfStEntry(candles, i, "BUY", regimeCfg)) continue;
      out[i] = { action: "BUY", reason: "trend_htf_st_long" };
    } else if (bar.sellSignal && htfDown) {
      if (entryFilterOn && !shouldAllowTrendHtfStEntry(candles, i, "SELL", regimeCfg)) continue;
      out[i] = { action: "SELL", reason: "trend_htf_st_short" };
    }
  }
  return out;
}

/** Maps cfg → signal opts. Regime gate on by default. */
export function buildTrendHtfStQualityOpts(cfg = {}) {
  const strict = cfg.trendHtfStQualityFilter === true;
  const maxAtr = cfg.trendHtfStMaxEntryRangeAtr;
  const maxEntryRangeAtr =
    maxAtr === 0 ? 0 : Number(maxAtr ?? TREND_HTF_ST_MAX_ENTRY_RANGE_ATR);

  if (strict) {
    return {
      maxEntryRangeAtr,
      minHtfSep: Number(cfg.trendHtfStMinHtfSep ?? TREND_HTF_ST_MIN_SEP_STRICT),
      minAdx: Number(cfg.trendHtfStMinAdx ?? TREND_HTF_ST_MIN_ADX_STRICT),
      requireBarQuality: cfg.trendHtfStRequireBarQuality !== false,
      regimeCfg: { trendHtfStRegimeGate: false, ...cfg },
    };
  }

  return {
    maxEntryRangeAtr,
    minHtfSep: Number(cfg.trendHtfStMinHtfSep ?? DEFAULT_MIN_HTF_SEP),
    minAdx: Number(cfg.trendHtfStMinAdx ?? DEFAULT_MIN_ADX),
    requireBarQuality: cfg.trendHtfStRequireBarQuality === true,
    regimeCfg: cfg,
  };
}

export function buildTrendHtfStBacktestAdapter(candles, opts = {}) {
  const series = buildTrendHtfStSignalSeries(candles, opts);
  const local = { lastDir: 0 };
  return function trendHtfStAdapter(bar, idx, ctx) {
    const sig = series[idx];
    if (!sig) return null;
    const d = dirStore(ctx, local);
    if (sig.action === "BUY" && d.lastDir !== 1) {
      d.lastDir = 1;
      return { action: "BUY", reason: sig.reason };
    }
    if (sig.action === "SELL" && d.lastDir !== -1) {
      d.lastDir = -1;
      return { action: "SELL", reason: sig.reason };
    }
    return null;
  };
}

export const TREND_HTF_ST = {
  name: "HTF Trend + Supertrend (regime-gated)",
  signal() {
    return { action: "HOLD", reason: "use_backtest_adapter" };
  },
};
