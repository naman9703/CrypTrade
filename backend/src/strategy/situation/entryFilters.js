/**
 * Per-situation / per-trigger entry filters — gate setups by market condition quality.
 */

import { SITUATIONS } from "./situationConstants.js";

/**
 * @returns {boolean} true if setup may proceed
 */
export function passesEntryFilters(candles, idx, pre, dayState, setup, situation, opts = {}) {
  const trigger = setup.trigger;
  const dayRange = dayState.dayRangePct();
  const adx = pre.adxSeries?.[idx];
  const maxDayRange = opts.situationMaxDayRangeAtEntry ?? opts.maxExhaustionDayRangePct ?? 0.04;
  const maxAdx = opts.situationMaxAdx ?? 70;
  const minAdx = opts.situationMinAdx ?? 0;

  if (Number.isFinite(adx)) {
    if (adx > maxAdx) return false;
    if (minAdx > 0 && adx < minAdx) return false;
  }

  if (trigger === "exhaustion_long") {
    if (dayRange > maxDayRange) return false;
    if (!pre.htfDown?.[idx]) return false;
  }

  if (trigger === "exhaustion_short") {
    if (dayRange > maxDayRange) return false;
    if (!pre.htfUp?.[idx]) return false;
  }

  if (situation === SITUATIONS.RANGE_ABOVE_PDL && trigger === "lh_fade_short") {
    if (dayRange > (opts.maxDispDayRangePct ?? 0.03)) return false;
  }

  if (situation === SITUATIONS.RANGE_BELOW_PDH && trigger === "retest_short") {
    if (!dayState.bearBias) return false;
    if (dayRange > maxDayRange) return false;
  }

  if (situation === SITUATIONS.SQUEEZE && trigger === "lh_fade_long") {
    if (!dayState.bullBias && !pre.htfUp?.[idx]) return false;
  }

  return true;
}
