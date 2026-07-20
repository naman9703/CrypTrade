/**
 * Funding-arb risk checks (Phase 3 stub — usable in Phase 2 sim + monitor).
 */
import { CARRY_SIDE } from "./types.js";
import { shouldExit } from "./signal.js";

/**
 * @param {object} accountState
 * @param {number} accountState.usedMargin
 * @param {number} accountState.totalMargin
 * @param {number} [maxMarginRatio=0.5]
 * @returns {'OK'|'REDUCE_POSITION'}
 */
export function checkMarginHealth(accountState = {}, maxMarginRatio = 0.5) {
  const used = Number(accountState.usedMargin ?? 0);
  const total = Number(accountState.totalMargin ?? 0);
  if (!(total > 0)) return "OK";
  const ratio = used / total;
  if (ratio > Number(maxMarginRatio)) return "REDUCE_POSITION";
  return "OK";
}

/**
 * Capital locked for a carry: spot notional + perp initial margin.
 * @param {number} notionalUsdt
 * @param {number} perpLeverage
 */
export function capitalDeployed(notionalUsdt, perpLeverage) {
  const n = Math.max(0, Number(notionalUsdt) || 0);
  const lev = Math.max(1, Number(perpLeverage) || 1);
  return n + n / lev;
}

/**
 * Max notional as fraction of equity.
 * @param {number} equity
 * @param {number} [maxPositionPct=0.2]
 */
export function maxNotionalForEquity(equity, maxPositionPct = 0.2) {
  const e = Number(equity);
  const p = Math.max(0, Math.min(1, Number(maxPositionPct)));
  if (!(e > 0)) return 0;
  return e * p;
}

/**
 * @param {object} fundingData
 * @param {number} fundingData.rate
 * @param {string} positionSide — CARRY_SIDE
 * @param {object} [cfg]
 * @returns {'HOLD'|'EXIT_SIGNAL'}
 */
export function checkFundingFlip(fundingData, positionSide, cfg = {}) {
  const r = shouldExit({
    rate: fundingData?.rate,
    positionSide,
    cfg: { ...cfg, exitOnFlip: true, exitAnnualizedYieldPct: 0 },
  });
  if (r.exit && (r.reason === "funding_flip_negative" || r.reason === "funding_flip_positive" || r.reason === "carry_side_flip")) {
    return "EXIT_SIGNAL";
  }
  // Also exit on yield decay when configured
  const full = shouldExit({ rate: fundingData?.rate, positionSide, cfg });
  return full.exit ? "EXIT_SIGNAL" : "HOLD";
}

/**
 * Kill-switch predicate for abnormal conditions.
 * @param {{ apiError?: boolean, extremeVolatility?: boolean, fundingAnomaly?: boolean, legMismatch?: boolean }} flags
 */
export function killSwitchTriggered(flags = {}) {
  return Boolean(
    flags.apiError || flags.extremeVolatility || flags.fundingAnomaly || flags.legMismatch,
  );
}

export { CARRY_SIDE };
