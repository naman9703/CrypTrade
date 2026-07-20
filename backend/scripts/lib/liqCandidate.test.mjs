import test from "node:test";
import assert from "node:assert/strict";
import { computeForwardLabels, computeReach1RBeforeSl } from "../../src/strategy/techniques/liq/forwardLabels.js";

function mkCandles(n, trend = 1) {
  const out = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px;
    const c = o + trend * 0.3;
    out.push({ ts: i * 900_000, open: o, high: c + 0.2, low: o - 0.1, close: c, volume: 1000 });
    px = c;
  }
  return out;
}

test("computeForwardLabels tracks MFE, horizons, and firstHit", () => {
  const candles = mkCandles(30, 1);
  const pre = { atrSeries: new Array(30).fill(0.5) };
  const labels = computeForwardLabels(candles, 5, "BUY", 100, 99, pre, { opposingLevel: 102 });
  assert.ok(labels);
  assert.ok(labels.mfeR > 0);
  assert.equal(labels.hit1R_flag, 1);
  assert.ok(labels.fwd_mfeR_10 != null);
  assert.ok(labels.fwd_maeR_20 != null);
  assert.equal(labels.firstHit, "plus1R_first");
  assert.equal(labels.firstHit_plus1R, 1);
  assert.ok(labels.timeToMfeBars != null);
});

test("estimateOutcomeDistribution returns probability inputs", async () => {
  const { estimateOutcomeDistribution } = await import("../../src/strategy/techniques/liq/forwardLabels.js");
  const dist = estimateOutcomeDistribution({
    hit1R_flag: 1,
    hit2R_flag: 0,
    mfeR: 1.5,
    maeR: 0.3,
    fwd_closeR_20: 0.8,
    firstHit_plus1R: 1,
    timeToMfeBars: 4,
  });
  assert.equal(dist.pHit1R, 1);
  assert.equal(dist.expectedMfeR, 1.5);
});

test("computeReach1RBeforeSl returns 1 when 1R before SL", () => {
  const candles = mkCandles(20, 1);
  const r = computeReach1RBeforeSl(candles, 2, "BUY", 100, 99);
  assert.equal(r, 1);
});
