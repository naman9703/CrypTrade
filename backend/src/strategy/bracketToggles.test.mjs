import test from "node:test";
import assert from "node:assert/strict";
import {
  fixedBracketSlEnabled,
  fixedBracketTpEnabled,
  techniqueStructureBracketsActive,
  bracketSlLegsEnabled,
  bracketTpLegsEnabled,
} from "./bracketToggles.js";

test("fixedBracket toggles default on", () => {
  assert.equal(fixedBracketSlEnabled({}), true);
  assert.equal(fixedBracketTpEnabled({}), true);
});

test("fixedBracket toggles respect explicit false", () => {
  assert.equal(fixedBracketSlEnabled({ supertrendFuturesUseFixedSl: false }), false);
  assert.equal(fixedBracketTpEnabled({ supertrendFuturesUseFixedTp: false }), false);
});

test("structure liquidity brackets stay enabled when panel fixed TP is off", () => {
  const sig = { liqBrackets: { slPct: 0.01, tpPct: 0.02 } };
  const cfg = { supertrendFuturesUseFixedTp: false };
  assert.equal(techniqueStructureBracketsActive(sig, cfg), true);
  assert.equal(bracketTpLegsEnabled(cfg, sig), true);
  assert.equal(bracketSlLegsEnabled(cfg, sig), true);
});

test("VP structure TP follows panel TP Off (trail-only)", () => {
  const sig = { vpBrackets: { slPct: 0.012, tpPct: 0.03 } };
  const cfg = { supertrendFuturesUseFixedTp: false, intradayVpBrackets: true };
  assert.equal(techniqueStructureBracketsActive(sig, cfg), true);
  assert.equal(bracketSlLegsEnabled(cfg, sig), true);
  assert.equal(bracketTpLegsEnabled(cfg, sig), false);
});

test("VP structure TP arms when panel TP On", () => {
  const sig = { vpBrackets: { slPct: 0.012, tpPct: 0.03 } };
  const cfg = { supertrendFuturesUseFixedTp: true, intradayVpBrackets: true };
  assert.equal(bracketTpLegsEnabled(cfg, sig), true);
});
