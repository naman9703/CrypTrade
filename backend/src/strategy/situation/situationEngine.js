/**
 * Per-bar situation classifier — combines regimeEngine, day structure, and HTF alignment.
 */

import { buildRegimeSeries, REGIMES } from "../regimeEngine.js";
import { dayStartIndex, utcDayId } from "../techniques/liquidity.js";
import { SITUATIONS } from "./situationConstants.js";

function barsBelowLevel(candles, idx, dayStart, level) {
  let n = 0;
  for (let j = dayStart; j <= idx; j++) {
    if (candles[j].close < level) n++;
  }
  return n;
}

function barsAboveLevel(candles, idx, dayStart, level) {
  let n = 0;
  for (let j = dayStart; j <= idx; j++) {
    if (candles[j].close > level) n++;
  }
  return n;
}

function dayExtreme(candles, idx, dayStart, pick) {
  let v = pick === "low" ? Infinity : -Infinity;
  for (let j = dayStart; j <= idx; j++) {
    v = pick === "low" ? Math.min(v, candles[j].low) : Math.max(v, candles[j].high);
  }
  return Number.isFinite(v) ? v : 0;
}

export function isBreakdownBear(candles, idx, pre, minBars = 4) {
  const pdl = pre.prevDayLow?.[idx];
  if (!(pdl > 0)) return false;
  const dayStart = dayStartIndex(candles, idx);
  const below = barsBelowLevel(candles, idx, dayStart, pdl) >= minBars;
  const htfBear = pre.htfDown?.[idx] === true;
  return below && htfBear;
}

export function isBreakoutBull(candles, idx, pre, minBars = 4) {
  const pdh = pre.prevDayHigh?.[idx];
  if (!(pdh > 0)) return false;
  const dayStart = dayStartIndex(candles, idx);
  const above = barsAboveLevel(candles, idx, dayStart, pdh) >= minBars;
  const htfBull = pre.htfUp?.[idx] === true;
  return above && htfBull;
}

export function isRangeAbovePdl(candles, idx, pre) {
  const pdl = pre.prevDayLow?.[idx];
  if (!(pdl > 0)) return false;
  if (isBreakdownBear(candles, idx, pre)) return false;
  const dayStart = dayStartIndex(candles, idx);
  const dayLow = dayExtreme(candles, idx, dayStart, "low");
  return dayLow >= pdl * 0.998;
}

export function isRangeBelowPdh(candles, idx, pre) {
  const pdh = pre.prevDayHigh?.[idx];
  if (!(pdh > 0)) return false;
  if (isBreakoutBull(candles, idx, pre)) return false;
  const dayStart = dayStartIndex(candles, idx);
  const dayHigh = dayExtreme(candles, idx, dayStart, "high");
  return dayHigh <= pdh * 1.002;
}

/**
 * @param {object[]} candles
 * @param {number} idx
 * @param {object} pre from precomputeIntraday
 * @param {object} [opts]
 * @param {object} [opts.regimeInfo] prebuilt regime series entry
 */
export function classifySituation(candles, idx, pre, opts = {}) {
  if (!candles?.length || idx < 50) {
    return { situation: SITUATIONS.CHOP_NEUTRAL, confidence: 0 };
  }

  const regimeInfo =
    opts.regimeInfo ||
    (opts.regimeSeries ? opts.regimeSeries[idx] : null) ||
    buildRegimeSeries(candles, opts.regimeOpts || {})[idx];
  const regime = regimeInfo?.regime || REGIMES.RANGE;
  const adx = pre.adxSeries?.[idx];

  if (regime === REGIMES.VOLATILE_AVOID) {
    return { situation: SITUATIONS.VOLATILE_AVOID, confidence: regimeInfo?.confidence ?? 0.8, regime };
  }

  if (isBreakdownBear(candles, idx, pre, opts.minBarsBeyondLevel ?? 4)) {
    return { situation: SITUATIONS.BREAKDOWN_BEAR, confidence: 0.85, regime };
  }
  if (isBreakoutBull(candles, idx, pre, opts.minBarsBeyondLevel ?? 4)) {
    return { situation: SITUATIONS.BREAKOUT_BULL, confidence: 0.85, regime };
  }
  if (regime === REGIMES.SQUEEZE) {
    return { situation: SITUATIONS.SQUEEZE, confidence: regimeInfo?.confidence ?? 0.6, regime };
  }
  if (isRangeAbovePdl(candles, idx, pre)) {
    return { situation: SITUATIONS.RANGE_ABOVE_PDL, confidence: 0.7, regime };
  }
  if (isRangeBelowPdh(candles, idx, pre)) {
    return { situation: SITUATIONS.RANGE_BELOW_PDH, confidence: 0.7, regime };
  }
  if (!Number.isFinite(adx) || adx < (opts.chopAdxMax ?? 18)) {
    return { situation: SITUATIONS.CHOP_NEUTRAL, confidence: 0.5, regime };
  }

  return { situation: SITUATIONS.CHOP_NEUTRAL, confidence: 0.3, regime };
}

export function buildSituationSeries(candles, pre, opts = {}) {
  const regimeSeries = opts.regimeSeries || buildRegimeSeries(candles, opts.regimeOpts || {});
  const n = candles.length;
  const series = new Array(n);
  for (let i = 0; i < n; i++) {
    series[i] = classifySituation(candles, i, pre, {
      ...opts,
      regimeInfo: regimeSeries[i],
      regimeSeries,
    });
  }
  return { series, regimeSeries };
}

export function utcDayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

export { utcDayId };
