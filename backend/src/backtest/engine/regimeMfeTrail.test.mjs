import assert from "node:assert/strict";
import test from "node:test";
import {
  priorReturnByMs,
  isChopPriorReturn,
  computeMfeGivebackSl,
  readChopMfeTrailCfg,
} from "./regimeMfeTrail.js";

test("priorReturnByMs measures signed drift", () => {
  const candles = [];
  const day = 86_400_000;
  for (let i = 0; i < 70; i++) {
    candles.push({ ts: i * day, close: 100 + i });
  }
  const r = priorReturnByMs(candles, 65, 60 * day);
  assert.ok(r != null && r > 0);
});

test("isChopPriorReturn", () => {
  assert.equal(isChopPriorReturn(0.02, 0.05), true);
  assert.equal(isChopPriorReturn(-0.12, 0.05), false);
  assert.equal(isChopPriorReturn(null, 0.05), false);
});

test("computeMfeGivebackSl locks fraction of MFE", () => {
  // MFE 2%, giveback 35% → lock 1.3% above entry for long
  const sl = computeMfeGivebackSl({
    isLong: true,
    entryPx: 100,
    peakMfePct: 0.02,
    givebackFrac: 0.35,
    activatePct: 0.01,
    prevSl: 98.8,
  });
  assert.ok(sl != null);
  assert.ok(Math.abs(sl - 101.3) < 1e-9);
});

test("computeMfeGivebackSl inactive below activate", () => {
  const sl = computeMfeGivebackSl({
    isLong: false,
    entryPx: 100,
    peakMfePct: 0.005,
    activatePct: 0.01,
  });
  assert.equal(sl, null);
});

test("readChopMfeTrailCfg defaults off", () => {
  assert.equal(readChopMfeTrailCfg({}).enabled, false);
  assert.equal(readChopMfeTrailCfg({ backtestChopMfeTrail: true }).enabled, true);
  assert.equal(readChopMfeTrailCfg({ backtestChopMfeTrail: true }).sides, "BOTH");
  assert.equal(
    readChopMfeTrailCfg({ backtestChopMfeTrail: true, backtestChopMfeTrailSides: "SELL" }).sides,
    "SELL",
  );
});
