/**
 * Day-level phase-locked routing — morning range/squeeze playbooks, afternoon
 * breakdown/breakout playbooks. Never scan competing situations on the same day.
 */

import { dayStartIndex } from "../techniques/liquidity.js";
import { isBreakdownBear, isBreakoutBull, isRangeAbovePdl, isRangeBelowPdh } from "./situationEngine.js";
import { SITUATIONS } from "./situationConstants.js";

const PRIORITY = [
  SITUATIONS.VOLATILE_AVOID,
  SITUATIONS.BREAKDOWN_BEAR,
  SITUATIONS.BREAKOUT_BULL,
  SITUATIONS.SQUEEZE,
  SITUATIONS.RANGE_ABOVE_PDL,
  SITUATIONS.RANGE_BELOW_PDH,
  SITUATIONS.CHOP_NEUTRAL,
];

export class DaySituationTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.dayId = null;
    this.sawRangeAbovePdl = false;
    this.sawRangeBelowPdh = false;
    this.sawSqueeze = false;
    this.breakdownBarIdx = -1;
    this.breakoutBarIdx = -1;
  }

  ensureDay(dayId) {
    if (dayId !== this.dayId) {
      this.reset();
      this.dayId = dayId;
    }
  }

  update(barSituation, idx, candles, pre, opts = {}) {
    const minBars = opts.minBarsBeyondLevel ?? 4;
    if (barSituation === SITUATIONS.RANGE_ABOVE_PDL) this.sawRangeAbovePdl = true;
    if (barSituation === SITUATIONS.RANGE_BELOW_PDH) this.sawRangeBelowPdh = true;
    if (barSituation === SITUATIONS.SQUEEZE) this.sawSqueeze = true;
    if (this.breakdownBarIdx < 0 && isBreakdownBear(candles, idx, pre, minBars)) {
      this.breakdownBarIdx = idx;
    }
    if (this.breakoutBarIdx < 0 && isBreakoutBull(candles, idx, pre, minBars)) {
      this.breakoutBarIdx = idx;
    }
  }

  breakdownLocked(candles, idx, pre, opts = {}) {
    const minBars = opts.minBarsBeyondLevel ?? 4;
    return this.breakdownBarIdx >= 0 || isBreakdownBear(candles, idx, pre, minBars);
  }

  breakoutLocked(candles, idx, pre, opts = {}) {
    const minBars = opts.minBarsBeyondLevel ?? 4;
    return this.breakoutBarIdx >= 0 || isBreakoutBull(candles, idx, pre, minBars);
  }
}

/**
 * @param {import("./situationState.js").SituationDayState} [dayState]
 * @returns {string[]} situation labels to scan this bar (phase-locked, deduped)
 */
export function resolveActiveSituations(
  candles,
  idx,
  pre,
  barSituation,
  tracker,
  routeTable,
  opts = {},
  dayState = null,
) {
  const routes = routeTable?.routes || {};
  const active = new Set();
  const add = (sit) => {
    if (routes[sit]?.length) active.add(sit);
  };

  if (opts.phaseLock === false) {
    add(barSituation);
    return PRIORITY.filter((s) => active.has(s));
  }

  if (barSituation === SITUATIONS.VOLATILE_AVOID) {
    add(SITUATIONS.VOLATILE_AVOID);
    return PRIORITY.filter((s) => active.has(s));
  }

  const breakdownPhase = tracker.breakdownLocked(candles, idx, pre, opts);
  const breakoutPhase = tracker.breakoutLocked(candles, idx, pre, opts);

  if (breakdownPhase) {
    add(SITUATIONS.BREAKDOWN_BEAR);
    return PRIORITY.filter((s) => active.has(s));
  }

  if (breakoutPhase) {
    add(SITUATIONS.BREAKOUT_BULL);
    return PRIORITY.filter((s) => active.has(s));
  }

  // Pre-structure phase: range / squeeze setups only.
  if (isRangeAbovePdl(candles, idx, pre) || tracker.sawRangeAbovePdl) {
    add(SITUATIONS.RANGE_ABOVE_PDL);
  }
  if (isRangeBelowPdh(candles, idx, pre) || tracker.sawRangeBelowPdh) {
    add(SITUATIONS.RANGE_BELOW_PDH);
  }
  if (barSituation === SITUATIONS.SQUEEZE || tracker.sawSqueeze) {
    add(SITUATIONS.SQUEEZE);
  }
  if (active.size === 0) add(barSituation);

  return PRIORITY.filter((s) => active.has(s));
}

export function dayExtreme(candles, idx, dayStart, pick) {
  let v = pick === "low" ? Infinity : -Infinity;
  for (let j = dayStart; j <= idx; j++) {
    v = pick === "low" ? Math.min(v, candles[j].low) : Math.max(v, candles[j].high);
  }
  return Number.isFinite(v) ? v : 0;
}

export { dayStartIndex };
