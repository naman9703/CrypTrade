import test from "node:test";
import assert from "node:assert/strict";
import {
  trainDistributionalEstimator,
  estimateDistributionalOutcome,
  computeUtilityFromDistribution,
} from "./distributionalOutcomeEstimator.js";
import { brierScore, reliabilityCurve, evaluateDistributionalCalibration } from "./calibrationMetrics.js";
import { analyzeUnexplainedOutcomes } from "./oracleFailureAnalysis.js";
import { discoverBehaviorClusters } from "./behaviorDiscovery.js";

function row(overrides) {
  return {
    candidateKey: "k1",
    symbol: "BTCUSDT",
    dayId: 1,
    side: "BUY",
    entryTs: 1000,
    cont_score: 0.8,
    sweep_velocityAtr: 1.2,
    level_importance: 2,
    marketState_adx: 25,
    scoreV2_total: 70,
    weightedQuality: 70,
    fwd_closeR_20: 0.5,
    fwd_mfeR_20: 0.8,
    fwd_maeR_20: 0.2,
    hit1R_flag: 1,
    hit2R_flag: 0,
    hit3R_flag: 0,
    firstHit_sl: 0,
    timeToMfeBars: 10,
    ...overrides,
  };
}

test("trainDistributionalEstimator produces probability calibrators", () => {
  const train = Array.from({ length: 60 }, (_, i) =>
    row({
      candidateKey: `k${i}`,
      cont_score: i / 60,
      hit1R_flag: i > 30 ? 1 : 0,
      fwd_closeR_20: i > 30 ? 0.6 : -0.2,
    }),
  );
  const model = trainDistributionalEstimator(train);
  assert.ok(Object.keys(model.calibrators).length > 0);
  const est = estimateDistributionalOutcome(row({ cont_score: 0.9 }), model);
  assert.ok(est.pHit1R != null);
  assert.ok(est.pSlFirst != null);
  assert.ok(est.expectedMfeR != null);
  assert.ok(est.uncertainty != null);
});

test("computeUtilityFromDistribution penalizes variance and SL", () => {
  const stable = computeUtilityFromDistribution(
    { expectedR: 0.4, pSlFirst: 0.2, expectedMaeR: 0.1 },
    0.1,
  );
  const volatile = computeUtilityFromDistribution(
    { expectedR: 0.4, pSlFirst: 0.5, expectedMaeR: 0.4 },
    0.8,
  );
  assert.ok(stable > volatile);
});

test("brierScore measures probability accuracy", () => {
  const r = brierScore([0.9, 0.1, 0.8], [1, 0, 1]);
  assert.ok(r.score < 0.1);
});

test("reliabilityCurve bins predictions", () => {
  const preds = Array.from({ length: 100 }, (_, i) => i / 100);
  const actuals = preds.map((p) => (p > 0.5 ? 1 : 0));
  const curve = reliabilityCurve(preds, actuals, 5);
  assert.equal(curve.sufficient, true);
  assert.ok(curve.bins.length >= 3);
});

test("analyzeUnexplainedOutcomes concludes missing information", () => {
  const groups = Array.from({ length: 10 }, () => [
    {
      candidateKey: "a",
      expectedUtility: 0.5,
      expectedR: 0.4,
      weightedQuality: 80,
      fwd_closeR_20: 0.2,
    },
    {
      candidateKey: "b",
      expectedUtility: 0.35,
      expectedR: 0.42,
      weightedQuality: 60,
      fwd_closeR_20: 1.2,
    },
  ]);
  const r = analyzeUnexplainedOutcomes(groups);
  assert.equal(r.experimentFamily, "UOA");
  assert.ok(r.conclusion === "missing_information" || r.failures > 0);
});

test("discoverBehaviorClusters finds clusters", () => {
  const rows = Array.from({ length: 80 }, (_, i) =>
    row({
      candidateKey: `k${i}`,
      cont_score: i < 40 ? 0.2 : 0.9,
      marketState_adx: i < 40 ? 10 : 40,
      fwd_closeR_20: i < 40 ? -0.1 : 0.4,
    }),
  );
  const d = discoverBehaviorClusters(rows, 3);
  assert.equal(d.sufficient, true);
  assert.ok(d.clusters.length >= 2);
});

test("evaluateDistributionalCalibration on synthetic holdout", () => {
  const estimates = Array.from({ length: 50 }, (_, i) => ({
    pHit1R: i > 25 ? 0.7 : 0.3,
    actualHit1R: i > 25 ? 1 : 0,
    pSlFirst: 0.3,
    actualSlFirst: 0,
    expectedR: 0.1,
    actualR: 0.05,
  }));
  const cal = evaluateDistributionalCalibration(estimates);
  assert.equal(cal.sufficient, true);
  assert.ok(cal.brier.pHit1R.score != null);
});
