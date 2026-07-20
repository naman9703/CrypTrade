/**
 * Research progress metrics — measure the process, not Family A success.
 */
import { evaluateExitCriteria } from "./researchExitCriteria.js";
import { rankBacklog, DEFAULT_RESEARCH_BACKLOG } from "./researchBacklog.js";
import { evaluateFamilyVerdict, HYPOTHESIS_FAMILIES } from "./hypothesisFamilies.js";
import { buildEfficiencyTable, efficiencyToMarkdown } from "./researchEfficiency.js";
import { applyEvidenceToBeliefs, beliefLogToMarkdown } from "./bayesianResearchLog.js";
import { assessInformationLimit, informationLimitToMarkdown } from "./informationLimit.js";
import { capabilityMatrixToMarkdown, RESEARCH_CAPABILITY_MATRIX } from "./researchCapabilityMatrix.js";
import { classifyVerdict, verdictLabel } from "./researchVerdicts.js";
import {
  MISSION_STATEMENT,
  PLATFORM_DESCRIPTION,
  PROJECT_PHASES,
  observableInformationHierarchyToMarkdown,
} from "./informationHierarchy.js";
import { informationValueMatrixToMarkdown } from "./informationValueMatrix.js";
import { planInformationAcquisition, acquisitionPlannerToMarkdown } from "./informationAcquisitionPlanner.js";
import { interpretFalsificationResults, falsificationToMarkdown } from "./falsificationInterpretation.js";
import { assessDecisionBoundary, decisionBoundaryToMarkdown } from "./observableDecisionBoundary.js";
import { DEFAULT_RESEARCH_DEBT, researchDebtToMarkdown } from "./researchDebt.js";
import { computeRROI, rroiToMarkdown } from "./researchROI.js";
import { researchInvestmentMatrixToMarkdown } from "./informationValueMatrix.js";

export const PRIMARY_OBJECTIVE = MISSION_STATEMENT;

export const PROGRESS_METRICS = {
  correctRejection: "Did the platform correctly reject a weak hypothesis?",
  holdoutSurvival: "Did a reproducible effect survive holdout testing?",
  uncertaintyReduction: "Did research reduce uncertainty about market behavior?",
  decisionQuality: "Did decision quality improve on unseen data?",
  researchEfficiency: "How much did we learn per unit of research effort?",
  l0l1Falsification: "Have unrelated L0–L1 families been tested before data investment?",
};

export function buildGovernanceReport(opts = {}) {
  let {
    experimentResults = [],
    phase2Report = null,
    uoaReport = null,
    researchPool = [],
    falsReport = null,
    l0l1FalsificationComplete = false,
    falsificationFamiliesPassed = 0,
    falsificationFamiliesTested = 0,
  } = opts;

  const fals = falsReport ?? opts.fals001Report ?? null;
  if (fals?.fals001) {
    l0l1FalsificationComplete = true;
    falsificationFamiliesTested = fals.fals001.familiesTested ?? 3;
    falsificationFamiliesPassed = fals.fals001.familiesPassed ?? 0;
  }

  const ofaReport = uoaReport ?? opts.ofaReport ?? null;
  const maxMI = Math.max(0, ...researchPool.map((f) => f.mutualInfo ?? 0), 0.01);

  const familyVerdicts = Object.values(HYPOTHESIS_FAMILIES).map((family) => {
    const familyExps = experimentResults.filter((r) => (family.experiments ?? []).includes(r.id));
    const holdoutFailures = familyExps.filter(
      (e) => e.holdout?.monotonicity != null && e.holdout.monotonicity <= 0,
    ).length;
    const coinSlices = familyExps.flatMap((e) => Object.values(e.slices?.coin?.slices ?? {}));
    const assetStabilityRatio = coinSlices.length
      ? coinSlices.filter((s) => (s.monotonicity ?? 0) > 0 && (s.spread ?? 0) > 0).length / coinSlices.length
      : 0;

    const verdict = evaluateFamilyVerdict(family, experimentResults, []);
    const exit = evaluateExitCriteria(family, {
      experimentsRun: familyExps.length,
      promotedFeatures: 0,
      holdoutFailures,
      assetStabilityRatio,
      maxInformationGain: maxMI,
      researchCycles: 1,
      manualStatus: family.status,
    });

    return { verdict, exit, negativeResult: family.negativeResult ?? null };
  });

  const informationLimit = assessInformationLimit({
    experimentsRun: experimentResults.length,
    promotedFeatures: 0,
    maxMutualInfo: maxMI,
    holdoutRankCorrelation: phase2Report?.calibration?.expectedR?.rankCorrelation ?? 0,
    uoaSimilarExpectedR: ofaReport?.failureModes?.similar_expected_r ?? 0,
    uoaMultiCandidateDays: ofaReport?.multiCandidateDays ?? 0,
    testedLevels: ["L0", "L1"],
    requiredLevelsForRetest: ["L2"],
  });

  const holdoutPolicy = phase2Report?.holdoutPolicyComparison;
  const policyLift =
    (holdoutPolicy?.max_distributional_utility?.avgOutcome ?? 0) - (holdoutPolicy?.max_score?.avgOutcome ?? 0);

  const decisionBoundary = assessDecisionBoundary({
    holdoutRankCorrelation: phase2Report?.calibration?.expectedR?.rankCorrelation ?? 0,
    holdoutPolicyLift: policyLift,
    oraclePredictPct: phase2Report?.oraclePredictability?.oraclePredictPct ?? 0,
    brierScore: phase2Report?.calibration?.brier?.pHit1R?.score,
    calibratedFeatures: phase2Report?.calibratedFeatures ?? 0,
    maxAvailableLevel: "L2",
  });

  const falsification = fals?.fals001 ?? interpretFalsificationResults({
    familiesTested: falsificationFamiliesTested,
    familiesPassed: falsificationFamiliesPassed,
    anyHoldoutSlicePositive: experimentResults.some((e) => e.holdout?.monotonicity > 0),
  });

  const acquisitionPlan = planInformationAcquisition({
    currentBottleneck: informationLimit.conclusion,
    l0l1FalsificationComplete,
    falsificationFamiliesPassed,
    falsificationFamiliesTested,
    anyHoldoutSlicePositive: experimentResults.some((e) => e.holdout?.monotonicity > 0),
  });

  const progress = assessProgress(phase2Report, experimentResults, ofaReport, {
    l0l1FalsificationComplete,
    falsificationFamiliesTested,
  });

  return {
    platform: "Quantitative Market Research Platform",
    platformDescription: PLATFORM_DESCRIPTION,
    projectPhases: PROJECT_PHASES,
    primaryObjective: PRIMARY_OBJECTIVE,
    progressMetrics: PROGRESS_METRICS,
    progress,
    familyGovernance: familyVerdicts,
    backlog: rankBacklog(DEFAULT_RESEARCH_BACKLOG),
    efficiency: buildEfficiencyTable(experimentResults),
    beliefLog: applyEvidenceToBeliefs(experimentResults, ofaReport),
    informationLimit,
    acquisitionPlan,
    falsification,
    decisionBoundary,
    researchDebt: DEFAULT_RESEARCH_DEBT,
    rroi: computeRROI({
      hypothesesTested: experimentResults.length,
      hypothesesRejected: experimentResults.filter((e) => e.accepted === false).length,
      hypothesesPromoted: experimentResults.filter((e) => e.accepted === true).length,
      uncertaintyReduction: ofaReport?.hypotheses?.length ?? 0,
      holdoutDecisionQualityDelta: policyLift,
      engineeringDays: experimentResults.length * 2,
      computeCost: "medium",
    }),
    capabilityMatrix: RESEARCH_CAPABILITY_MATRIX,
    experimentVerdicts: experimentResults.map((e) => ({
      id: e.id,
      verdict: classifyVerdict(e),
      label: verdictLabel(classifyVerdict(e)),
    })),
    productionAlpha: {
      status: "unknown_not_demonstrated",
      note: "Platform measures predictability of observable information — not demonstrated alpha",
    },
    l0l1Falsification: {
      complete: l0l1FalsificationComplete,
      familiesTested: falsificationFamiliesTested,
      familiesPassed: falsificationFamiliesPassed,
      requiredBeforeDataInvestment: true,
      familyResults: fals?.families ?? null,
    },
  };
}

function assessProgress(phase2, experiments, ofa, fals) {
  const rejected = experiments.filter((e) => e.accepted === false).length;
  const anyHoldoutPositive = experiments.some((e) => e.holdout?.monotonicity > 0 && e.holdout?.spread > 0);
  const holdoutPolicy = phase2?.holdoutPolicyComparison;
  const distBeatsScore =
    (holdoutPolicy?.max_distributional_utility?.avgOutcome ?? -99) >
    (holdoutPolicy?.max_score?.avgOutcome ?? -99);
  const rankCorr = phase2?.calibration?.expectedR?.rankCorrelation ?? 0;
  const efficiency = buildEfficiencyTable(experiments);
  const avgEfficiency = efficiency.length ? efficiency.reduce((s, e) => s + e.efficiency, 0) / efficiency.length : 0;

  return {
    correctRejection: { met: rejected >= 3, detail: `${rejected} hypotheses correctly rejected` },
    holdoutSurvival: {
      met: anyHoldoutPositive,
      detail: anyHoldoutPositive ? "Some holdout slices positive" : "No full holdout promotion",
    },
    uncertaintyReduction: {
      met: ofa?.hypotheses?.length > 0,
      detail: ofa?.hypotheses?.length ? `UOA: ${ofa.hypotheses.length} hypotheses` : "UOA pending",
    },
    decisionQuality: {
      met: distBeatsScore,
      detail: distBeatsScore
        ? `Holdout distributional beats score`
        : "Holdout decision quality not improved",
      note: rankCorr < 0.1 ? "Bottleneck: observable information at L0–L1, not estimator" : "Discrimination improving",
    },
    researchEfficiency: {
      met: avgEfficiency > 0.1,
      detail: `Avg efficiency ${avgEfficiency.toFixed(3)}; top ${efficiency[0]?.id ?? "—"}`,
    },
    l0l1Falsification: {
      met: fals.l0l1FalsificationComplete,
      detail: fals.l0l1FalsificationComplete
        ? `FALS-001 complete (${fals.falsificationFamiliesTested} families)`
        : "FALS-001 required before L2/L3 data investment",
    },
  };
}

export function governanceToMarkdown(report) {
  const lines = [
    `# ${report.platform} — Governance Report`,
    "",
    report.platformDescription,
    "",
    `**Mission:** ${report.primaryObjective}`,
    "",
    "## Project Phase",
    "",
    `**Active:** Phase ${PROJECT_PHASES.PHASE_2_SCIENTIFIC.id}b — ${PROJECT_PHASES.PHASE_2_SCIENTIFIC.subphases?.["2b"]?.name ?? "L2 OI + funding"}`,
    "",
    `Phase 2a (price-derived falsification): **complete** — Families A, C, D tested; no promotion at L0–L1.`,
    "",
    "## Progress Metrics",
    "",
  ];
  for (const [key, question] of Object.entries(report.progressMetrics)) {
    const p = report.progress[key];
    lines.push(`- ${p?.met ? "✅" : "⏳"} **${question}** — ${p?.detail ?? "—"}`);
  }

  if (!report.l0l1Falsification.complete) {
    lines.push(
      "",
      "## ⚠️ Required Before Data Investment",
      "",
      "**FALS-001:** Is current observable information sufficient to justify continued L0–L1 research?",
      "Four outcomes: A (insufficient info), B (weak formulation), C (timeframe/universe), D (little edge).",
    );
  }

  lines.push(
    "",
    "## Information Limit",
    "",
    `**${report.informationLimit.question}** → **${report.informationLimit.conclusion}**`,
    "",
    report.informationLimit.recommendation,
    "",
    "## Production Alpha",
    "",
    `**${report.productionAlpha.status}** — ${report.productionAlpha.note}`,
  );

  const familyA = report.familyGovernance.find((f) => f.verdict.familyId === "A");
  if (familyA?.verdict) {
    const neg = HYPOTHESIS_FAMILIES.A_LIQ_CONTINUATION.negativeResult;
    lines.push(
      "",
      "## Family A — Observable Information Verdict",
      "",
      `| Tested | ${(neg?.testedLevels ?? []).join(", ")} |`,
      `| Lifecycle | confirmed negative at L0–L1 |`,
      `| Result | ${neg?.result ?? "—"} |`,
      `| Next test | ${(neg?.nextTestLevels ?? []).join(", ")} — ${neg?.nextTestAction ?? ""} |`,
      "",
      `> ${neg?.scientificStatement ?? ""}`,
      "",
      "> Confirmed negative ≠ archived. OI/funding (L2) retest required before closing family.",
    );
  }

  return lines.join("\n");
}

export {
  efficiencyToMarkdown,
  beliefLogToMarkdown,
  informationLimitToMarkdown,
  capabilityMatrixToMarkdown,
  observableInformationHierarchyToMarkdown,
  researchInvestmentMatrixToMarkdown,
  acquisitionPlannerToMarkdown,
  falsificationToMarkdown,
  decisionBoundaryToMarkdown,
  researchDebtToMarkdown,
  rroiToMarkdown,
};
export const informationHierarchyToMarkdown = observableInformationHierarchyToMarkdown;
