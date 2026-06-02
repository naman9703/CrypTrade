import test from "node:test";
import assert from "node:assert/strict";
import { fixedBracketSlEnabled, fixedBracketTpEnabled } from "./bracketToggles.js";

test("fixedBracket toggles default on", () => {
  assert.equal(fixedBracketSlEnabled({}), true);
  assert.equal(fixedBracketTpEnabled({}), true);
});

test("fixedBracket toggles respect explicit false", () => {
  assert.equal(fixedBracketSlEnabled({ supertrendFuturesUseFixedSl: false }), false);
  assert.equal(fixedBracketTpEnabled({ supertrendFuturesUseFixedTp: false }), false);
});
