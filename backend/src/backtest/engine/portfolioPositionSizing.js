/**
 * Portfolio backtest capital / position-sizing modes.
 *
 * - EQUAL_SLICE_FULL_MARGIN (default): each coin sims on equity/N; each trade uses
 *   100% of that coin's slice as margin.
 * - EQUAL_SLICE_RISK_AT_SL: each coin sims on equity/N; size with RISK_AT_SL vs the slice.
 * - TOTAL_CAPITAL_RISK_AT_SL: each coin sims on full equity with RISK_AT_SL; shared
 *   account replay skips later overlapping entries (first by entry time wins).
 */

export const PORTFOLIO_POSITION_SIZING_MODES = Object.freeze([
  "EQUAL_SLICE_FULL_MARGIN",
  "EQUAL_SLICE_RISK_AT_SL",
  "TOTAL_CAPITAL_RISK_AT_SL",
]);

const MODE_SET = new Set(PORTFOLIO_POSITION_SIZING_MODES);

/**
 * @param {Record<string, unknown>} [cfg]
 * @returns {"EQUAL_SLICE_FULL_MARGIN"|"EQUAL_SLICE_RISK_AT_SL"|"TOTAL_CAPITAL_RISK_AT_SL"}
 */
export function resolvePortfolioPositionSizing(cfg = {}) {
  const raw = String(cfg?.portfolioPositionSizing ?? "").toUpperCase();
  if (MODE_SET.has(raw)) return /** @type {any} */ (raw);
  // Legacy: portfolio always forced full-slice margin.
  return "EQUAL_SLICE_FULL_MARGIN";
}

/**
 * Unit-sim starting capital for one coin under the selected portfolio mode.
 * @param {object} p
 * @param {number} p.startingUsdt Shared account start.
 * @param {number} p.coinCount
 * @param {string} [p.mode]
 */
export function resolvePortfolioUnitStart({ startingUsdt, coinCount, mode }) {
  const start = Math.max(1, Number(startingUsdt) || 100);
  const n = Math.max(1, Math.floor(Number(coinCount) || 1));
  const m = MODE_SET.has(String(mode || "").toUpperCase())
    ? String(mode).toUpperCase()
    : "EQUAL_SLICE_FULL_MARGIN";
  if (m === "TOTAL_CAPITAL_RISK_AT_SL") return start;
  return start / n;
}

/**
 * Unit-sim `backtestPositionSizing` for one coin under the selected portfolio mode.
 * @param {string} [mode]
 */
export function resolvePortfolioUnitSizingMode(mode) {
  const m = String(mode || "").toUpperCase();
  if (m === "EQUAL_SLICE_FULL_MARGIN") return "FULL_EQUITY_MARGIN";
  return "RISK_AT_SL";
}
