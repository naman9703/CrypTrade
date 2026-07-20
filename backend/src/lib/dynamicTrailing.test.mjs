import assert from "node:assert/strict";
import test from "node:test";
import {
  computeChandelierSl,
  computeDynamicAdvancedSl,
  computeDynamicInitialSlPct,
  computeDynamicRegimeMult,
  computeDynamicTrailBuffer,
  computeDynamicT01LockFrac,
  computeDynamicTieredMaxTrailStepFromExtreme,
  computeMfeRatchetSl,
  computePeakMfeR,
  parseDynamicAdvOpts,
  parseDynamicBeOpts,
  resolveTrailSizingMode,
} from "./dynamicTrailing.js";

test("resolveTrailSizingMode defaults to FIXED_PCT", () => {
  assert.equal(resolveTrailSizingMode({}), "FIXED_PCT");
  assert.equal(resolveTrailSizingMode({ trailSizingMode: "DYNAMIC" }), "DYNAMIC");
});

test("computeDynamicTrailBuffer scales with entry ATR", () => {
  const be = parseDynamicBeOpts({
    trailDynamicBeAtrMult: 0.5,
    trailDynamicMicroFloorMult: 0.5,
    trailDynamicBeRegimeAdjust: false,
  });
  const buf = computeDynamicTrailBuffer({ entryAtrPct: 0.02, dynamicBe: be, fallbackBufferRate: 0.001 });
  assert.equal(buf, 0.01);
});

test("computeDynamicTrailBuffer enforces absolute micro floor", () => {
  const be = parseDynamicBeOpts({ trailDynamicBeAtrMult: 0.5, trailDynamicBufferMinPct: 0.01 });
  const buf = computeDynamicTrailBuffer({ entryAtrPct: 0.008, dynamicBe: be });
  assert.equal(buf, 0.01);
});

test("computeDynamicInitialSlPct uses wider default for UNIFIED_ELITE", () => {
  const uni = computeDynamicInitialSlPct({ entryAtrPct: 0.012, cfg: { manualStrategy: "UNIFIED_ELITE" } });
  assert.ok(Math.abs(uni - 0.012 * 2.2) < 1e-9);
});

test("computeDynamicInitialSlPct scales ATR per coin", () => {
  const btc = computeDynamicInitialSlPct({ entryAtrPct: 0.012, cfg: {} });
  const doge = computeDynamicInitialSlPct({ entryAtrPct: 0.035, cfg: {} });
  assert.ok(Math.abs(btc - 0.012 * 1.1) < 1e-9);
  assert.equal(doge, 0.035 * 1.1);
  const calm = computeDynamicInitialSlPct({ entryAtrPct: 0.006, cfg: {} });
  assert.equal(calm, 0.01);
});

test("computeDynamicTrailBuffer applies regime multiplier", () => {
  const be = parseDynamicBeOpts({
    trailDynamicBeAtrMult: 1,
    trailDynamicBeRegimeAdjust: true,
    trailDynamicBeRegimeHighMult: 1.2,
  });
  const buf = computeDynamicTrailBuffer({ entryAtrPct: 0.03, dynamicBe: be });
  assert.ok(Math.abs(buf - 0.036) < 1e-9);
});

test("computeDynamicT01LockFrac uses ATR when mult > 0", () => {
  const frac = computeDynamicT01LockFrac({ entryAtrPct: 0.02, t01LockAtrMult: 0.1, fixedT01LockSlipFrac: 0 });
  assert.equal(frac, 0.002);
});

test("computeChandelierSl long trails below HWM", () => {
  const sl = computeChandelierSl({ isLong: true, hwm: 110, entryPx: 100, atrPct: 0.02, atrHwmMult: 1 });
  assert.equal(sl, 110 * (1 - 0.02));
});

test("computeMfeRatchetSl activates after min R", () => {
  const sl = computeMfeRatchetSl({
    isLong: true,
    entryPx: 100,
    initialRiskFrac: 0.01,
    peakMfeR: 2,
    mfeGivebackFrac: 0.25,
    mfeMinR: 1,
  });
  assert.ok(Math.abs(Number(sl) - 101.5) < 1e-9);
});

test("computeDynamicAdvancedSl hybrid picks max for long", () => {
  const adv = parseDynamicAdvOpts({ trailDynamicAdvAtrHwmMult: 1, trailDynamicAdvMfeGivebackFrac: 0.25 });
  const sl = computeDynamicAdvancedSl({
    isLong: true,
    hwm: 110,
    entryPx: 100,
    atrPct: 0.02,
    stLine: 105,
    prevSl: 100,
    feeBeFloor: 100.08,
    initialRiskFrac: 0.01,
    peakMfeR: 2,
    dynamicAdv: adv,
  });
  assert.equal(sl, 110 * (1 - 0.02));
});

test("computePeakMfeR", () => {
  assert.equal(computePeakMfeR({ isLong: true, entryPx: 100, hwm: 102, initialRiskFrac: 0.01 }), 2);
});

test("computeDynamicTieredMaxTrailStepFromExtreme crosses T01/T02 gates", () => {
  const step = computeDynamicTieredMaxTrailStepFromExtreme({
    hwm: 101,
    entryPx: 100,
    isLong: true,
    feeBe: 0.0008,
    bufferRate: 0.001,
    useFeeBeTrail: true,
    entryAtrPct: 0.02,
    postT02StepAtrMult: 0.5,
    maxActivationSteps: 10,
  });
  assert.ok(step >= 2);
});
