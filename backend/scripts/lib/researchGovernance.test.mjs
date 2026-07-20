import test from "node:test";
import assert from "node:assert/strict";
import { evaluateExitCriteria, EXIT_REASONS } from "./researchExitCriteria.js";
import { rankBacklog, DEFAULT_RESEARCH_BACKLOG } from "./researchBacklog.js";
import { buildGovernanceReport } from "./researchGovernance.js";
import { assessInformationLimit } from "./informationLimit.js";
import { efficiencyScore } from "./researchEfficiency.js";
import { classifyVerdict, VERDICT } from "./researchVerdicts.js";
import { updateBelief } from "./bayesianResearchLog.js";

test("evaluateExitCriteria archives family after hypothesis budget exhausted", () => {
  const r = evaluateExitCriteria(
    { id: "A", name: "LIQ" },
    { experimentsRun: 6, promotedFeatures: 0, holdoutFailures: 1, assetStabilityRatio: 0.2 },
  );
  assert.equal(r.shouldArchive, true);
  assert.ok(r.triggers.includes(EXIT_REASONS.NO_PROMOTED_FEATURES));
});

test("evaluateExitCriteria does not archive when features promoted", () => {
  const r = evaluateExitCriteria({ id: "A", name: "LIQ" }, { experimentsRun: 6, promotedFeatures: 1 });
  assert.equal(r.shouldArchive, false);
});

test("rankBacklog puts FALS-001 first", () => {
  const ranked = rankBacklog(DEFAULT_RESEARCH_BACKLOG);
  assert.equal(ranked[0].id, "FALS-001");
  assert.equal(ranked[0].informationGain, "very_high");
});

test("rankBacklog excludes frozen by default", () => {
  const ranked = rankBacklog(DEFAULT_RESEARCH_BACKLOG);
  assert.ok(!ranked.some((i) => i.id === "FEAT-001"));
});

test("buildGovernanceReport tracks progress metrics", () => {
  const r = buildGovernanceReport({
    experimentResults: [
      { id: "EXP-001", accepted: false, holdout: { monotonicity: -0.1 } },
      { id: "EXP-002", accepted: false, holdout: { monotonicity: -0.2 } },
      { id: "EXP-003", accepted: false, holdout: { monotonicity: -0.1 } },
    ],
    phase2Report: {
      holdoutPolicyComparison: {
        max_score: { avgOutcome: 0.02 },
        max_distributional_utility: { avgOutcome: 0.03 },
      },
      calibration: { expectedR: { rankCorrelation: -0.02 } },
    },
    ofaReport: { hypotheses: ["OFA-001"] },
  });
  assert.ok(r.progress.correctRejection.met);
  assert.ok(r.progress.decisionQuality.met);
  assert.equal(r.productionAlpha.status, "unknown_not_demonstrated");
});

test("assessInformationLimit detects missing information at L0-L1 plateau", () => {
  const r = assessInformationLimit({
    experimentsRun: 6,
    maxMutualInfo: 0.01,
    holdoutRankCorrelation: -0.02,
    uoaSimilarExpectedR: 38,
    uoaMultiCandidateDays: 75,
    testedLevels: ["L0", "L1"],
  });
  assert.equal(r.conclusion, "missing_information");
  assert.equal(r.threeOutcomes.missingInformation, "concluded");
});

test("classifyVerdict distinguishes disproven from untestable", () => {
  assert.equal(classifyVerdict({ accepted: false, fdrSignificant: false, n: 500 }), VERDICT.DISPROVEN);
  assert.equal(
    classifyVerdict({ accepted: false, requiredData: "level2", n: 0 }, []),
    VERDICT.UNTESTABLE,
  );
});

test("efficiencyScore rewards high gain low cost", () => {
  const high = efficiencyScore({ devDays: 2, compute: "low", informationGain: "very_high" });
  const low = efficiencyScore({ devDays: 4, compute: "high", informationGain: "low" });
  assert.ok(high > low);
});

test("updateBelief reduces posterior on negative evidence", () => {
  const b = { alpha: 7, beta: 3, prior: 0.7 };
  const updated = updateBelief(b, 0.1, { type: "test", weight: 2 });
  assert.ok(updated.posterior < 0.7);
});
