import test from "node:test";
import assert from "node:assert/strict";
import {
  trainExpectedOutcomeEstimator,
  estimateCandidateOutcome,
  evaluateEstimator,
} from "./expectedOutcomeEstimator.js";
import { applyDecisionPolicy, compareDecisionPolicies, oraclePredictability } from "./decisionPolicy.js";

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
    ...overrides,
  };
}

test("trainExpectedOutcomeEstimator builds calibrators", () => {
  const train = Array.from({ length: 40 }, (_, i) =>
    row({
      candidateKey: `k${i}`,
      cont_score: i / 40,
      fwd_closeR_20: i < 20 ? -0.2 : 0.6,
    }),
  );
  const model = trainExpectedOutcomeEstimator(train);
  assert.ok(Object.keys(model.calibrators).length > 0);
});

test("estimateCandidateOutcome returns inspectable contributions", () => {
  const train = Array.from({ length: 50 }, (_, i) =>
    row({
      candidateKey: `k${i}`,
      dayId: i % 5,
      cont_score: i / 50,
      fwd_closeR_20: i / 50,
    }),
  );
  const model = trainExpectedOutcomeEstimator(train);
  const est = estimateCandidateOutcome(row({ cont_score: 0.9 }), model);
  assert.ok(est.expectedR != null);
  assert.ok(est.contributions.length > 0);
  assert.ok(est.explanation.length > 0);
});

test("applyDecisionPolicy picks max EU per day-side", () => {
  const candidates = [
    { candidateKey: "a", symbol: "BTCUSDT", dayId: 1, side: "BUY", expectedUtility: 0.1, weightedQuality: 90 },
    { candidateKey: "b", symbol: "BTCUSDT", dayId: 1, side: "BUY", expectedUtility: 0.5, weightedQuality: 60 },
  ];
  const out = applyDecisionPolicy(candidates, "max_expected_utility");
  assert.equal(out.find((c) => c.candidateKey === "b").selectedByPolicy, 1);
  assert.equal(out.find((c) => c.candidateKey === "a").selectedByPolicy, 0);
});

test("oraclePredictability counts correct top picks", () => {
  const groups = [
    [
      { candidateKey: "a", expectedR: 0.2, expectedUtility: 0.1, fwd_closeR_20: 0.1 },
      { candidateKey: "b", expectedR: 0.8, expectedUtility: 0.9, fwd_closeR_20: 1.0 },
    ],
    [
      { candidateKey: "c", expectedR: 0.9, expectedUtility: 0.9, fwd_closeR_20: -0.1 },
      { candidateKey: "d", expectedR: 0.1, expectedUtility: 0.2, fwd_closeR_20: 0.5 },
    ],
  ];
  const r = oraclePredictability(groups);
  assert.equal(r.multiCandidateDays, 2);
  assert.equal(r.oraclePredictedCorrectly, 1);
});

test("evaluateEstimator computes rank correlation", () => {
  const estimates = Array.from({ length: 30 }, (_, i) => ({
    expectedR: i / 30,
    actualR: i / 30 + (i % 3 === 0 ? 0.05 : -0.05),
  }));
  const ev = evaluateEstimator(estimates);
  assert.equal(ev.sufficient, true);
  assert.ok(ev.rankCorrelation > 0.5);
});
