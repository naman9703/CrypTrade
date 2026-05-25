/**
 * Supertrend Confirmation Gate.
 *
 * A standalone indicator-grade veto that runs ALONGSIDE the macro intelligence gate
 * on every Supertrend entry signal. Where the intel gate filters macro/HTF context,
 * this gate filters **the signal bar itself** for entry quality — the dimension that
 * separates wins from losses in our trade audit:
 *
 *   - Winners exit fast (~2-3 bars) with deep MFE → entered on decisive bars with momentum.
 *   - Losers drag (~8 bars) with deep MAE before stopping → entered on weak/chop bars.
 *
 * The gate evaluates the signal bar (bar i, where ST flipped) against:
 *   1. Bar body strength vs ATR (decisive close in trend direction).
 *   2. Adverse wick rejection — long entries with big upper wick / short with big lower wick fail.
 *   3. Recent volume vs 20-bar MA (real participation).
 *   4. ADX-14 trend strength.
 *   5. HTF (1h aggregated) Supertrend direction alignment.
 *   6. Distance from ST line (avoid late chase entries).
 *
 * All thresholds are config-driven so the gate can be tuned without code changes.
 * The runner short-circuits the entry when this returns `{ pass: false }`.
 */

import { adx as computeAdx, atr as computeAtr } from "./indicators.js";

const DEFAULTS = {
  minAdx: 22,
  minVolRatio: 1.1,
  minBodyAtrRatio: 0.35,
  maxAdverseWickFrac: 0.5,
  maxDistFromStAtr: 2.5,
  requireHtfAlign: true,
  htfPeriod: 10,
  htfMultiplier: 3,
  htfBarsPerStrategyBar: 4,
};

/**
 * Aggregate strategy-TF bars into coarser HTF bars (e.g. 4× 15m = 1× 1h).
 */
function aggregateBars(candles, n) {
  if (!Array.isArray(candles) || n < 2) return candles ?? [];
  const out = [];
  for (let i = 0; i + n - 1 < candles.length; i += n) {
    const slice = candles.slice(i, i + n);
    out.push({
      ts: slice[0].ts,
      open: slice[0].open,
      high: Math.max(...slice.map((s) => s.high)),
      low: Math.min(...slice.map((s) => s.low)),
      close: slice[slice.length - 1].close,
      volume: slice.reduce((s, b) => s + (Number(b.volume) || 0), 0),
    });
  }
  return out;
}

/**
 * Compute Supertrend trend (+1 / -1) for a candle stream — minimal version used for HTF alignment.
 */
function computeSupertrendTrendSeries(candles, period, multiplier) {
  if (!Array.isArray(candles) || candles.length < period + 2) return [];
  const tr = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const pc = candles[i - 1].close;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  }
  const atrs = new Array(candles.length).fill(null);
  let atrPrev = null;
  for (let i = 0; i < candles.length; i++) {
    if (i < period) continue;
    if (atrPrev == null) {
      atrPrev = tr.slice(1, period + 1).reduce((s, v) => s + v, 0) / period;
    } else {
      atrPrev = (atrPrev * (period - 1) + tr[i]) / period;
    }
    atrs[i] = atrPrev;
  }
  const trend = new Array(candles.length).fill(0);
  let upper = 0;
  let lower = 0;
  let dir = 1;
  for (let i = 1; i < candles.length; i++) {
    const a = atrs[i - 1];
    if (a == null) {
      trend[i] = 0;
      continue;
    }
    const mid = (candles[i].high + candles[i].low) / 2;
    const ub = mid + multiplier * a;
    const lb = mid - multiplier * a;
    if (i === 1) {
      upper = ub;
      lower = lb;
      dir = candles[i].close > mid ? 1 : -1;
    } else {
      upper = candles[i - 1].close > upper ? Math.max(ub, upper) : ub;
      lower = candles[i - 1].close < lower ? Math.min(lb, lower) : lb;
      if (dir === 1 && candles[i].close < lower) dir = -1;
      else if (dir === -1 && candles[i].close > upper) dir = 1;
    }
    trend[i] = dir;
  }
  return trend;
}

/**
 * Build a cacheable context for the gate (run once per backtest).
 * @param {Array<{ts:number,open:number,high:number,low:number,close:number,volume:number}>} candles
 * @param {Partial<typeof DEFAULTS>} opts
 */
export function buildSupertrendConfirmationContext(candles, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const atrSeries = computeAtr(candles, 14);
  const adxSeries = computeAdx(candles, 14);
  const vol = candles.map((c) => Number(c.volume) || 0);
  const volMa20 = new Array(vol.length).fill(0);
  for (let i = 0; i < vol.length; i++) {
    const s = Math.max(0, i - 19);
    const slice = vol.slice(s, i + 1);
    volMa20[i] = slice.reduce((a, b) => a + b, 0) / slice.length;
  }
  const htfCandles = aggregateBars(candles, o.htfBarsPerStrategyBar);
  const htfTrend = computeSupertrendTrendSeries(htfCandles, o.htfPeriod, o.htfMultiplier);
  return {
    atrSeries,
    adxSeries,
    volMa20,
    htfTrend,
    htfBarsPerStrategyBar: o.htfBarsPerStrategyBar,
    opts: o,
  };
}

/**
 * Evaluate the gate at strategy bar `idx` for a `side` ("BUY" or "SELL").
 *
 * @param {ReturnType<buildSupertrendConfirmationContext>} ctx
 * @param {{ ts:number, open:number, high:number, low:number, close:number, volume:number }} bar
 * @param {number} idx
 * @param {"BUY"|"SELL"} side
 * @param {{ stLine?: number }} [stBar]  current Supertrend bar (for distance-from-line check)
 * @returns {{ pass:boolean, reason?:string, score:number }}
 */
export function evaluateSupertrendConfirmationGate(ctx, bar, idx, side, stBar) {
  if (!ctx || !bar || idx < 22) return { pass: true, score: 0.5, reason: "warmup" };
  const o = ctx.opts;
  const isLong = side === "BUY";

  const atr = Number(ctx.atrSeries[idx]);
  const adxVal = Number(ctx.adxSeries[idx]);
  const volRatio = ctx.volMa20[idx] > 0 ? Number(bar.volume) / ctx.volMa20[idx] : 0;

  const body = Math.abs(bar.close - bar.open);
  const bodyAtr = atr > 0 ? body / atr : 0;
  const upperWick = bar.high - Math.max(bar.open, bar.close);
  const lowerWick = Math.min(bar.open, bar.close) - bar.low;
  const adverseWick = isLong ? upperWick : lowerWick;
  const adverseWickFrac = body > 0 ? adverseWick / body : 0;
  const closedInDir = isLong ? bar.close > bar.open : bar.close < bar.open;

  if (Number.isFinite(adxVal) && adxVal < o.minAdx) {
    return { pass: false, reason: "adx_chop", score: 0.0 };
  }
  if (volRatio > 0 && volRatio < o.minVolRatio) {
    return { pass: false, reason: "low_volume", score: 0.1 };
  }
  if (!closedInDir) {
    return { pass: false, reason: "bar_not_in_direction", score: 0.0 };
  }
  if (bodyAtr < o.minBodyAtrRatio) {
    return { pass: false, reason: "weak_body", score: 0.15 };
  }
  if (adverseWickFrac > o.maxAdverseWickFrac) {
    return { pass: false, reason: "adverse_wick", score: 0.1 };
  }

  if (o.requireHtfAlign) {
    const hi = Math.floor(idx / ctx.htfBarsPerStrategyBar);
    const ht = ctx.htfTrend[hi];
    if (!ht) return { pass: false, reason: "htf_warmup", score: 0.3 };
    if (isLong && ht !== 1) return { pass: false, reason: "htf_disagree_long", score: 0.0 };
    if (!isLong && ht !== -1) return { pass: false, reason: "htf_disagree_short", score: 0.0 };
  }

  if (stBar && Number.isFinite(stBar.line) && atr > 0) {
    const dist = Math.abs(bar.close - stBar.line) / atr;
    if (dist > o.maxDistFromStAtr) {
      return { pass: false, reason: "late_entry_far_from_st", score: 0.2 };
    }
  }

  /** Composite "entry quality" score normalised 0-1 for downstream sizing if needed. */
  const adxScore = Math.min(1, Math.max(0, (adxVal - o.minAdx) / 30));
  const volScore = Math.min(1, (volRatio - o.minVolRatio) / 2);
  const bodyScore = Math.min(1, (bodyAtr - o.minBodyAtrRatio) / 1.0);
  const wickScore = Math.max(0, 1 - adverseWickFrac / Math.max(0.0001, o.maxAdverseWickFrac));
  const score = (adxScore + volScore + bodyScore + wickScore) / 4;
  return { pass: true, score, reason: "pass" };
}

/**
 * Read gate cfg with safe defaults from cfg_raw / instance cfg.
 */
export function readConfirmationGateCfg(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  if (c.supertrendConfirmationGateEnabled !== true) return null;
  return {
    minAdx: Number(c.supertrendConfirmationMinAdx ?? DEFAULTS.minAdx),
    minVolRatio: Number(c.supertrendConfirmationMinVolRatio ?? DEFAULTS.minVolRatio),
    minBodyAtrRatio: Number(c.supertrendConfirmationMinBodyAtrRatio ?? DEFAULTS.minBodyAtrRatio),
    maxAdverseWickFrac: Number(c.supertrendConfirmationMaxAdverseWickFrac ?? DEFAULTS.maxAdverseWickFrac),
    maxDistFromStAtr: Number(c.supertrendConfirmationMaxDistFromStAtr ?? DEFAULTS.maxDistFromStAtr),
    requireHtfAlign: c.supertrendConfirmationRequireHtfAlign !== false,
    htfPeriod: Number(c.supertrendConfirmationHtfPeriod ?? DEFAULTS.htfPeriod),
    htfMultiplier: Number(c.supertrendConfirmationHtfMultiplier ?? DEFAULTS.htfMultiplier),
    htfBarsPerStrategyBar: Number(c.supertrendConfirmationHtfBarsPerStrategyBar ?? DEFAULTS.htfBarsPerStrategyBar),
  };
}

export const SUPERTREND_CONFIRMATION_DEFAULTS = { ...DEFAULTS };
