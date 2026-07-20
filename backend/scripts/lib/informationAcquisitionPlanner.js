/**
 * Research investment planner — what should we learn next? (not only data).
 */
import { UOA_OUTCOMES } from "./informationHierarchy.js";
import { rankResearchInvestments, RESEARCH_INVESTMENT_MATRIX } from "./informationValueMatrix.js";
import { interpretFalsificationResults, FALS_001_QUESTION } from "./falsificationInterpretation.js";

export const ACQUISITION_BLOCKERS = {
  FALS_001_PENDING: "fals_001_pending",
};

export function planInformationAcquisition(context = {}) {
  const {
    currentBottleneck = UOA_OUTCOMES.MISSING_INFORMATION,
    l0l1FalsificationComplete = false,
    falsificationFamiliesPassed = 0,
    falsificationFamiliesTested = 0,
    anyHoldoutSlicePositive = false,
  } = context;

  const falsInterpretation = interpretFalsificationResults({
    familiesTested: falsificationFamiliesTested,
    familiesPassed: falsificationFamiliesPassed,
    familiesFailed: falsificationFamiliesTested - falsificationFamiliesPassed,
    anyHoldoutSlicePositive,
  });

  const recommendations = [];
  const blockers = [];

  if (!l0l1FalsificationComplete) {
    blockers.push(ACQUISITION_BLOCKERS.FALS_001_PENDING);
    recommendations.push({
      priority: 1,
      action: "Complete FALS-001",
      detail: FALS_001_QUESTION,
      rationale: "Neutral gate — does not automatically imply L3 purchase",
    });
  } else {
    for (const step of falsInterpretation.nextSteps ?? []) {
      recommendations.push({ priority: step.priority, action: step.action, detail: "", rationale: "" });
    }
  }

  if (!l0l1FalsificationComplete || falsInterpretation.sufficientForContinuedL01Research === false) {
    recommendations.push({
      priority: 2,
      action: "Integrate free L2: OI + funding (Phase 1)",
      detail: "Highest score in investment matrix — free, low engineering",
      rationale: "Test before expensive L3 microstructure; not automatic from family failures",
    });
  }

  const ranked = rankResearchInvestments(RESEARCH_INVESTMENT_MATRIX);

  return {
    question: "What should we learn next?",
    fals001: falsInterpretation,
    currentBottleneck,
    blockers,
    recommendations: recommendations.sort((a, b) => a.priority - b.priority),
    rankedInvestments: ranked.slice(0, 6),
    caution:
      "Family failures do not automatically imply L3 order book. Consider Cases B (formulation), C (timeframe/universe), D (little edge).",
  };
}

export function acquisitionPlannerToMarkdown(plan) {
  const lines = [
    "# Research Investment Planner",
    "",
    `**Question:** ${plan.question}`,
    "",
    `**FALS-001:** ${plan.fals001?.summary ?? "pending"}`,
    "",
    "## Recommendations",
    "",
  ];
  for (const r of plan.recommendations) {
    lines.push(`- **${r.action}**${r.rationale ? ` — ${r.rationale}` : ""}`);
  }
  lines.push(
    "",
    "## Ranked Investments (all types)",
    "",
    "| Investment | Score | Gain |",
    "|------------|-------|------|",
    ...plan.rankedInvestments.map((r) => `| ${r.investment} | ${r.score.toFixed(2)} | ${r.expectedInformationGain} |`),
    "",
    `> ${plan.caution}`,
  );
  return lines.join("\n");
}
