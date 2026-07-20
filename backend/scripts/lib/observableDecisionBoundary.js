/**
 * Observable Decision Boundary — best achievable decision quality given current observable information.
 */
export function assessDecisionBoundary(metrics = {}) {
  const {
    holdoutRankCorrelation = 0,
    holdoutPolicyLift = 0,
    oraclePredictPct = 0,
    brierScore = null,
    calibratedFeatures = 0,
    maxAvailableLevel = "L2",
  } = metrics;

  const ceiling = estimateCeiling(holdoutRankCorrelation, oraclePredictPct);
  const current = estimateCurrentQuality(holdoutPolicyLift, holdoutRankCorrelation);
  const headroom = Math.max(0, ceiling - current);

  return {
    question: "Given observable information currently available, what is the best achievable decision quality?",
    maxAvailableLevel,
    metrics: { holdoutRankCorrelation, holdoutPolicyLift, oraclePredictPct, brierScore, calibratedFeatures },
    estimatedCeiling: ceiling,
    currentDecisionQuality: current,
    headroom,
    interpretation:
      headroom < 0.05
        ? "Near ceiling for current observable information — new information or formulation change required"
        : headroom < 0.15
          ? "Moderate headroom — discrimination improvements possible within L0–L2"
          : "Substantial headroom — decision policy and calibration not yet at information-imposed ceiling",
    note: "Different from 'does more information exist?' — measures proximity to ceiling imposed by current data.",
  };
}

function estimateCeiling(rankCorr, oraclePct) {
  const rankComponent = Math.max(0, Math.min(1, (rankCorr + 0.2) / 0.6));
  const oracleComponent = Math.max(0, Math.min(1, oraclePct / 100));
  return Number((0.4 * rankComponent + 0.6 * oracleComponent).toFixed(3));
}

function estimateCurrentQuality(policyLift, rankCorr) {
  const liftComponent = Math.max(0, Math.min(1, (policyLift + 0.05) / 0.2));
  const rankComponent = Math.max(0, Math.min(1, (rankCorr + 0.1) / 0.3));
  return Number((0.5 * liftComponent + 0.5 * rankComponent).toFixed(3));
}

export function decisionBoundaryToMarkdown(boundary) {
  return [
    "# Observable Decision Boundary",
    "",
    `**Question:** ${boundary.question}`,
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Max available level | ${boundary.maxAvailableLevel} |`,
    `| Estimated ceiling | ${boundary.estimatedCeiling} |`,
    `| Current decision quality | ${boundary.currentDecisionQuality} |`,
    `| Headroom | ${boundary.headroom} |`,
    "",
    boundary.interpretation,
    "",
    `> ${boundary.note}`,
  ].join("\n");
}
