/**
 * Research Investment Matrix — all investments, not just data purchases.
 */
export const VALUE_TIERS = { HIGH: "high", MEDIUM: "medium", LOW: "low", UNKNOWN: "unknown" };
export const COST_TIERS = { LOW: "low", MEDIUM: "medium", HIGH: "high", VERY_HIGH: "very_high" };

export const RESEARCH_INVESTMENT_MATRIX = [
  { investment: "Integrate OI + funding (L2)", type: "data_integration", cost: COST_TIERS.LOW, engineering: COST_TIERS.LOW, expectedInformationGain: VALUE_TIERS.HIGH, levels: ["L2"], free: true },
  { investment: "New L0–L1 hypothesis family", type: "hypothesis", cost: COST_TIERS.LOW, engineering: COST_TIERS.LOW, expectedInformationGain: VALUE_TIERS.MEDIUM, levels: ["L0", "L1"] },
  { investment: "Longer historical data", type: "data", cost: COST_TIERS.LOW, engineering: COST_TIERS.LOW, expectedInformationGain: VALUE_TIERS.MEDIUM, levels: ["L0"] },
  { investment: "More assets / universe", type: "universe", cost: COST_TIERS.LOW, engineering: COST_TIERS.MEDIUM, expectedInformationGain: VALUE_TIERS.MEDIUM, levels: ["L0", "L1"] },
  { investment: "Alternate timeframe (5m)", type: "timeframe", cost: COST_TIERS.LOW, engineering: COST_TIERS.MEDIUM, expectedInformationGain: VALUE_TIERS.MEDIUM, levels: ["L0", "L1"] },
  { investment: "Better execution modeling", type: "execution", cost: COST_TIERS.MEDIUM, engineering: COST_TIERS.MEDIUM, expectedInformationGain: VALUE_TIERS.MEDIUM, levels: ["L0", "L1"] },
  { investment: "Trade flow ingestion", type: "data", cost: COST_TIERS.LOW, engineering: COST_TIERS.MEDIUM, expectedInformationGain: VALUE_TIERS.MEDIUM, levels: ["L2", "L3"] },
  { investment: "Liquidation stream", type: "data", cost: COST_TIERS.MEDIUM, engineering: COST_TIERS.MEDIUM, expectedInformationGain: VALUE_TIERS.MEDIUM, levels: ["L2"] },
  { investment: "Historical L2 order book", type: "data", cost: COST_TIERS.HIGH, engineering: COST_TIERS.HIGH, expectedInformationGain: VALUE_TIERS.HIGH, levels: ["L3"] },
  { investment: "Options surface", type: "data", cost: COST_TIERS.VERY_HIGH, engineering: COST_TIERS.HIGH, expectedInformationGain: VALUE_TIERS.UNKNOWN, levels: ["L4"] },
  { investment: "New L1 feature (same info)", type: "feature", cost: COST_TIERS.LOW, engineering: COST_TIERS.LOW, expectedInformationGain: VALUE_TIERS.LOW, levels: ["L1"] },
];

/** @deprecated */
export const INFORMATION_VALUE_MATRIX = RESEARCH_INVESTMENT_MATRIX.map((r) => ({
  source: r.investment,
  levels: r.levels,
  cost: r.cost,
  engineeringEffort: r.engineering,
  expectedResearchValue: r.expectedInformationGain,
}));

export function rankResearchInvestments(matrix = RESEARCH_INVESTMENT_MATRIX) {
  const valueScore = { high: 3, medium: 2, low: 1, unknown: 0 };
  const costScore = { low: 1, medium: 2, high: 3, very_high: 4 };
  return [...matrix]
    .map((r) => ({
      ...r,
      score: (valueScore[r.expectedInformationGain] ?? 0) / (costScore[r.cost] + costScore[r.engineering]),
    }))
    .sort((a, b) => b.score - a.score);
}

export function researchInvestmentMatrixToMarkdown(matrix = RESEARCH_INVESTMENT_MATRIX) {
  const ranked = rankResearchInvestments(matrix);
  return [
    "# Research Investment Matrix",
    "",
    "Compare ALL research investments — buying data is not always highest value.",
    "",
    "| Investment | Type | Cost | Engineering | Info Gain | Score |",
    "|------------|------|------|-------------|-----------|-------|",
    ...ranked.map(
      (r) =>
        `| ${r.investment} | ${r.type} | ${r.cost} | ${r.engineering} | ${r.expectedInformationGain} | ${r.score.toFixed(2)} |`,
    ),
  ].join("\n");
}

export const informationValueMatrixToMarkdown = researchInvestmentMatrixToMarkdown;
export const rankDataInvestments = rankResearchInvestments;
