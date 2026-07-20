/**
 * Hypothesis family lifecycle — exploration → validation → confirmed negative → archived.
 *
 * "No promotion" ≠ confirmed negative. Archive requires explicit confirmation
 * on full parity runs (same universe, window, data source, validation as Family A).
 */

export const FAMILY_LIFECYCLE = {
  EXPLORATION: "exploration",
  VALIDATION: "validation",
  PROVISIONAL_NEGATIVE: "provisional_negative",
  CONFIRMED_NEGATIVE: "confirmed_negative",
  PROMISING: "promising",
  PRODUCTION_CANDIDATE: "production_candidate",
  ARCHIVED: "archived",
};

/** Family A reference window for parity checks. */
export const FAMILY_A_RESEARCH_BASELINE = {
  from: "2022-01-01",
  to: "2026-06-01",
  coins: ["BTCUSDT", "BNBUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"],
  timeframe: "15m",
  dataSource: "timescale",
};

/**
 * @param {{ from?: string, to?: string, coins?: string[], dataSource?: string, timeframe?: string }} run
 */
export function assessRunParity(run = {}) {
  const baseline = FAMILY_A_RESEARCH_BASELINE;
  const coins = (run.coins ?? []).map((c) => String(c).toUpperCase()).sort();
  const baselineCoins = [...baseline.coins].sort();
  const sameCoins =
    coins.length === baselineCoins.length && coins.every((c, i) => c === baselineCoins[i]);
  const sameWindow = run.from === baseline.from && run.to === baseline.to;
  const sameTf = (run.timeframe ?? baseline.timeframe) === baseline.timeframe;
  const sameSource = (run.dataSource ?? "unknown") === baseline.dataSource;

  return {
    parityWithFamilyA: sameCoins && sameWindow && sameTf && sameSource,
    checks: { sameCoins, sameWindow, sameTimeframe: sameTf, sameDataSource: sameSource },
    baseline,
    run: { from: run.from, to: run.to, coins, timeframe: run.timeframe, dataSource: run.dataSource },
  };
}

/**
 * Classify lifecycle after validation completes with zero promotions.
 */
export function classifyNegativeResult({ parityWithFamilyA = false, promoted = 0, experimentsRun = 0 } = {}) {
  if (promoted > 0) return FAMILY_LIFECYCLE.PROMISING;
  if (experimentsRun < 3) return FAMILY_LIFECYCLE.VALIDATION;
  if (!parityWithFamilyA) return FAMILY_LIFECYCLE.PROVISIONAL_NEGATIVE;
  return FAMILY_LIFECYCLE.CONFIRMED_NEGATIVE;
}

export function lifecycleLabel(status) {
  const labels = {
    [FAMILY_LIFECYCLE.EXPLORATION]: "Exploration",
    [FAMILY_LIFECYCLE.VALIDATION]: "Validation",
    [FAMILY_LIFECYCLE.PROVISIONAL_NEGATIVE]: "Provisional negative",
    [FAMILY_LIFECYCLE.CONFIRMED_NEGATIVE]: "Confirmed negative",
    [FAMILY_LIFECYCLE.PROMISING]: "Promising",
    [FAMILY_LIFECYCLE.PRODUCTION_CANDIDATE]: "Production candidate",
    [FAMILY_LIFECYCLE.ARCHIVED]: "Archived",
  };
  return labels[status] ?? status;
}

export function lifecycleToMarkdown() {
  return [
    "# Family Lifecycle",
    "",
    "```",
    "Exploration → Validation → Provisional Negative → Confirmed Negative → Archived",
    "```",
    "",
    "- **Provisional negative:** failed promotion; run not yet parity-confirmed with Family A baseline",
    "- **Confirmed negative:** failed promotion on full parity run at tested information levels",
    "- **Archived:** closed at tested levels; retest requires new information (e.g. L2 OI/funding)",
    "",
    `**Family A baseline:** ${FAMILY_A_RESEARCH_BASELINE.coins.join(", ")}, ${FAMILY_A_RESEARCH_BASELINE.from}→${FAMILY_A_RESEARCH_BASELINE.to}, ${FAMILY_A_RESEARCH_BASELINE.dataSource}`,
  ].join("\n");
}
