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
import {
  applyAutoCalibrateToOpts,
  buildEliteCoinProfile,
  eliteCfgForSymbol,
  resolveEliteBracketPct,
  resolveEliteTrailDisasterSlPct,
} from "./eliteAutoCalibrate.js";

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
  htf1hMinSep: 0.0003,   // 0.03% minimum separation between EMA21 and EMA50 (FIXED mode)
  /** FIXED | ATR | PERCENTILE | ADX | CALIBRATED — see resolveHtf1hMinSep */
  htf1hSepMode: "FIXED",
  htf1hMinSepAtrMult: 0.25,
  htf1hMinSepFloor: 0.0002,
  htf1hMinSepCeil: 0.0012,
  htf1hSepPercentileLookback: 90,
  htf1hSepPercentileMult: 1.0,
  htf1hSepAdxBase: 0.0003,
  htf1hSepAdxAlpha: 1.5,
  htf1hSepAdxRef: 25,
  htf1hSepCalibratePct: 40,
  htf1hSepCalibrateBars: 90,

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

// ─── Dynamic 1H EMA min-separation ───────────────────────────────────────────

function clampHtf1hMinSep(v, floor, ceil) {
  const lo = Number.isFinite(floor) ? floor : 0.0002;
  const hi = Number.isFinite(ceil) ? ceil : 0.0012;
  return Math.min(hi, Math.max(lo, Number(v) || lo));
}

/**
 * Resolve Gate 3 min EMA separation for the completed 1H bar at h1Idx.
 * Modes: FIXED (constant), ATR (vol-scaled), PERCENTILE (rolling median sep),
 * ADX (chop-scaled), CALIBRATED (constant from warmup distribution).
 */
export function resolveHtf1hMinSep(o, h1Idx, ctx) {
  const floor = o.htf1hMinSepFloor ?? ELITE_ST_DEFAULTS.htf1hMinSepFloor;
  const ceil = o.htf1hMinSepCeil ?? ELITE_ST_DEFAULTS.htf1hMinSepCeil;
  const mode = String(o.htf1hSepMode ?? "FIXED").toUpperCase();
  const fixed = Number(o.htf1hMinSep ?? ELITE_ST_DEFAULTS.htf1hMinSep);

  if (mode === "FIXED") return fixed;
  if (mode === "CALIBRATED") {
    const cal = Number(o._htf1hCalibratedSep);
    return Number.isFinite(cal) && cal > 0 ? clampHtf1hMinSep(cal, floor, ceil) : fixed;
  }

  const e50 = ctx.h1Ema50[h1Idx] ?? 0;
  if (e50 <= 0) return fixed;

  if (mode === "ATR") {
    const atr = ctx.h1Atr[h1Idx] ?? 0;
    const k = Number(o.htf1hMinSepAtrMult ?? ELITE_ST_DEFAULTS.htf1hMinSepAtrMult);
    return clampHtf1hMinSep(k * (atr / e50), floor, ceil);
  }

  if (mode === "PERCENTILE") {
    const lookback = Math.max(20, Math.round(Number(o.htf1hSepPercentileLookback ?? 90)));
    const start = Math.max(0, h1Idx - lookback + 1);
    const slice = [];
    for (let j = start; j <= h1Idx; j++) {
      const s = ctx.h1SepSeries[j];
      if (Number.isFinite(s) && s > 0) slice.push(s);
    }
    if (!slice.length) return fixed;
    slice.sort((a, b) => a - b);
    const mult = Number(o.htf1hSepPercentileMult ?? 1);
    return clampHtf1hMinSep(mult * slice[Math.floor(slice.length / 2)], floor, ceil);
  }

  if (mode === "ADX") {
    const adx = ctx.h1Adx[h1Idx] ?? o.htf1hSepAdxRef ?? 25;
    const base = Number(o.htf1hSepAdxBase ?? ELITE_ST_DEFAULTS.htf1hSepAdxBase);
    const alpha = Number(o.htf1hSepAdxAlpha ?? ELITE_ST_DEFAULTS.htf1hSepAdxAlpha);
    const ref = Math.max(1, Number(o.htf1hSepAdxRef ?? ELITE_ST_DEFAULTS.htf1hSepAdxRef));
    const factor = 1 + alpha * (Math.max(0, ref - adx) / ref);
    return clampHtf1hMinSep(base * factor, floor, ceil);
  }

  return fixed;
}

/** CALIBRATED mode: p-th percentile of 1H EMA sep on warmup bars (no look-ahead). */
export function calibrateHtf1hSepFromSeries(h1SepSeries, { pct = 40, minBars = 90, emaWarmup = 50 } = {}) {
  const end = Math.min(h1SepSeries.length, Math.max(minBars, emaWarmup + 10));
  const vals = [];
  for (let j = emaWarmup; j < end; j++) {
    const s = h1SepSeries[j];
    if (Number.isFinite(s) && s > 0) vals.push(s);
  }
  if (!vals.length) return ELITE_ST_DEFAULTS.htf1hMinSep;
  vals.sort((a, b) => a - b);
  const idx = Math.floor(vals.length * (Math.max(1, Math.min(99, pct)) / 100));
  return vals[Math.min(Math.max(0, idx), vals.length - 1)];
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
  const h1SepSeries = h1Ema21.map((e21, i) => {
    const e50 = h1Ema50[i] ?? 0;
    return e50 > 0 ? Math.abs(e21 - e50) / e50 : 0;
  });
  const h1Atr = computeAtr(htf1h, 14);
  const h1Adx = computeAdx(htf1h, 14);

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

  let optsOut = o;
  if (o.autoCalibrate === true) {
    const profileBars = Math.max(40, Math.round(Number(o.profileBars ?? 90)));
    const profile = buildEliteCoinProfile(candles, { profileBars });
    optsOut = applyAutoCalibrateToOpts(o, profile);
  }

  return {
    stSeries,
    adxSeries,
    volRatio,
    htf1h,
    h1Ema21,
    h1Ema50,
    h1SepSeries,
    h1Atr,
    h1Adx,
    htf4h,
    trend4h,
    atrSeries,
    atrEmaLookback,
    opts: optsOut,
    n,
  };
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
  const {
    stSeries,
    adxSeries,
    volRatio,
    htf1h,
    h1Ema21,
    h1Ema50,
    htf4h,
    trend4h,
    atrSeries,
    atrEmaLookback,
    n,
  } = ctx;
  let o = ctx.opts;
  if (String(o.htf1hSepMode ?? "FIXED").toUpperCase() === "CALIBRATED") {
    const cal = calibrateHtf1hSepFromSeries(ctx.h1SepSeries, {
      pct: o.htf1hSepCalibratePct,
      minBars: o.htf1hSepCalibrateBars,
      emaWarmup: o.htf1hEma50Period ?? 50,
    });
    o = { ...o, _htf1hCalibratedSep: cal };
    ctx.opts = o;
  }
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
          const minSep = resolveHtf1hMinSep(o, h1Idx, ctx);
          htf1hOk = aligned && sep >= minSep;
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
 * Validated 1H Elite trailing — ST line + tiered T01/T02.
 * Supertrend-auto / intraday ladder knobs (ATR buffer, post-T02 spacing) crush
 * Elite returns when left on a saved strategy snapshot.
 */
export const ELITE_ST_TRAIL_PATCH = {
  futuresTrailingStAdvanced: true,
  futuresTrailingStFeeBreakeven: true,
  futuresTrailingStopMode: "SUPERTREND",
  trailBufferMode: "PERCENT",
  trailBufferRate: 0.0005,
  trailBufferAtrMult: 0,
  trailPostT02ActivationBufferRate: 0,
  trailPostT02SpacingFrac: null,
  trailActivationSlippageFrac: 0,
  trailT01LockSlippageFrac: 0,
};

/** Trading-panel futures bracket defaults (TradingPanel.tsx / bot.js). */
export const ELITE_PANEL_DEFAULT_SL_PCT = 0.002;
export const ELITE_PANEL_DEFAULT_TP_PCT = 0.015;

function clampEliteSlPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return ELITE_PANEL_DEFAULT_SL_PCT;
  return Math.min(0.2, Math.max(0.00005, n));
}

function clampEliteTpPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return ELITE_PANEL_DEFAULT_TP_PCT;
  return Math.min(0.5, Math.max(0.00005, n));
}

/**
 * Resolve fixed SL/TP for Elite from panel toggles.
 * SL: panel default (0.2%) when bracket is enabled (default-on).
 * TP: panel default (1.5%) when trailing is on and TP bracket is enabled (default-on).
 */
export function resolveEliteBracketCfg(cfg = {}, { trailingOn = true } = {}) {
  const bracketMode = String(cfg.eliteStAutoBracketMode ?? "FIXED").toUpperCase();
  const profile = cfg._eliteCoinProfile;
  if (cfg.eliteStAutoCalibrate === true && bracketMode === "ATR" && profile) {
    const { slPct, tpPct } = resolveEliteBracketPct(profile);
    return {
      supertrendFuturesUseFixedSl: true,
      supertrendFuturesFixedSlPct: clampEliteSlPct(slPct),
      supertrendFuturesUseFixedTp: trailingOn,
      supertrendFuturesFixedTpPct: trailingOn ? clampEliteTpPct(tpPct) : 0,
    };
  }
  if (cfg.eliteStAutoCalibrate === true && bracketMode === "FIXED") {
    const useSl = cfg.supertrendFuturesUseFixedSl !== false;
    const useTp = trailingOn && cfg.supertrendFuturesUseFixedTp !== false;
    return {
      supertrendFuturesUseFixedSl: useSl,
      supertrendFuturesFixedSlPct: useSl
        ? clampEliteSlPct(cfg.supertrendFuturesFixedSlPct ?? ELITE_PANEL_DEFAULT_SL_PCT)
        : 0,
      supertrendFuturesUseFixedTp: useTp,
      supertrendFuturesFixedTpPct: useTp
        ? clampEliteTpPct(cfg.supertrendFuturesFixedTpPct ?? ELITE_PANEL_DEFAULT_TP_PCT)
        : 0,
    };
  }
  if (bracketMode === "OFF") {
    if (profile) {
      const disasterSl = resolveEliteTrailDisasterSlPct(profile, { cfg });
      return {
        supertrendFuturesUseFixedSl: true,
        supertrendFuturesFixedSlPct: clampEliteSlPct(disasterSl),
        supertrendFuturesUseFixedTp: false,
        supertrendFuturesFixedTpPct: 0,
      };
    }
    return {
      supertrendFuturesUseFixedSl: false,
      supertrendFuturesFixedSlPct: 0,
      supertrendFuturesUseFixedTp: false,
      supertrendFuturesFixedTpPct: 0,
    };
  }
  const useSl = cfg.supertrendFuturesUseFixedSl !== false;
  const useTp = trailingOn && cfg.supertrendFuturesUseFixedTp !== false;
  return {
    supertrendFuturesUseFixedSl: useSl,
    supertrendFuturesFixedSlPct: useSl
      ? clampEliteSlPct(cfg.supertrendFuturesFixedSlPct ?? ELITE_PANEL_DEFAULT_SL_PCT)
      : 0,
    supertrendFuturesUseFixedTp: useTp,
    supertrendFuturesFixedTpPct: useTp
      ? clampEliteTpPct(cfg.supertrendFuturesFixedTpPct ?? ELITE_PANEL_DEFAULT_TP_PCT)
      : 0,
  };
}

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
  // Elite MUST trail on the ST line — saved snapshots often carry trailingStopLossAuto:false
  // from intraday/ST-auto presets, which forces time_stop / liq exits instead of trail.
  out.trailingStopLossAuto = true;
  out.futuresTrailingStopMode = "SUPERTREND";
  out.supertrendFuturesExitOnFlip = true;
  Object.assign(out, ELITE_ST_TRAIL_PATCH);
  Object.assign(out, resolveEliteBracketCfg(cfg, { trailingOn: true }));
  out.intradaySmcMaxHoldBars = 0;
  out.intradayLiqMaxHoldBars = 0;
  out.intradayOfMaxHoldBars = 0;
  // Validated preset always uses both HTF gates (saved strategies often leave 1H EMA off by mistake).
  out.eliteStRequireHtf4hAlign = true;
  out.eliteStRequireHtf1hEmaAlign = true;
  if (out.eliteStHtf1hMinSep == null || Number(out.eliteStHtf1hMinSep) <= 0) {
    out.eliteStHtf1hMinSep = ELITE_ST_DEFAULTS.htf1hMinSep;
  }
  if (out.eliteStAutoCalibrate === true && out.eliteStAutoFullTune === false) {
    const sepModeRaw = String(out.eliteStHtf1hSepMode ?? "").toUpperCase();
    if (!sepModeRaw || sepModeRaw === "FIXED") {
      out.eliteStHtf1hSepMode = "ADX";
    }
  }
  // Legacy per-symbol FIXED sep overrides — only when auto-calibrate is off.
  const sepMode = String(out.eliteStHtf1hSepMode ?? "FIXED").toUpperCase();
  const skipFixedOverrides = out.eliteStAutoCalibrate === true || sepMode !== "FIXED";
  if (!skipFixedOverrides) {
    const sym = String(out.symbol ?? "").toUpperCase();
    if (sym === "BTCUSDT" && Number(out.eliteStHtf1hMinSep) <= 0.0003) {
      out.eliteStHtf1hMinSep = 0.0008;
    }
    if (sym === "BNBUSDT" && Number(out.eliteStHtf1hMinSep) >= 0.0008) {
      out.eliteStHtf1hMinSep = 0.0003;
    }
  }
  return out;
}

/** Per-symbol Elite cfg: auto-calibrate from candles then normalize. */
export function prepareEliteRunCfg(cfg = {}, symbol, candles) {
  return normalizeEliteStRunCfg(eliteCfgForSymbol(cfg, symbol, candles));
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
  supertrendFuturesExitOnFlip: true,
  supertrendFuturesFixedSlPct: ELITE_PANEL_DEFAULT_SL_PCT,
  supertrendFuturesFixedTpPct: ELITE_PANEL_DEFAULT_TP_PCT,
  supertrendFuturesUseFixedSl: true,
  supertrendFuturesUseFixedTp: true,
  ...ELITE_ST_TRAIL_PATCH,
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
    htf1hSepMode:         String(c.eliteStHtf1hSepMode ?? ELITE_ST_DEFAULTS.htf1hSepMode).toUpperCase(),
    htf1hMinSepAtrMult:   Number(c.eliteStHtf1hMinSepAtrMult ?? ELITE_ST_DEFAULTS.htf1hMinSepAtrMult),
    htf1hMinSepFloor:     Number(c.eliteStHtf1hMinSepFloor ?? ELITE_ST_DEFAULTS.htf1hMinSepFloor),
    htf1hMinSepCeil:      Number(c.eliteStHtf1hMinSepCeil ?? ELITE_ST_DEFAULTS.htf1hMinSepCeil),
    htf1hSepPercentileLookback: Number(c.eliteStHtf1hSepPercentileLookback ?? ELITE_ST_DEFAULTS.htf1hSepPercentileLookback),
    htf1hSepPercentileMult:     Number(c.eliteStHtf1hSepPercentileMult ?? ELITE_ST_DEFAULTS.htf1hSepPercentileMult),
    htf1hSepAdxBase:      Number(c.eliteStHtf1hSepAdxBase ?? ELITE_ST_DEFAULTS.htf1hSepAdxBase),
    htf1hSepAdxAlpha:     Number(c.eliteStHtf1hSepAdxAlpha ?? ELITE_ST_DEFAULTS.htf1hSepAdxAlpha),
    htf1hSepAdxRef:       Number(c.eliteStHtf1hSepAdxRef ?? ELITE_ST_DEFAULTS.htf1hSepAdxRef),
    htf1hSepCalibratePct: Number(c.eliteStHtf1hSepCalibratePct ?? ELITE_ST_DEFAULTS.htf1hSepCalibratePct),
    htf1hSepCalibrateBars: Number(c.eliteStHtf1hSepCalibrateBars ?? ELITE_ST_DEFAULTS.htf1hSepCalibrateBars),

    requireHtf4hAlign:    c.eliteStRequireHtf4hAlign    !== false,
    htf4hPeriod:          Number(c.eliteStHtf4hPeriod   ?? ELITE_ST_DEFAULTS.htf4hPeriod),
    htf4hMultiplier:      Number(c.eliteStHtf4hMultiplier ?? ELITE_ST_DEFAULTS.htf4hMultiplier),

    requireAtrExpansion:  c.eliteStRequireAtrExpansion  !== false,
    minAtrExpansion:      Number(c.eliteStMinAtrExpansion ?? ELITE_ST_DEFAULTS.minAtrExpansion),
    atrExpansionLookback: Number(c.eliteStAtrExpansionLookback ?? ELITE_ST_DEFAULTS.atrExpansionLookback),

    liqSweepEnabled:      c.eliteStLiqSweepEnabled     === true,
    liqSweepLookback:     Number(c.eliteStLiqSweepLookback ?? ELITE_ST_DEFAULTS.liqSweepLookback),
    liqSweepLookbackRange: Number(c.eliteStLiqSweepLookbackRange ?? ELITE_ST_DEFAULTS.liqSweepLookbackRange),

    autoCalibrate:        c.eliteStAutoCalibrate === true,
    profileBars:          Number(c.eliteStAutoProfileBars ?? 90),
    minAdxFloor:          Number(c.eliteStAutoMinAdxFloor ?? 15),
    minAdxCeil:           Number(c.eliteStAutoMinAdxCeil ?? 30),
  };
}

// ─── Strategy descriptor (live bot placeholder) ──────────────────────────────

export const SUPERTREND_ELITE = {
  name: "Supertrend Elite (5-gate: ADX+Vol+1H+4H+ATR)",
  signal() {
    return { action: "HOLD", reason: "use_backtest_adapter" };
  },
};
