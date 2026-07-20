import test from "node:test";
import assert from "node:assert/strict";
import {
  assessRunParity,
  classifyNegativeResult,
  FAMILY_LIFECYCLE,
  FAMILY_A_RESEARCH_BASELINE,
} from "./familyLifecycle.js";
import {
  interpretFalsificationResults,
  FALS_OUTCOMES,
  FALS_001_SUMMARY_NO_PROMOTION,
} from "./falsificationInterpretation.js";

test("assessRunParity confirms full Family A baseline", () => {
  const p = assessRunParity({
    from: FAMILY_A_RESEARCH_BASELINE.from,
    to: FAMILY_A_RESEARCH_BASELINE.to,
    coins: FAMILY_A_RESEARCH_BASELINE.coins,
    timeframe: "15m",
    dataSource: "timescale",
  });
  assert.equal(p.parityWithFamilyA, true);
});

test("assessRunParity rejects quick REST run", () => {
  const p = assessRunParity({
    from: "2024-01-01",
    to: "2026-06-01",
    coins: ["BTCUSDT", "ETHUSDT"],
    timeframe: "15m",
    dataSource: "rest",
  });
  assert.equal(p.parityWithFamilyA, false);
});

test("classifyNegativeResult provisional without parity", () => {
  assert.equal(
    classifyNegativeResult({ parityWithFamilyA: false, promoted: 0, experimentsRun: 6 }),
    FAMILY_LIFECYCLE.PROVISIONAL_NEGATIVE,
  );
});

test("classifyNegativeResult confirmed with parity", () => {
  assert.equal(
    classifyNegativeResult({ parityWithFamilyA: true, promoted: 0, experimentsRun: 6 }),
    FAMILY_LIFECYCLE.CONFIRMED_NEGATIVE,
  );
});

test("FALS all failed does not assume weak formulation only", () => {
  const r = interpretFalsificationResults({
    familiesTested: 3,
    familiesPassed: 0,
    priceDerivedFamiliesFailed: 3,
    familyCResult: "failed",
    familyDResult: "failed",
    anyHoldoutSlicePositive: true,
    runParity: assessRunParity({
      from: FAMILY_A_RESEARCH_BASELINE.from,
      to: FAMILY_A_RESEARCH_BASELINE.to,
      coins: FAMILY_A_RESEARCH_BASELINE.coins,
      dataSource: "timescale",
    }),
  });
  assert.equal(r.outcome, FALS_OUTCOMES.NO_PRICE_DERIVED_PROMOTION);
  assert.equal(r.summary, FALS_001_SUMMARY_NO_PROMOTION);
  assert.ok(r.cases?.insufficientInformation?.includes("plausible"));
  assert.ok(!r.interpretations.some((i) => i.includes("Case B likely")));
  assert.ok(r.nextSteps[0].action.includes("OI + funding"));
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
