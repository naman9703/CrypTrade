import test from "node:test";
import assert from "node:assert/strict";
import { benjaminiHochberg } from "./liqResearchStats.js";
import { evaluatePromotion, LAYER } from "./liqPromotionPolicy.js";

test("benjaminiHochberg controls false discovery rate", () => {
  const tests = [
    { id: "A", pValue: 0.001 },
    { id: "B", pValue: 0.04 },
    { id: "C", pValue: 0.3 },
    { id: "D", pValue: 0.8 },
  ];
  const out = benjaminiHochberg(tests, 0.1);
  assert.equal(out[0].fdrSignificant, true);
  assert.equal(out[3].fdrSignificant, false);
});

test("evaluatePromotion blocks weak evidence", () => {
  const r = evaluatePromotion({ n: 50, monotonicity: 0.1, bucketSpread: 0.05, permutationP: 0.5 }, LAYER.EXPERIMENTAL);
  assert.equal(r.passed, false);
  assert.ok(r.failed.length > 0);
});
