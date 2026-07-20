import test from "node:test";
import assert from "node:assert/strict";
import {
  DECISION_PROBLEMS,
  DECISION_YIELD_REGISTRY,
  GOVERNANCE_LITMUS,
  PHASE_3_PRIORITY,
  YIELD_VERDICT,
} from "./decisionYield.js";
import { INFORMATION_YIELD_REGISTRY, PHASE_2B_FALSIFIED_PROPOSITION } from "./informationYield.js";
import { DECISION_QUALITY_DIMENSIONS, PHASE_3_SCIENTIFIC_STANDARD } from "./decisionQuality.js";
import { NULL_POLICY, PORTFOLIO_LEVER_PROBE_ORDER } from "./portfolioPolicy.js";
import { PLATFORM_PRINCIPLE, PHASE_3_INCREMENTAL_EXPERIMENTS, PHASE_3_POLICY_BASELINES, PHASE_3_VALUE_STANDARD } from "./phase3Standards.js";
import { isCredibleProxyForSymbol, PROXY_FIDELITY_BY_SYMBOL } from "./proxyFidelity.js";

test("ranking temporarily saturated; phase 3 areas unknown yield", () => {
  assert.equal(DECISION_PROBLEMS.RANKING.status, "temporarily_saturated");
  const port = DECISION_YIELD_REGISTRY.find((r) => r.backlogId === "PORT-001");
  const funding = DECISION_YIELD_REGISTRY.find((r) => r.researchArea.includes("Funding"));
  assert.equal(port.decisionYield, YIELD_VERDICT.UNKNOWN);
  assert.equal(funding.decisionYield, YIELD_VERDICT.NONE);
});

test("funding and bybit OI registered as zero yield", () => {
  const funding = INFORMATION_YIELD_REGISTRY.find((r) => r.source.includes("funding"));
  const bybit = INFORMATION_YIELD_REGISTRY.find((r) => r.source.includes("Bybit"));
  assert.equal(funding.incrementalDecisionQuality, YIELD_VERDICT.NONE);
  assert.equal(bybit.incrementalDecisionQuality, YIELD_VERDICT.NONE);
});

test("per-symbol proxy fidelity matches validation tiers", () => {
  assert.equal(isCredibleProxyForSymbol("ETHUSDT"), true);
  assert.equal(isCredibleProxyForSymbol("BTCUSDT"), false);
  assert.equal(PROXY_FIDELITY_BY_SYMBOL.SOLUSDT.pearsonOi, 0.861);
});

test("falsified proposition is scoped to families A/C/D", () => {
  assert.match(PHASE_2B_FALSIFIED_PROPOSITION, /Families A/);
  assert.match(PHASE_2B_FALSIFIED_PROPOSITION, /candidate discrimination/);
});

test("governance litmus is actionable", () => {
  assert.match(GOVERNANCE_LITMUS, /trading decision/);
});

test("phase 3 portfolio policy and platform principle", () => {
  assert.equal(NULL_POLICY.id, "null");
  assert.deepEqual(PORTFOLIO_LEVER_PROBE_ORDER, ["allocation", "overlap", "abstention", "sizing"]);
  assert.match(PLATFORM_PRINCIPLE, /complete portfolio/);
  assert.match(PHASE_3_VALUE_STANDARD, /demonstrably improves/);
  assert.ok(PHASE_3_POLICY_BASELINES.some((p) => p.lever === "null" && p.isUltimateBaseline));
  assert.equal(PHASE_3_INCREMENTAL_EXPERIMENTS.length, 4);
});

test("phase 3 priority centers on portfolio policy", () => {
  assert.equal(PHASE_3_PRIORITY[0], "PORT-000");
  assert.equal(DECISION_QUALITY_DIMENSIONS.length, 4);
  assert.match(PHASE_3_SCIENTIFIC_STANDARD, /baseline/);
});
