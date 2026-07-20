import test from "node:test";
import assert from "node:assert/strict";
import { recordTrailAdvance } from "./trailEventLog.js";

test("recordTrailAdvance appends step with next activation gate", () => {
  const pos = {
    side: "BUY",
    entryFill: 100,
    sl: 99,
    extremePx: 100.6,
    trailEvents: [],
  };
  const opts = {
    feeBeSt: 0.001,
    bufferRate: 0.0005,
    postT02BufferRate: null,
    useFeeBeTrail: true,
    roundTripFeeR: 0.0008,
    postT02SpacingFrac: null,
  };
  recordTrailAdvance(pos, {
    ts: 1_000,
    advRes: { advanced: true, proposedSl: 99.5, trailStep: 1, tierLabel: "T01" },
    opts,
  });
  assert.equal(pos.trailEvents.length, 1);
  assert.equal(pos.trailEvents[0].step, 1);
  assert.equal(pos.trailEvents[0].tierLabel, "T01");
  assert.equal(pos.trailEvents[0].slPrice, 99.5);
  assert.equal(pos.trailEvents[0].favorablePx, 100.6);
  assert.ok(Number.isFinite(pos.trailEvents[0].nextActivationPx));
});

test("recordTrailAdvance dedupes identical step+sl", () => {
  const pos = { side: "BUY", entryFill: 100, sl: 99.5, extremePx: 100.6, trailEvents: [] };
  const advRes = { advanced: true, proposedSl: 99.5, trailStep: 1, tierLabel: "T01" };
  recordTrailAdvance(pos, { ts: 1_000, advRes, opts: {} });
  recordTrailAdvance(pos, { ts: 2_000, advRes, opts: {} });
  assert.equal(pos.trailEvents.length, 1);
});
