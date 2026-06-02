import test from "node:test";
import assert from "node:assert/strict";
import { isInstitutionalSrMode } from "./evaluateInstitutionalSr.js";

test("isInstitutionalSrMode", () => {
  assert.equal(isInstitutionalSrMode({ intradaySrAPlusMode: true }), true);
  assert.equal(isInstitutionalSrMode({ intradayGateInstitutionalSr: true }), true);
  assert.equal(isInstitutionalSrMode({}), false);
});
