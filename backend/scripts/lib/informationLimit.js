/**
 * Information limit / UOA assessment — have we exhausted available information levels?
 */
import {
  UOA_OUTCOMES,
  UOA_QUESTION,
  formatLevelRange,
  maxAvailableLevel,
} from "./informationHierarchy.js";

export const INFORMATION_LIMIT = {
  NOT_REACHED: "not_reached",
  LEVEL_PLATEAU: "level_plateau",
  IRREDUCIBLE_NOISE: UOA_OUTCOMES.IRREDUCIBLE_RANDOMNESS,
  NO_EDGE: UOA_OUTCOMES.NO_EXPLOITABLE_RELATIONSHIP,
  INCONCLUSIVE: UOA_OUTCOMES.INCONCLUSIVE,
  /** @deprecated */ OHLCV_PLATEAU: "level_plateau",
};

export function assessInformationLimit(evidence = {}) {
  const {
    experimentsRun = 0,
    promotedFeatures = 0,
    maxMutualInfo = 0,
    holdoutRankCorrelation = 0,
    uoaSimilarExpectedR = 0,
    uoaMultiCandidateDays = 0,
    testedLevels = ["L0", "L1"],
    requiredLevelsForRetest = ["L2", "L3"],
    newInformationMarginalGain = null,
  } = evidence;

  const similarRate = uoaMultiCandidateDays > 0 ? uoaSimilarExpectedR / uoaMultiCandidateDays : 0;
  const signals = [];

  if (maxMutualInfo < 0.02 && experimentsRun >= 4) {
    signals.push(`MI plateau below 0.02 at ${formatLevelRange(testedLevels)}`);
  }
  if (holdoutRankCorrelation < 0.05 && experimentsRun >= 3) {
    signals.push("Holdout rank correlation near zero — cannot rank opportunities");
  }
  if (similarRate > 0.4) {
    signals.push(
      `${(similarRate * 100).toFixed(0)}% UOA failures from indistinguishable candidates at ${formatLevelRange(testedLevels)}`,
    );
  }
  if (newInformationMarginalGain != null && newInformationMarginalGain < 0.005) {
    signals.push("Marginal gain from new L1 features below threshold — adding EMAs will not help");
  }

  let conclusion = UOA_OUTCOMES.INCONCLUSIVE;
  let recommendation = "Continue research — information limit not established";

  if (similarRate > 0.4 && maxMutualInfo < 0.02 && holdoutRankCorrelation < 0.05) {
    conclusion = UOA_OUTCOMES.MISSING_INFORMATION;
    recommendation = `Exhausted explanatory power at ${formatLevelRange(testedLevels)}. Retest requires ${formatLevelRange(requiredLevelsForRetest)}. Status: untestable until ingested.`;
  } else if (promotedFeatures === 0 && experimentsRun >= 6 && maxMutualInfo < 0.01) {
    conclusion = UOA_OUTCOMES.NO_EXPLOITABLE_RELATIONSHIP;
    recommendation = "No exploitable relationship found at available information levels";
  } else if (holdoutRankCorrelation < 0 && similarRate < 0.2) {
    conclusion = UOA_OUTCOMES.IRREDUCIBLE_RANDOMNESS;
    recommendation = "Remaining variance may be irreducible randomness at this horizon";
  }

  return {
    question: UOA_QUESTION,
    conclusion,
    testedLevels,
    maxAvailableLevel: maxAvailableLevel(),
    requiredLevelsForRetest,
    signals,
    metrics: { maxMutualInfo, holdoutRankCorrelation, similarExpectedRRate: similarRate, experimentsRun },
    recommendation,
    threeOutcomes: {
      missingInformation: conclusion === UOA_OUTCOMES.MISSING_INFORMATION ? "concluded" : similarRate > 0.3 ? "likely" : "possible",
      irreducibleRandomness: conclusion === UOA_OUTCOMES.IRREDUCIBLE_RANDOMNESS ? "concluded" : "possible",
      noExploitableRelationship: conclusion === UOA_OUTCOMES.NO_EXPLOITABLE_RELATIONSHIP ? "concluded" : "possible",
    },
  };
}

export function informationLimitToMarkdown(assessment) {
  return [
    "# Information Limit Assessment",
    "",
    `**Question:** ${assessment.question}`,
    "",
    `**Tested levels:** ${formatLevelRange(assessment.testedLevels)} | **Max available:** ${assessment.maxAvailableLevel}`,
    "",
    `**Conclusion:** ${assessment.conclusion}`,
    "",
    assessment.recommendation,
    "",
    "## Three outcomes (UOA)",
    "",
    "| Outcome | Status |",
    "|---------|--------|",
    `| Missing information (L2+ required) | ${assessment.threeOutcomes.missingInformation} |`,
    `| Irreducible randomness | ${assessment.threeOutcomes.irreducibleRandomness} |`,
    `| No exploitable relationship | ${assessment.threeOutcomes.noExploitableRelationship} |`,
    "",
    "## Signals",
    "",
    ...assessment.signals.map((s) => `- ${s}`),
  ].join("\n");
}
