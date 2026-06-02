import test from "node:test";
import assert from "node:assert/strict";
import { rankSmcCandidate, reclaimBodyStrength, rankSmcCycle } from "./smcCandidateRank.js";

function bar(o, h, l, c) {
  return { open: o, high: h, low: l, close: c, volume: 1, ts: 0 };
}

test("reclaimBodyStrength — directional body ratio", () => {
  const candles = [bar(100, 105, 99, 104.5)]; // bullish ~5/6 body
  assert.ok(reclaimBodyStrength(candles, 0, "BUY") > 0.65);
  assert.equal(reclaimBodyStrength(candles, 0, "SELL"), 0);
});

test("rankSmcCandidate — deeper extension loses to CHoCH + FVG + reclaim", () => {
  const weakExt = {
    score: 8,
    sig: {
      action: "BUY",
      liqBrackets: { rr: 1.5 },
      smcMeta: {
        sweepExtensionPct: 0.01,
        sweepReclaimIdx: 0,
        reclaimBodyRatio: 0.3,
        chochIdx: null,
        fvgTop: null,
        fvgBottom: null,
      },
    },
  };
  const strongIct = {
    score: 8,
    sig: {
      action: "BUY",
      liqBrackets: { rr: 1.5 },
      smcMeta: {
        sweepExtensionPct: 0.002,
        sweepReclaimIdx: 0,
        reclaimBodyRatio: 0.8,
        chochIdx: 5,
        fvgTop: 101,
        fvgBottom: 100,
      },
    },
  };
  assert.ok(rankSmcCandidate(strongIct) > rankSmcCandidate(weakExt));
});

test("rankSmcCycle — penalizes extension", () => {
  const cycShallow = { extension: 0.001, levelType: "pdl" };
  const cycDeep = { extension: 0.015, levelType: "pdl" };
  const ctx = { inZone: true, chochIdx: 3, fvg: {}, ob: null, brackets: { rr: 1.5 }, reclaimIdx: 0 };
  const candles = [bar(100, 105, 99, 104)];
  assert.ok(
    rankSmcCycle(candles, "BUY", cycShallow, ctx) > rankSmcCycle(candles, "BUY", cycDeep, ctx),
  );
});
