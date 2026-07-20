/**
 * Research exit criteria — when to archive a hypothesis family.
 * Complements promotion policy (when to advance) with abandonment policy (when to stop).
 */

export const EXIT_CRITERIA = {
  maxIndependentHypothesesWithoutPromotion: 6,
  maxHoldoutFailures: 2,
  minAssetStabilityRatio: 0.4,
  minInformationGain: 0.01,
  maxResearchEffortCycles: 3,
};

export const EXIT_REASONS = {
  NO_PROMOTED_FEATURES: "no_promoted_feature_after_n_hypotheses",
  REPEATED_HOLDOUT_FAILURE: "repeated_holdout_failures",
  NO_CROSS_ASSET_STABILITY: "no_stable_effect_across_assets",
  NO_INFORMATION_GAIN: "no_meaningful_information_gain",
  EFFORT_EXHAUSTED: "predefined_research_effort_exhausted",
  MANUAL_FREEZE: "manually_frozen_by_verdict",
};

/**
 * Evaluate whether a hypothesis family should be archived.
 */
export function evaluateExitCriteria(family, evidence = {}) {
  const {
    experimentsRun = 0,
    promotedFeatures = 0,
    holdoutFailures = 0,
    assetStabilityRatio = 0,
    maxInformationGain = 0,
    researchCycles = 0,
    manualStatus,
  } = evidence;

  const triggers = [];
  const checks = {
    hypothesisBudget:
      experimentsRun >= EXIT_CRITERIA.maxIndependentHypothesesWithoutPromotion && promotedFeatures === 0,
    holdoutFailures: holdoutFailures >= EXIT_CRITERIA.maxHoldoutFailures && promotedFeatures === 0,
    assetStability:
      experimentsRun >= 3 && assetStabilityRatio < EXIT_CRITERIA.minAssetStabilityRatio && promotedFeatures === 0,
    informationGain:
      experimentsRun >= 3 &&
      maxInformationGain < EXIT_CRITERIA.minInformationGain &&
      promotedFeatures === 0,
    effortExhausted: researchCycles >= EXIT_CRITERIA.maxResearchEffortCycles && promotedFeatures === 0,
    manualFreeze: manualStatus === "archived",
  };

  if (checks.hypothesisBudget) triggers.push(EXIT_REASONS.NO_PROMOTED_FEATURES);
  if (checks.holdoutFailures) triggers.push(EXIT_REASONS.REPEATED_HOLDOUT_FAILURE);
  if (checks.assetStability) triggers.push(EXIT_REASONS.NO_CROSS_ASSET_STABILITY);
  if (checks.informationGain) triggers.push(EXIT_REASONS.NO_INFORMATION_GAIN);
  if (checks.effortExhausted) triggers.push(EXIT_REASONS.EFFORT_EXHAUSTED);
  if (checks.manualFreeze) triggers.push(EXIT_REASONS.MANUAL_FREEZE);

  const shouldArchive = triggers.length > 0;
  const recommendation = shouldArchive
    ? `Archive family ${family.id ?? family.name} — ${triggers.join(", ")}`
    : "Continue research — exit criteria not met";

  return {
    familyId: family.id,
    familyName: family.name,
    shouldArchive,
    triggers,
    checks,
    recommendation,
    exitCriteria: EXIT_CRITERIA,
  };
}

export function exitCriteriaToMarkdown(results) {
  const lines = [
    "# Research Exit Criteria",
    "",
    "Archive a hypothesis family when evidence consistently fails — not when intuition says so.",
    "",
    "## Thresholds",
    "",
    `- Max independent hypotheses without promotion: **${EXIT_CRITERIA.maxIndependentHypothesesWithoutPromotion}**`,
    `- Max holdout failures: **${EXIT_CRITERIA.maxHoldoutFailures}**`,
    `- Min asset stability ratio: **${EXIT_CRITERIA.minAssetStabilityRatio}**`,
    `- Min information gain (MI): **${EXIT_CRITERIA.minInformationGain}**`,
    `- Max research effort cycles: **${EXIT_CRITERIA.maxResearchEffortCycles}**`,
    "",
    "## Family Evaluations",
    "",
    "| Family | Archive? | Triggers | Recommendation |",
    "|--------|----------|----------|----------------|",
  ];
  for (const r of results) {
    lines.push(
      `| ${r.familyName} | ${r.shouldArchive ? "✅ Yes" : "❌ No"} | ${r.triggers.join(", ") || "—"} | ${r.recommendation} |`,
    );
  }
  return lines.join("\n");
}
