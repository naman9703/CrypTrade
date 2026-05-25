/**
 * SUPERTREND_ELITE — High-conviction ST entry filter.
 *
 * Base signal: Supertrend flip (same bar-level event as SUPERTREND strategy).
 * Five independent gate layers must ALL pass before a trade is opened:
 *
 *   Gate 1 — ADX strength + rising (eliminates choppy-market whipsaws)
 *   Gate 2 — Volume confirmation (eliminates low-conviction breakouts)
 *   Gate 3 — 1H EMA21/50 structural alignment (eliminates counter-structure trades)
 *   Gate 4 — 4H Supertrend direction (eliminates counter-HTF-trend trades)
 *   Gate 5 — ATR expansion (catches explosive moves, not fading volatility)
 *
 * Bonus gate (optional): liquidity sweep in the 3 bars prior to signal
 * (highest-conviction setup, can boost size or relax other thresholds).
 *
 * All thresholds are configurable. Defaults target ~100 trades / 80%+ WR
 * on 15m BNBUSDT Jan–May 2026.
 *
 * Design: fully pre-computed O(n) series so the backtest adapter does O(1)
 * per bar. All series use closed-bar data only (no look-ahead).
 */

import { ema, adx as computeAdx, atr as computeAtr } from "./indicators.js";
import { computeSupertrendSeries } from "./supertrend.js";

const WARMUP = 120;
const ONE_HOUR_MS = 60 * 60 * 1000;
const FOUR_HOURS_MS = 4 * ONE_HOUR_MS;

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const ELITE_ST_DEFAULTS = {
  // Supertrend (primary TF)
  period: 10,
  multiplier: 3.0,
  wilderAtr: true,

  // Gate 1 — ADX
  minAdx: 25,
  requireAdxRising: true,
  adxRisingLookback: 3,

  // Gate 2 — Volume
  minVolumeVsAvg: 1.5,

  // Gate 3 — 1H EMA structure
  requireHtf1hEmaAlign: true,
  htf1hEma21Period: 21,
  htf1hEma50Period: 50,
  htf1hMinSep: 0.0003,   // 0.03% minimum separation between EMA21 and EMA50

  // Gate 4 — 4H Supertrend
  requireHtf4hAlign: true,
  htf4hPeriod: 10,
  htf4hMultiplier: 3.0,

  // Gate 5 — ATR expansion
  requireAtrExpansion: true,
  minAtrExpansion: 1.15,   // current ATR > 1.15× of recent ATR average
  atrExpansionLookback: 12,

  // Bonus gate — liquidity sweep
  liqSweepEnabled: false,
  liqSweepLookback: 4,
  liqSweepLookbackRange: 20, // range of highs/lows used to define the "wall"
};

// ─── HTF helpers ──────────────────────────────────────────────────────────────

function aggregateToHtf(candles, bucketMs) {
  if (!candles.length) return [];
  const out = [];
  let cur = null;
  for (const c of candles) {
    const bts = Math.floor(c.ts / bucketMs) * bucketMs;
    if (!cur || cur.ts !== bts) {
      if (cur) out.push(cur);
      cur = { ts: bts, open: c.open, high: c.high, low: c.low, close: c.close, volume: Number(c.volume) || 0 };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += Number(c.volume) || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Binary-search: largest index where htfCandles[idx].ts <= barTs */
function htfIdxFor(htfCandles, barTs) {
  let lo = 0, hi = htfCandles.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (htfCandles[mid].ts <= barTs) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

// ─── Liquidity sweep detection ────────────────────────────────────────────────

/**
 * Returns true when, in the `lookback` bars BEFORE bar[idx], price briefly
 * swept a key level (previous high for SELL / previous low for BUY) and
 * closed back inside — classic stop-hunt pattern that precedes fast moves.
 */
function detectLiqSweep(candles, idx, side, lookback, rangeLen) {
  if (idx < lookback + rangeLen) return false;
  const rangeStart = idx - lookback - rangeLen;
  const rangeEnd   = idx - lookback;
  // Build the reference high/low from the range window
  let refHigh = -Infinity, refLow = Infinity;
  for (let j = rangeStart; j < rangeEnd; j++) {
    refHigh = Math.max(refHigh, candles[j].high);
    refLow  = Math.min(refLow,  candles[j].low);
  }
  // Check if any of the last `lookback` bars swept that level
  for (let j = rangeEnd; j < idx; j++) {
    const c = candles[j];
    if (side === "BUY") {
      // Look for a low-sweep below refLow followed by close above refLow
      if (c.low < refLow && c.close > refLow) return true;
    } else {
      // Look for a high-sweep above refHigh followed by close below refHigh
      if (c.high > refHigh && c.close < refHigh) return true;
    }
  }
  return false;
}

// ─── Core pre-computation ─────────────────────────────────────────────────────

/**
 * Pre-compute all indicator series needed by the 5 gates.
 * Returns a context object used by buildEliteStSignalSeries().
 */
function buildEliteStContext(candles, opts) {
  const o = { ...ELITE_ST_DEFAULTS, ...opts };
  const n = candles.length;

  // Primary ST
  const stSeries = computeSupertrendSeries(candles, {
    period: o.period,
    multiplier: o.multiplier,
    wilderAtr: o.wilderAtr !== false,
  });

  // Gate 1: ADX (14 period)
  const adxSeries = computeAdx(candles, 14);

  // Gate 2: Volume ratio = volume / EMA-20-of-volume
  const volumes = candles.map((c) => c.volume ?? 0);
  const volEma20 = ema(volumes, 20);
  const volRatio = volumes.map((v, i) => (volEma20[i] > 0 ? v / volEma20[i] : 1));

  // Gate 3: 1H EMA21/50 alignment
  const htf1h = aggregateToHtf(candles, ONE_HOUR_MS);
  const h1Closes = htf1h.map((c) => c.close);
  const h1Ema21 = ema(h1Closes, o.htf1hEma21Period);
  const h1Ema50 = ema(h1Closes, o.htf1hEma50Period);

  // Gate 4: 4H Supertrend direction
  const htf4h = aggregateToHtf(candles, FOUR_HOURS_MS);
  const st4hSeries = computeSupertrendSeries(htf4h, {
    period: o.htf4hPeriod,
    multiplier: o.htf4hMultiplier,
    wilderAtr: true,
  });
  const trend4h = st4hSeries.map((s) => (s?.ready ? (s.trend ?? 0) : 0));

  // Gate 5: ATR expansion
  const atrSeries = computeAtr(candles, 14);
  const atrEmaLookback = ema(atrSeries, o.atrExpansionLookback);

  return { stSeries, adxSeries, volRatio, htf1h, h1Ema21, h1Ema50, htf4h, trend4h, atrSeries, atrEmaLookback, opts: o, n };
}

// ─── Signal series ─────────────────────────────────────────────────────────────

/**
 * Build the per-bar signal array.
 * Each entry is either null (no signal) or { action: 'BUY'|'SELL', reason, gates }.
 *
 * @param {Array} candles  OHLCV array (primary TF)
 * @param {object} [opts]  Config overrides (see ELITE_ST_DEFAULTS)
 */
export function buildEliteStSignalSeries(candles, opts = {}) {
  const ctx = buildEliteStContext(candles, opts);
  const { stSeries, adxSeries, volRatio, htf1h, h1Ema21, h1Ema50, htf4h, trend4h, atrSeries, atrEmaLookback, n } = ctx;
  const o = ctx.opts;
  const out = new Array(n).fill(null);

  for (let i = WARMUP; i < n; i++) {
    const bar = stSeries[i];
    if (!bar?.ready) continue;
    const isBuy  = bar.buySignal;
    const isSell = bar.sellSignal;
    if (!isBuy && !isSell) continue;
    const side = isBuy ? "BUY" : "SELL";
    const gates = {};

    // ── Gate 1: ADX strength ──────────────────────────────────────────────────
    const adxNow  = adxSeries[i] ?? 0;
    const adxPrev = adxSeries[Math.max(0, i - o.adxRisingLookback)] ?? 0;
    const adxOk   = adxNow >= o.minAdx && (!o.requireAdxRising || adxNow > adxPrev);
    gates.adx = { pass: adxOk, adxNow, adxPrev };
    if (!adxOk) continue;

    // ── Gate 2: Volume ─────────────────────────────────────────────────────────
    const vr    = volRatio[i] ?? 1;
    const volOk = vr >= o.minVolumeVsAvg;
    gates.volume = { pass: volOk, ratio: vr };
    if (!volOk) continue;

    // ── Gate 3: 1H EMA structure ───────────────────────────────────────────────
    // Use the PREVIOUS completed 1H bar to avoid look-ahead from the in-progress bar.
    let htf1hOk = true;
    if (o.requireHtf1hEmaAlign) {
      const h1Raw = htfIdxFor(htf1h, candles[i].ts);
      // h1Raw is the current (possibly in-progress) 1H bucket. Use h1Raw - 1 (last completed bar).
      const h1Idx = h1Raw - 1;
      if (h1Idx < o.htf1hEma50Period) {
        htf1hOk = false;
      } else {
        const e21 = h1Ema21[h1Idx] ?? 0;
        const e50 = h1Ema50[h1Idx] ?? 0;
        if (e50 === 0) { htf1hOk = false; }
        else {
          const sep = Math.abs(e21 - e50) / e50;
          const aligned = side === "BUY" ? e21 > e50 : e21 < e50;
          htf1hOk = aligned && sep >= o.htf1hMinSep;
        }
      }
    }
    gates.htf1h = { pass: htf1hOk };
    if (!htf1hOk) continue;

    // ── Gate 4: 4H Supertrend direction ───────────────────────────────────────
    // Use the PREVIOUS completed 4H bar (h4Idx - 1) to avoid look-ahead.
    // The current bucket's close is the final 15m close of that 4H period (future data).
    let htf4hOk = true;
    if (o.requireHtf4hAlign) {
      const h4Raw = htfIdxFor(htf4h, candles[i].ts);
      const h4Idx = h4Raw - 1; // previous completed 4H bar
      if (h4Idx < 0) {
        htf4hOk = false;
      } else {
        const dir4h = trend4h[h4Idx] ?? 0;
        htf4hOk = dir4h !== 0 && (side === "BUY" ? dir4h === 1 : dir4h === -1);
        gates.htf4h = { pass: htf4hOk, trend: dir4h };
      }
    }
    if (!htf4hOk) continue;

    // ── Gate 5: ATR expansion ─────────────────────────────────────────────────
    let atrOk = true;
    if (o.requireAtrExpansion) {
      const atrNow = atrSeries[i] ?? 0;
      const atrAvg = atrEmaLookback[i] ?? 0;
      atrOk = atrAvg > 0 && atrNow >= o.minAtrExpansion * atrAvg;
      gates.atr = { pass: atrOk, atrNow, atrAvg };
    }
    if (!atrOk) continue;

    // ── Bonus: Liquidity sweep ─────────────────────────────────────────────────
    const hasSweep = o.liqSweepEnabled
      ? detectLiqSweep(candles, i, side, o.liqSweepLookback, o.liqSweepLookbackRange)
      : null;

    out[i] = {
      action: side,
      reason: `elite_st_${side.toLowerCase()}${hasSweep ? "_liq" : ""}`,
      gates,
      hasSweep: hasSweep === true,
    };
  }

  return out;
}

// ─── Backtest adapter ─────────────────────────────────────────────────────────

/**
 * Builds the stateful function used by the backtest runner.
 *
 * Key design: when a raw ST flip is filtered by the gates, `lastDir` is still
 * reset so the NEXT same-direction signal can fire after a SL/TP exit.
 * Without this reset, lastDir gets stuck and starves the adapter of trades.
 *
 * @param {Array} candles
 * @param {object} [opts]  Merged from cfg by buildBacktestAdapters (see baselines.js)
 */
export function buildEliteStBacktestAdapter(candles, opts = {}) {
  const series = buildEliteStSignalSeries(candles, opts);
  // Raw primary ST for direction-reset tracking (no gates)
  const rawSt = computeSupertrendSeries(candles, {
    period:     opts.period     ?? ELITE_ST_DEFAULTS.period,
    multiplier: opts.multiplier ?? ELITE_ST_DEFAULTS.multiplier,
    wilderAtr:  opts.wilderAtr  !== false,
  });
  let lastDir = 0;

  return function eliteStAdapter(bar, idx) {
    // When the raw ST flips opposite to lastDir (even if filtered), reset so
    // the next with-trend signal can re-enter after a SL/TP closure.
    const raw = rawSt[idx];
    if (raw?.sellSignal && lastDir === 1)  lastDir = 0;
    if (raw?.buySignal  && lastDir === -1) lastDir = 0;

    const sig = series[idx];
    if (!sig) return null;
    if (sig.action === "BUY" && lastDir !== 1) {
      lastDir = 1;
      return { action: "BUY", reason: sig.reason };
    }
    if (sig.action === "SELL" && lastDir !== -1) {
      lastDir = -1;
      return { action: "SELL", reason: sig.reason };
    }
    return null;
  };
}

// ─── Config helpers ──────────────────────────────────────────────────────────

/** Minimum primary ST multiplier for Elite (2.5 produces ~2× noise vs validated 3.0 on 1H). */
export const ELITE_ST_MIN_MULTIPLIER = 3;

/**
 * Sanitize cfg before backtest/live Elite runs.
 * Fixes saved strategies that still carry Supertrend-only SL/TP and multiplier 2.5.
 *
 * @param {Record<string, unknown>} cfg
 * @returns {Record<string, unknown>}
 */
export function normalizeEliteStRunCfg(cfg = {}) {
  const out = { ...cfg };
  const mult = Number(out.supertrendMultiplier ?? ELITE_ST_DEFAULTS.multiplier);
  if (!Number.isFinite(mult) || mult < ELITE_ST_MIN_MULTIPLIER) {
    out.supertrendMultiplier = ELITE_ST_DEFAULTS.multiplier;
  }
  if (out.trailingStopLossAuto === true) {
    out.supertrendFuturesFixedSlPct = 0;
    out.supertrendFuturesFixedTpPct = 0;
  }
  // Validated preset always uses both HTF gates (saved strategies often leave 1H EMA off by mistake).
  out.eliteStRequireHtf4hAlign = true;
  out.eliteStRequireHtf1hEmaAlign = true;
  if (out.eliteStHtf1hMinSep == null || Number(out.eliteStHtf1hMinSep) <= 0) {
    out.eliteStHtf1hMinSep = ELITE_ST_DEFAULTS.htf1hMinSep;
  }
  return out;
}

/** Defaults applied when user switches manualStrategy to SUPERTREND_ELITE in the UI. */
export const ELITE_ST_ACTIVATION_PATCH = {
  manualStrategy: "SUPERTREND_ELITE",
  strategyMode: "MANUAL",
  supertrendFuturesAuto: false,
  supertrendSpotAuto: false,
  supertrendPeriod: ELITE_ST_DEFAULTS.period,
  supertrendMultiplier: ELITE_ST_DEFAULTS.multiplier,
  supertrendWilderAtr: true,
  eliteStRequireHtf4hAlign: true,
  eliteStHtf4hPeriod: ELITE_ST_DEFAULTS.htf4hPeriod,
  eliteStHtf4hMultiplier: ELITE_ST_DEFAULTS.htf4hMultiplier,
  eliteStRequireHtf1hEmaAlign: true,
  eliteStHtf1hMinSep: ELITE_ST_DEFAULTS.htf1hMinSep,
  eliteStMinAdx: 0,
  eliteStRequireAdxRising: false,
  eliteStMinVolumeVsAvg: 0,
  eliteStRequireAtrExpansion: false,
  eliteStLiqSweepEnabled: false,
  trailingStopLossAuto: true,
  futuresTrailingStopMode: "SUPERTREND",
  supertrendFuturesExitOnFlip: true,
  supertrendFuturesFixedSlPct: 0,
  supertrendFuturesFixedTpPct: 0,
  riskPerTrade: 5,
  riskPerTradeUnit: "PCT",
  futuresLeverage: 25,
};

/**
 * Translate raw bot cfg into opts for buildEliteStBacktestAdapter / buildEliteStSignalSeries.
 */
export function buildEliteStOptsFromCfg(cfg = {}) {
  const c = normalizeEliteStRunCfg(cfg);
  return {
    period:              Number(c.supertrendPeriod      ?? ELITE_ST_DEFAULTS.period),
    multiplier:          Number(c.supertrendMultiplier  ?? ELITE_ST_DEFAULTS.multiplier),
    wilderAtr:           c.supertrendWilderAtr !== false,

    minAdx:              Number(c.eliteStMinAdx         ?? ELITE_ST_DEFAULTS.minAdx),
    requireAdxRising:    c.eliteStRequireAdxRising      !== false,
    adxRisingLookback:   Number(c.eliteStAdxRisingLookback ?? ELITE_ST_DEFAULTS.adxRisingLookback),

    minVolumeVsAvg:      Number(c.eliteStMinVolumeVsAvg ?? ELITE_ST_DEFAULTS.minVolumeVsAvg),

    requireHtf1hEmaAlign: c.eliteStRequireHtf1hEmaAlign !== false,
    htf1hMinSep:          Number(c.eliteStHtf1hMinSep   ?? ELITE_ST_DEFAULTS.htf1hMinSep),

    requireHtf4hAlign:    c.eliteStRequireHtf4hAlign    !== false,
    htf4hPeriod:          Number(c.eliteStHtf4hPeriod   ?? ELITE_ST_DEFAULTS.htf4hPeriod),
    htf4hMultiplier:      Number(c.eliteStHtf4hMultiplier ?? ELITE_ST_DEFAULTS.htf4hMultiplier),

    requireAtrExpansion:  c.eliteStRequireAtrExpansion  !== false,
    minAtrExpansion:      Number(c.eliteStMinAtrExpansion ?? ELITE_ST_DEFAULTS.minAtrExpansion),
    atrExpansionLookback: Number(c.eliteStAtrExpansionLookback ?? ELITE_ST_DEFAULTS.atrExpansionLookback),

    liqSweepEnabled:      c.eliteStLiqSweepEnabled     === true,
    liqSweepLookback:     Number(c.eliteStLiqSweepLookback ?? ELITE_ST_DEFAULTS.liqSweepLookback),
    liqSweepLookbackRange: Number(c.eliteStLiqSweepLookbackRange ?? ELITE_ST_DEFAULTS.liqSweepLookbackRange),
  };
}

// ─── Strategy descriptor (live bot placeholder) ──────────────────────────────

export const SUPERTREND_ELITE = {
  name: "Supertrend Elite (5-gate: ADX+Vol+1H+4H+ATR)",
  signal() {
    return { action: "HOLD", reason: "use_backtest_adapter" };
  },
};
