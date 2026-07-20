import test from "node:test";
import assert from "node:assert/strict";
import {
  canTestAtLevels,
  untestableLevels,
  MISSION_STATEMENT,
  RESEARCH_PHASE,
  PHASE_STANDARDS,
  classifyHypothesisRequirements,
} from "./informationHierarchy.js";

test("canTestAtLevels L0-L1 and L2 available", () => {
  assert.equal(canTestAtLevels(["L0", "L1"]), true);
  assert.equal(canTestAtLevels(["L2"]), true);
  assert.equal(canTestAtLevels(["L3"]), false);
});

test("untestableLevels returns L3 when required", () => {
  assert.deepEqual(untestableLevels(["L0", "L3"]), ["L3"]);
});

test("exploration has lower bar than validation", () => {
  assert.ok(PHASE_STANDARDS[RESEARCH_PHASE.EXPLORATION].minCandidates < PHASE_STANDARDS[RESEARCH_PHASE.VALIDATION].minCandidates);
  assert.equal(PHASE_STANDARDS[RESEARCH_PHASE.EXPLORATION].fdrRequired, false);
  assert.equal(PHASE_STANDARDS[RESEARCH_PHASE.VALIDATION].fdrRequired, true);
});

test("mission statement addresses observable information", () => {
  assert.ok(MISSION_STATEMENT.includes("observable"));
});

test("exploration optimizes information gain, validation decision quality", () => {
  assert.equal(PHASE_STANDARDS[RESEARCH_PHASE.EXPLORATION].optimizesFor, "expected_information_gain");
  assert.equal(PHASE_STANDARDS[RESEARCH_PHASE.VALIDATION].optimizesFor, "expected_decision_quality");
});

test("classifyHypothesisRequirements includes latency", () => {
  const c = classifyHypothesisRequirements({ levels: ["L3"] });
  assert.equal(c.testable, false);
  assert.equal(c.latencyLabel, "Milliseconds");
});
