import test from "node:test";
import assert from "node:assert/strict";
import { rankDataInvestments } from "./informationValueMatrix.js";
import { planInformationAcquisition } from "./informationAcquisitionPlanner.js";
import { UOA_OUTCOMES } from "./informationHierarchy.js";

test("rankResearchInvestments prefers high value low cost", () => {
  const ranked = rankDataInvestments();
  assert.ok(ranked[0].investment.includes("Funding") || ranked[0].investment.includes("OI"));
});

test("acquisition planner blocks until falsification complete", () => {
  const plan = planInformationAcquisition({ l0l1FalsificationComplete: false });
  assert.ok(plan.blockers.includes("fals_001_pending"));
});

test("acquisition after universal failure suggests OI not only L3 book", () => {
  const plan = planInformationAcquisition({
    l0l1FalsificationComplete: true,
    falsificationFamiliesTested: 2,
    falsificationFamiliesPassed: 0,
  });
  assert.ok(plan.rankedInvestments.some((r) => r.investment.includes("OI")));
});
