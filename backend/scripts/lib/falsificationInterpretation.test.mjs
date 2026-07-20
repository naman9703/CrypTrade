import test from "node:test";
import assert from "node:assert/strict";
import { interpretFalsificationResults, FALS_OUTCOMES } from "./falsificationInterpretation.js";
import { rankResearchInvestments } from "./informationValueMatrix.js";
import { planInformationAcquisition } from "./informationAcquisitionPlanner.js";
import { assessDecisionBoundary } from "./observableDecisionBoundary.js";
import { computeRROI } from "./researchROI.js";
import { assessRunParity, FAMILY_A_RESEARCH_BASELINE } from "./familyLifecycle.js";

test("FALS all failed recommends OI+funding not L3 order book first", () => {
  const r = interpretFalsificationResults({
    familiesTested: 3,
    familiesPassed: 0,
    priceDerivedFamiliesFailed: 3,
    familyCResult: "failed",
    familyDResult: "failed",
    runParity: assessRunParity({
      from: FAMILY_A_RESEARCH_BASELINE.from,
      to: FAMILY_A_RESEARCH_BASELINE.to,
      coins: FAMILY_A_RESEARCH_BASELINE.coins,
      dataSource: "timescale",
    }),
  });
  assert.equal(r.sufficientForContinuedL01Research, false);
  assert.equal(r.outcome, FALS_OUTCOMES.NO_PRICE_DERIVED_PROMOTION);
  assert.ok(r.nextSteps.some((s) => s.action.includes("OI + funding")));
  assert.ok(!r.nextSteps[0]?.action.includes("L3 order book"));
});

test("FALS one passed supports continued L0-L1 research", () => {
  const r = interpretFalsificationResults({
    familiesTested: 3,
    familiesPassed: 1,
    familyCResult: "passed",
    familyDResult: "failed",
  });
  assert.equal(r.sufficientForContinuedL01Research, true);
  assert.equal(r.outcome, FALS_OUTCOMES.L01_SUFFICIENT_FOR_SOME);
});

test("OI+funding ranks above L2 order book in investment matrix", () => {
  const ranked = rankResearchInvestments();
  const oi = ranked.findIndex((r) => r.investment.includes("OI"));
  const l2book = ranked.findIndex((r) => r.investment.includes("order book"));
  assert.ok(oi < l2book);
});

test("acquisition planner recommends OI integration before falsification complete", () => {
  const plan = planInformationAcquisition({ l0l1FalsificationComplete: false });
  assert.ok(plan.recommendations.some((r) => r.action.includes("FALS-001")));
});

test("decision boundary reports headroom", () => {
  const b = assessDecisionBoundary({ holdoutRankCorrelation: -0.02, holdoutPolicyLift: 0.01, oraclePredictPct: 48 });
  assert.ok(b.headroom >= 0);
  assert.ok(b.estimatedCeiling != null);
});

test("RROI computes platform KPI", () => {
  const r = computeRROI({ hypothesesTested: 6, hypothesesRejected: 5, engineeringDays: 10 });
  assert.ok(r.rroi > 0);
});
