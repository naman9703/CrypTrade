import test from "node:test";
import assert from "node:assert/strict";
import {
  computeLiveFidelity,
  computeGrade,
  gradeCoinSuitability,
  pickBestCandidate,
  variantBreaks,
  variantHasNoEffect,
  scenarioSurvived,
  SAFETY_LIMITS,
} from "./strategyTest.js";

/* ───────────────────────────── fidelity scoring ───────────────────────────── */

const GOOD_INPUTS = {
  takerFeeRate: 0.0005,
  slippagePct: 0.0005,
  gateMode: "off",
  coveragePct: 100,
  totalTrades: 250,
  wfDegradationPct: 10,
  mcP5ReturnPct: 5,
  mcP50ReturnPct: 20,
  paramBreakRatePct: 5,
  feesOverGrossPct: 15,
  usesMlAdapter: false,
};

test("fidelity: perfect inputs score 100, factors sum to score", () => {
  const f = computeLiveFidelity(GOOD_INPUTS);
  assert.equal(f.score, 100);
  const sum = f.factors.reduce((s, x) => s + x.score, 0);
  assert.ok(Math.abs(sum - f.score) < 0.01, "factors sum to score");
  const maxSum = f.factors.reduce((s, x) => s + x.max, 0);
  assert.equal(maxSum, 100, "factor maxima sum to 100");
});

test("fidelity: worst inputs bounded at >= 0", () => {
  const f = computeLiveFidelity({
    takerFeeRate: 0,
    slippagePct: 0,
    gateMode: "approx",
    coveragePct: 0,
    totalTrades: 2,
    wfDegradationPct: 90,
    mcP5ReturnPct: -50,
    mcP50ReturnPct: -10,
    paramBreakRatePct: 100,
    feesOverGrossPct: 200,
    usesMlAdapter: true,
  });
  assert.ok(f.score >= 0 && f.score < 25, `expected low score, got ${f.score}`);
  for (const factor of f.factors) {
    assert.ok(factor.score >= 0 && factor.score <= factor.max, `${factor.id} within [0,max]`);
    assert.ok(typeof factor.note === "string" && factor.note.length > 0, `${factor.id} has explanation`);
  }
});

test("fidelity: zero costs and approx gate are penalized", () => {
  const base = computeLiveFidelity(GOOD_INPUTS);
  const noCosts = computeLiveFidelity({ ...GOOD_INPUTS, takerFeeRate: 0, slippagePct: 0 });
  const approxGate = computeLiveFidelity({ ...GOOD_INPUTS, gateMode: "approx" });
  assert.ok(noCosts.score < base.score - 10, "zero-cost penalized heavily");
  assert.ok(approxGate.score < base.score, "approx gate penalized");
});

test("fidelity: unknown inputs degrade gracefully", () => {
  const f = computeLiveFidelity({});
  assert.ok(Number.isFinite(f.score) && f.score >= 0 && f.score <= 100);
});

/* ─────────────────────────────── grading rubric ───────────────────────────── */

const PASS_GATES = {
  allPass: true,
  gates: {
    oosPositive: { pass: true, value: 10, threshold: "> 0%" },
    mcP5Positive: { pass: true, value: 3, threshold: "> 0%" },
    calmarOver1: { pass: true, value: 1.5, threshold: "> 1" },
    wfDegradationOk: { pass: true, value: 20, threshold: "< 35%" },
  },
};

function failGates(...keys) {
  const g = JSON.parse(JSON.stringify(PASS_GATES));
  for (const k of keys) g.gates[k].pass = false;
  g.allPass = false;
  return g;
}

const HEALTHY = {
  gates: PASS_GATES,
  stressSurvivedAll: true,
  ruinObserved: false,
  paramBreakRatePct: 10,
  oosReturnPct: 10,
  mcP5ReturnPct: 3,
};

test("grade A: all gates + stress + stable params", () => {
  assert.equal(computeGrade(HEALTHY).grade, "A");
});

test("grade B: gates pass but stress fails", () => {
  const r = computeGrade({ ...HEALTHY, stressSurvivedAll: false });
  assert.equal(r.grade, "B");
  assert.ok(r.reasons.some((x) => x.toLowerCase().includes("stress")));
});

test("grade B: gates pass but params unstable", () => {
  assert.equal(computeGrade({ ...HEALTHY, paramBreakRatePct: 60 }).grade, "B");
});

test("grade C: exactly one gate fails", () => {
  const r = computeGrade({ ...HEALTHY, gates: failGates("calmarOver1") });
  assert.equal(r.grade, "C");
});

test("grade F: two gates fail", () => {
  const r = computeGrade({ ...HEALTHY, gates: failGates("calmarOver1", "wfDegradationOk") });
  assert.equal(r.grade, "F");
});

test("grade F: ruin observed trumps everything", () => {
  const r = computeGrade({ ...HEALTHY, ruinObserved: true });
  assert.equal(r.grade, "F");
});

test("grade F: negative OOS and negative MC p5", () => {
  const r = computeGrade({
    ...HEALTHY,
    gates: failGates("oosPositive", "mcP5Positive"),
    oosReturnPct: -5,
    mcP5ReturnPct: -10,
  });
  assert.equal(r.grade, "F");
});

/* ───────────────────────── breaks / survival helpers ─────────────────────── */

test("variantBreaks: sign flip and >50% degradation break", () => {
  assert.equal(variantBreaks(10, -1), true, "sign flip");
  assert.equal(variantBreaks(10, 4), true, ">50% degradation");
  assert.equal(variantBreaks(10, 6), false, "<50% degradation ok");
  assert.equal(variantBreaks(10, 12), false, "improvement ok");
  assert.equal(variantBreaks(10, null), true, "missing variant = break");
});

test("variantHasNoEffect: identical metrics = engine clamped the param", () => {
  const base = { totalTrades: 50, totalReturnPct: 123.456, maxDrawdownPct: 10.5 };
  assert.equal(variantHasNoEffect(base, { ...base }), true, "bit-identical = no effect");
  assert.equal(
    variantHasNoEffect(base, { ...base, totalReturnPct: 123.5 }),
    false,
    "different return = real variant",
  );
  assert.equal(
    variantHasNoEffect(base, { ...base, totalTrades: 51 }),
    false,
    "different trade count = real variant",
  );
  assert.equal(variantHasNoEffect(base, null), false, "missing variant handled");
});

test("scenarioSurvived: equity halved or DD >= 50 fails", () => {
  assert.equal(scenarioSurvived({ finalEquity: 400, startingEquity: 1000, maxDrawdownPct: 20 }), false);
  assert.equal(scenarioSurvived({ finalEquity: 900, startingEquity: 1000, maxDrawdownPct: 55 }), false);
  assert.equal(scenarioSurvived({ finalEquity: 900, startingEquity: 1000, maxDrawdownPct: 20 }), true);
});

/* ───────────────────────────── suggestion engine ──────────────────────────── */

test("pickBestCandidate: max return within safety limits", () => {
  const candidates = [
    { label: "risky", totalReturnPct: 80, maxDrawdownPct: 40, mcP5ReturnPct: 5, riskOfRuinPct: 0.1 },
    { label: "best-safe", totalReturnPct: 30, maxDrawdownPct: 12, mcP5ReturnPct: 2, riskOfRuinPct: 0.2 },
    { label: "weak", totalReturnPct: 10, maxDrawdownPct: 5, mcP5ReturnPct: 1, riskOfRuinPct: 0 },
    { label: "lucky", totalReturnPct: 50, maxDrawdownPct: 10, mcP5ReturnPct: -2, riskOfRuinPct: 0.5 },
  ];
  const best = pickBestCandidate(candidates, SAFETY_LIMITS);
  assert.equal(best.label, "best-safe");
});

test("gradeCoinSuitability: PASS / MARGINAL / SKIP", () => {
  assert.equal(gradeCoinSuitability({ grade: "A", oosReturnPct: 10, mcP5ReturnPct: 1, maxDrawdownPct: 8 }), "PASS");
  assert.equal(gradeCoinSuitability({ grade: "B", oosReturnPct: 3, mcP5ReturnPct: 0.5, maxDrawdownPct: 20 }), "MARGINAL");
  assert.equal(gradeCoinSuitability({ grade: "F", oosReturnPct: 5, mcP5ReturnPct: 1, maxDrawdownPct: 10 }), "SKIP");
  assert.equal(gradeCoinSuitability({ grade: "B", oosReturnPct: -2, mcP5ReturnPct: 1, maxDrawdownPct: 10 }), "SKIP");
});

test("pickBestCandidate: returns null when nothing is safe", () => {
  const best = pickBestCandidate([
    { label: "a", totalReturnPct: 80, maxDrawdownPct: 40, mcP5ReturnPct: 5, riskOfRuinPct: 0.1 },
    { label: "b", totalReturnPct: 20, maxDrawdownPct: 10, mcP5ReturnPct: -1, riskOfRuinPct: 0.1 },
  ]);
  assert.equal(best, null);
});
