/**
 * Funding-arb entry/exit signal logic.
 * Enter only when annualized yield clears threshold with optional stability;
 * exit on flip or yield decay.
 */
import {
  annualizeFundingRate,
  carrySideFromRate,
  resolveFundingArbCfg,
  CARRY_SIDE,
} from "./types.js";

/**
 * Average of the last `n` settlement rates (most recent last in array).
 * @param {Array<{rate:number}>} ratesChronological
 * @param {number} n
 */
export function averageLastRates(ratesChronological, n) {
  if (!Array.isArray(ratesChronological) || !ratesChronological.length) return null;
  const slice = ratesChronological.slice(-Math.max(1, n));
  let sum = 0;
  for (const r of slice) sum += Number(r.rate);
  return sum / slice.length;
}

/**
 * Count trailing consecutive intervals with the same carry side as `targetSide`.
 * @param {Array<{rate:number}>} ratesChronological
 * @param {string} targetSide
 */
export function consecutiveSameSide(ratesChronological, targetSide) {
  if (!Array.isArray(ratesChronological) || !ratesChronological.length || !targetSide) return 0;
  let count = 0;
  for (let i = ratesChronological.length - 1; i >= 0; i--) {
    const side = carrySideFromRate(ratesChronological[i].rate);
    if (side !== targetSide) break;
    count += 1;
  }
  return count;
}

/**
 * Count trailing consecutive intervals that share `targetSide` AND clear min ann yield.
 * @param {Array<{rate:number}>} ratesChronological
 * @param {string} targetSide
 * @param {number} minAnnPct
 * @param {number} intervalHours
 */
export function consecutiveAboveThreshold(ratesChronological, targetSide, minAnnPct, intervalHours = 8) {
  if (!Array.isArray(ratesChronological) || !ratesChronological.length || !targetSide) return 0;
  let count = 0;
  for (let i = ratesChronological.length - 1; i >= 0; i--) {
    const side = carrySideFromRate(ratesChronological[i].rate);
    if (side !== targetSide) break;
    const ann = Math.abs(annualizeFundingRate(ratesChronological[i].rate, intervalHours));
    if (ann + 1e-9 < Number(minAnnPct)) break;
    count += 1;
  }
  return count;
}

/**
 * @param {object} opts
 * @param {number} opts.rate — latest settlement or predicted rate
 * @param {Array<{ts:number,rate:number}>} [opts.recentRates] — chronological settlements ending at latest
 * @param {object} [opts.cfg]
 * @returns {{ enter: boolean, side: string|null, annualizedPct: number, reason: string }}
 */
export function shouldEnter({ rate, recentRates = [], cfg = {} } = {}) {
  const c = resolveFundingArbCfg(cfg);
  const annualizedPct = annualizeFundingRate(rate, c.intervalHours);
  const side = carrySideFromRate(rate);

  if (!side) {
    return { enter: false, side: null, annualizedPct, reason: "rate_near_zero" };
  }

  const absAnn = Math.abs(annualizedPct);
  if (absAnn + 1e-9 < c.minAnnualizedYieldPct) {
    return { enter: false, side, annualizedPct, reason: "below_min_annualized" };
  }

  const series = Array.isArray(recentRates) && recentRates.length
    ? recentRates
    : [{ rate: Number(rate) }];

  if (c.stabilityIntervals > 1) {
    const streak = consecutiveAboveThreshold(
      series,
      side,
      c.minAnnualizedYieldPct,
      c.intervalHours,
    );
    if (streak < c.stabilityIntervals) {
      return { enter: false, side, annualizedPct, reason: "unstable_streak" };
    }
  }

  if (c.avgLookback > 1 && series.length >= c.avgLookback) {
    const avg = averageLastRates(series, c.avgLookback);
    const avgAnn = annualizeFundingRate(avg, c.intervalHours);
    if (Math.abs(avgAnn) + 1e-9 < c.minAnnualizedYieldPct) {
      return { enter: false, side, annualizedPct, reason: "avg_below_min_annualized" };
    }
    const avgSide = carrySideFromRate(avg);
    if (avgSide !== side) {
      return { enter: false, side, annualizedPct, reason: "avg_side_mismatch" };
    }
  }

  return { enter: true, side, annualizedPct, reason: "threshold_ok" };
}

/**
 * Soft exits (yield decay) respect minHoldIntervals; hard flips always exit.
 *
 * @param {object} opts
 * @param {number} opts.rate
 * @param {string} opts.positionSide — CARRY_SIDE of open position
 * @param {number} [opts.holdIntervals=0] — settlements held so far
 * @param {object} [opts.cfg]
 * @returns {{ exit: boolean, annualizedPct: number, reason: string, hard: boolean }}
 */
export function shouldExit({ rate, positionSide, holdIntervals = 0, cfg = {} } = {}) {
  const c = resolveFundingArbCfg(cfg);
  const annualizedPct = annualizeFundingRate(rate, c.intervalHours);
  const rateSide = carrySideFromRate(rate);
  const held = Math.max(0, Number(holdIntervals) || 0);
  const minHold = c.minHoldIntervals;

  if (c.exitOnFlip) {
    if (positionSide === CARRY_SIDE.LONG_SPOT_SHORT_PERP && Number(rate) <= 0) {
      return { exit: true, annualizedPct, reason: "funding_flip_negative", hard: true };
    }
    if (positionSide === CARRY_SIDE.SHORT_SPOT_LONG_PERP && Number(rate) >= 0) {
      return { exit: true, annualizedPct, reason: "funding_flip_positive", hard: true };
    }
    if (rateSide && rateSide !== positionSide) {
      return { exit: true, annualizedPct, reason: "carry_side_flip", hard: true };
    }
  }

  const absAnn = Math.abs(annualizedPct);
  if (absAnn + 1e-9 < c.exitAnnualizedYieldPct) {
    if (minHold > 0 && held < minHold) {
      return { exit: false, annualizedPct, reason: "min_hold_active", hard: false };
    }
    return { exit: true, annualizedPct, reason: "yield_decay", hard: false };
  }

  return { exit: false, annualizedPct, reason: "hold", hard: false };
}
