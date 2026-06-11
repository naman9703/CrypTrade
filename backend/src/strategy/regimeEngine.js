/**
 * Unified regime engine.
 *
 * Today's regime logic is fragmented across regime.js (ADX/ATR hysteresis),
 * marketDecisionEngine.js, isTradeableRegime() and the SMC HTF bias. This module
 * consolidates them into ONE labelled state per bar so the regime-adaptive
 * strategy can route exactly one playbook per bar instead of AND-ing techniques.
 *
 * Output enum (per bar):
 *   TREND_UP | TREND_DOWN | RANGE | SQUEEZE | VOLATILE_AVOID
 * each with a 0..1 confidence. Hysteresis (entry/exit bands) + a min-dwell guard
 * prevents whipsaw flips at regime transitions.
 *
 * Inputs reuse what precomputeIntraday already has (ADX, ATR%, EMA, HTF bias) but
 * the module is self-contained: pass candles (+ optional OI series) and it builds
 * its own lightweight indicators so it works in both live and backtest paths.
 */

import { ema, atr as atrFn, adx as adxFn } from "./indicators.js";

export const REGIMES = Object.freeze({
  TREND_UP: "TREND_UP",
  TREND_DOWN: "TREND_DOWN",
  RANGE: "RANGE",
  SQUEEZE: "SQUEEZE",
  VOLATILE_AVOID: "VOLATILE_AVOID",
});

/** Default thresholds — tuned for 15m crypto majors; all overridable via cfg. */
export const DEFAULT_REGIME_OPTS = Object.freeze({
  // Trend strength (ADX) with hysteresis.
  trendAdxEntry: 25,
  trendAdxExit: 20,
  // Range when ADX below this and not squeezing.
  rangeAdxMax: 20,
  // EMA trend filter periods.
  emaFast: 50,
  emaSlow: 200,
  emaSepMin: 0.0006, // min |emaFast-emaSlow|/price to call a directional trend
  // Volatility-avoid: ATR% spike (fraction of price per bar) with hysteresis.
  volatileAtrPctEntry: 0.012,
  volatileAtrPctExit: 0.008,
  // Squeeze: Bollinger band-width percentile over a trailing lookback.
  bbPeriod: 20,
  bbMult: 2,
  squeezeLookback: 192, // ~2 days of 15m bars
  squeezePctile: 0.2, // bottom 20% of band-width => compression
  // Liquidation-cascade proxy: volume z-score spike + OI falling fast.
  volSpikeZ: 3.0,
  volLookback: 96,
  oiDropPct: 0.02, // OI down >=2% over the cascade window => deleveraging
  // Hysteresis dwell — min bars before switching away from a confirmed regime.
  minDwellBars: 3,
  // Warmup before any classification.
  warmup: 210,
});

function stdev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(v);
}

/** Bollinger band-width series = (upper-lower)/mid. */
function bandWidthSeries(closes, period, mult) {
  const out = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const mean = sum / period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (closes[j] - mean) ** 2;
    const sd = Math.sqrt(v / period);
    out[i] = mean > 0 ? (2 * mult * sd) / mean : 0;
  }
  return out;
}

/** Percentile rank (0..1) of value within the trailing window ending at i. */
function pctileRank(series, i, lookback) {
  const v = series[i];
  if (v == null) return null;
  const start = Math.max(0, i - lookback + 1);
  let count = 0;
  let total = 0;
  for (let j = start; j <= i; j++) {
    if (series[j] == null) continue;
    total++;
    if (series[j] <= v) count++;
  }
  return total > 0 ? count / total : null;
}

/**
 * Build the per-bar regime series.
 * @param {Array<{ts:number,open:number,high:number,low:number,close:number,volume:number}>} candles
 * @param {object} [opts] threshold overrides (see DEFAULT_REGIME_OPTS)
 * @param {Array<{ts:number,oiUsdt:number}>} [opts.oi] optional OI series for cascade proxy
 * @returns {Array<{regime:string, confidence:number, adx:number, atrPct:number,
 *   bbPctile:number|null, trendDir:number}>}
 */
export function buildRegimeSeries(candles, opts = {}) {
  const o = { ...DEFAULT_REGIME_OPTS, ...opts };
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const vols = candles.map((c) => Number(c.volume) || 0);
  const adxSeries = adxFn(candles, 14);
  const atrSeries = atrFn(candles, 14);
  const emaFast = ema(closes, o.emaFast);
  const emaSlow = ema(closes, o.emaSlow);
  const bbWidth = bandWidthSeries(closes, o.bbPeriod, o.bbMult);

  // OI lookup by nearest-prior timestamp (OI is sparse, e.g. hourly).
  const oi = Array.isArray(o.oi) ? o.oi : [];
  function oiDropAt(i) {
    if (oi.length < 2) return 0;
    const tNow = candles[i].ts;
    const windowMs = (o.volLookback * (n > 1 ? candles[1].ts - candles[0].ts : 900_000));
    let now = null;
    let past = null;
    for (const p of oi) {
      if (p.ts <= tNow) now = p;
      if (p.ts <= tNow - windowMs) past = p;
      if (p.ts > tNow) break;
    }
    if (!now || !past || !(past.oiUsdt > 0)) return 0;
    return (past.oiUsdt - now.oiUsdt) / past.oiUsdt; // positive => OI fell
  }

  const out = new Array(n);
  let last = REGIMES.RANGE;
  let dwell = 0;

  for (let i = 0; i < n; i++) {
    const adx = adxSeries[i] ?? 0;
    const atrv = atrSeries[i];
    const px = closes[i];
    const atrPct = atrv != null && px > 0 ? atrv / px : 0;
    const ef = emaFast[i];
    const es = emaSlow[i];
    const sep = ef != null && es != null && es !== 0 ? Math.abs(ef - es) / Math.abs(es) : 0;
    const trendDir = ef != null && es != null ? (ef > es ? 1 : ef < es ? -1 : 0) : 0;
    const bbPctile = pctileRank(bbWidth, i, o.squeezeLookback);

    if (i < o.warmup) {
      out[i] = { regime: REGIMES.RANGE, confidence: 0, adx, atrPct, bbPctile, trendDir };
      last = REGIMES.RANGE;
      dwell = 0;
      continue;
    }

    // Volume spike z-score (for cascade proxy).
    const vStart = Math.max(0, i - o.volLookback + 1);
    const vWin = vols.slice(vStart, i + 1);
    const vMean = vWin.reduce((a, b) => a + b, 0) / Math.max(1, vWin.length);
    const vSd = stdev(vWin);
    const volZ = vSd > 0 ? (vols[i] - vMean) / vSd : 0;
    const oiDrop = oiDropAt(i);

    // ── Classify (priority order) ──────────────────────────────────────────
    const wasVolatile = last === REGIMES.VOLATILE_AVOID;
    const volThresh = wasVolatile ? o.volatileAtrPctExit : o.volatileAtrPctEntry;
    const cascade = volZ >= o.volSpikeZ && (oi.length >= 2 ? oiDrop >= o.oiDropPct : false);

    let regime;
    let confidence;
    if (atrPct >= volThresh || cascade) {
      regime = REGIMES.VOLATILE_AVOID;
      confidence = Math.min(1, Math.max(atrPct / (o.volatileAtrPctEntry * 1.5), cascade ? 0.9 : 0));
    } else {
      const wasTrending = last === REGIMES.TREND_UP || last === REGIMES.TREND_DOWN;
      const adxTrend = wasTrending ? o.trendAdxExit : o.trendAdxEntry;
      const isSqueeze = bbPctile != null && bbPctile <= o.squeezePctile && adx < o.trendAdxEntry;

      if (adx >= adxTrend && sep >= o.emaSepMin && trendDir !== 0) {
        regime = trendDir > 0 ? REGIMES.TREND_UP : REGIMES.TREND_DOWN;
        confidence = Math.min(1, (adx - o.trendAdxExit) / 25 + sep * 50);
      } else if (isSqueeze) {
        regime = REGIMES.SQUEEZE;
        confidence = Math.min(1, (o.squeezePctile - bbPctile) / o.squeezePctile + 0.3);
      } else if (adx < o.rangeAdxMax) {
        regime = REGIMES.RANGE;
        confidence = Math.min(1, (o.rangeAdxMax - adx) / o.rangeAdxMax + 0.2);
      } else {
        // Ambiguous (transition zone) — keep prior regime at low confidence.
        regime = last;
        confidence = 0.25;
      }
    }

    // ── Hysteresis dwell — resist flips before minDwellBars unless volatile ──
    if (regime !== last) {
      if (dwell < o.minDwellBars && last !== REGIMES.RANGE && regime !== REGIMES.VOLATILE_AVOID) {
        regime = last;
        dwell++;
      } else {
        last = regime;
        dwell = 0;
      }
    } else {
      dwell++;
    }

    out[i] = { regime, confidence: Number(confidence.toFixed(3)), adx, atrPct, bbPctile, trendDir };
  }
  return out;
}

/**
 * Classify a single bar index using a prebuilt series (or build one ad-hoc).
 * Convenience for live use where the caller holds the candle slice.
 */
export function classifyRegimeAt(candles, idx, opts = {}) {
  const series = opts._series || buildRegimeSeries(candles, opts);
  return series[idx] || { regime: REGIMES.RANGE, confidence: 0 };
}

/** Map a regime to the playbook the adaptive strategy should run. */
export function playbookForRegime(regime) {
  switch (regime) {
    case REGIMES.TREND_UP:
    case REGIMES.TREND_DOWN:
      return "trend";
    case REGIMES.RANGE:
      return "mean_reversion";
    case REGIMES.SQUEEZE:
      return "breakout";
    case REGIMES.VOLATILE_AVOID:
    default:
      return "stand_down";
  }
}
