import test from "node:test";
import assert from "node:assert/strict";
import {
  isTrailMicroEnabled,
  resolveTrailMicroTf,
  simulateTrailingForParentBar,
  TrailMicroBarLoader,
} from "./trailMicroSim.js";
import { resolveTrailingOpts, resolveTrailActivationOn } from "./trailingSim.js";
import { resolveCostModel } from "./costModel.js";

const FUTURES_CFG = {
  marketMode: "FUTURES",
  futuresLeverage: 20,
  trailingStopLossAuto: true,
  futuresTrailingStopMode: "SUPERTREND",
  trailBufferRate: 0.0015,
  trailPostT02SpacingFrac: 0.001,
  supertrendUseFeeBreakeven: true,
  supertrendUseAdvancedTrail: true,
  trailT01LockSlippageFrac: 0.0002,
  tradeHistoryTakerOpenFeeRate: 0.0005,
  tradeHistoryTakerCloseFeeRate: 0.0005,
};

test("isTrailMicroEnabled defaults on for futures trailing", () => {
  assert.equal(isTrailMicroEnabled({}, { trailEnabled: true }), true);
  assert.equal(isTrailMicroEnabled({ backtestTrailMicroTf: "off" }, { trailEnabled: true }), false);
  assert.equal(isTrailMicroEnabled({}, { trailEnabled: false }), false);
});

test("resolveTrailMicroTf accepts 5m and off", () => {
  assert.equal(resolveTrailMicroTf({ backtestTrailMicroTf: "5m" }), "5m");
  assert.equal(resolveTrailMicroTf({ backtestTrailMicroTf: "off" }), "off");
  assert.equal(resolveTrailMicroTf({}), "1m");
});

test("resolveTrailActivationOn: wick for 1m, close for higher TF", () => {
  assert.equal(resolveTrailActivationOn("1m"), "wick");
  assert.equal(resolveTrailActivationOn("5m"), "close");
  assert.equal(resolveTrailActivationOn("15m"), "close");
});

test("micro replay activates T01 on second 1m bar inside parent hour", () => {
  const cm = resolveCostModel(FUTURES_CFG);
  const opts = resolveTrailingOpts(FUTURES_CFG, cm, null);
  const entry = 100;
  const pos = {
    side: "BUY",
    entryFill: entry,
    sl: entry * (1 - 0.003),
    tp: entry * (1 + 0.1),
    trailStep: 0,
    extremePx: entry,
    trailTierLabel: null,
    beLocked: false,
  };

  const parentTs = 3_600_000;
  const microBars = [
    { ts: parentTs, open: 100, high: 100.08, low: 99.99, close: 100.01 },
    { ts: parentTs + 60_000, open: 100.01, high: 100.22, low: 100.05, close: 100.18 },
  ];

  const r1 = simulateTrailingForParentBar({
    pos,
    parentBar: { ts: parentTs, open: 100, high: 100.18, low: 99.98, close: 100.16 },
    microBars: [microBars[0]],
    stBar: null,
    opts,
    mode: "SUPERTREND",
    leverage: cm.leverage,
  });
  assert.equal(r1.exit, null);
  assert.equal(r1.pos.trailStep, 0, "first minute alone should not reach T01");

  const r2 = simulateTrailingForParentBar({
    pos: { ...pos, trailStep: r1.pos.trailStep, extremePx: r1.pos.extremePx, sl: r1.pos.sl, trailEvents: [] },
    parentBar: { ts: parentTs, open: 100, high: 100.22, low: 100.0, close: 100.18 },
    microBars,
    stBar: null,
    opts,
    mode: "SUPERTREND",
    leverage: cm.leverage,
  });
  assert.equal(r2.exit, null);
  assert.ok(r2.pos.trailStep >= 1, "second minute high should trigger tiered trail");
  assert.ok(r2.pos.sl > entry * (1 - 0.003));
  assert.ok(Array.isArray(r2.pos.trailEvents) && r2.pos.trailEvents.length >= 1);
  const ev = r2.pos.trailEvents[0];
  assert.ok(ev.step >= 1);
  assert.ok(Number.isFinite(ev.slPrice));
  assert.ok(ev.nextActivationPx == null || Number.isFinite(ev.nextActivationPx));
});

test("5m close mode: wick reaches tier but close does not — no activation", () => {
  const cm = resolveCostModel(FUTURES_CFG);
  const opts = {
    ...resolveTrailingOpts(FUTURES_CFG, cm, null),
    trailActivationOn: "close",
  };
  const entry = 100;
  const pos = {
    side: "BUY",
    entryFill: entry,
    sl: entry * (1 - 0.003),
    tp: entry * (1 + 0.1),
    trailStep: 0,
    extremePx: entry,
    trailTierLabel: null,
    beLocked: false,
  };

  const parentTs = 0;
  const microBars = [
    {
      ts: parentTs,
      open: entry,
      high: entry * 1.0025,
      low: entry * 0.999,
      close: entry * 1.0005,
    },
  ];

  const r = simulateTrailingForParentBar({
    pos,
    parentBar: { ts: parentTs, open: entry, high: entry * 1.0025, low: entry * 0.999, close: entry * 1.0005 },
    microBars,
    stBar: null,
    opts,
    mode: "SUPERTREND",
    leverage: cm.leverage,
    microTfMs: 300_000,
  });
  assert.equal(r.exit, null);
  assert.equal(r.pos.trailStep, 0, "close below activation should not arm trail");
});

test("5m close mode: close reaches tier — activation", () => {
  const cm = resolveCostModel(FUTURES_CFG);
  const opts = {
    ...resolveTrailingOpts(FUTURES_CFG, cm, null),
    trailActivationOn: "close",
  };
  const entry = 100;
  const pos = {
    side: "BUY",
    entryFill: entry,
    sl: entry * (1 - 0.003),
    tp: entry * (1 + 0.1),
    trailStep: 0,
    extremePx: entry,
    trailTierLabel: null,
    beLocked: false,
  };

  const parentTs = 0;
  const microBars = [
    {
      ts: parentTs,
      open: entry,
      high: entry * 1.0025,
      low: entry * 1.001,
      close: entry * 1.0022,
    },
  ];

  const r = simulateTrailingForParentBar({
    pos,
    parentBar: { ts: parentTs, open: entry, high: entry * 1.0025, low: entry * 1.001, close: entry * 1.0022 },
    microBars,
    stBar: null,
    opts,
    mode: "SUPERTREND",
    leverage: cm.leverage,
    microTfMs: 300_000,
  });
  assert.equal(r.exit, null);
  assert.ok(r.pos.trailStep >= 1, "close past activation should arm trail");
});

test("micro replay exits on trail when adverse mark breaches tightened SL same minute", () => {
  const cm = resolveCostModel(FUTURES_CFG);
  const opts = resolveTrailingOpts(FUTURES_CFG, cm, null);
  const entry = 100;
  const pos = {
    side: "BUY",
    entryFill: entry,
    sl: entry * (1 - 0.003),
    tp: 0,
    trailStep: 0,
    extremePx: entry,
    trailTierLabel: null,
    beLocked: false,
  };

  const parentTs = 0;
  const microBars = [
    {
      ts: parentTs,
      open: entry,
      high: entry * 1.0025,
      low: entry * (1 + opts.t01LockSlipFrac) - 0.001,
      close: entry * (1 + opts.t01LockSlipFrac) - 0.0005,
    },
  ];

  const r = simulateTrailingForParentBar({
    pos,
    parentBar: { ts: parentTs, open: 100, high: 104, low: 99, close: 101 },
    microBars,
    stBar: null,
    opts,
    mode: "SUPERTREND",
    leverage: cm.leverage,
  });
  assert.ok(r.exit);
  assert.equal(r.exit.reason, "trail");
  assert.equal(r.exit.price, pos.sl);
});

test("TrailMicroBarLoader slices bars to parent window and entry", async () => {
  const loader = new TrailMicroBarLoader({
    symbol: "BTCUSDT",
    fromMs: 0,
    toMs: 600_000,
    priceSource: "trade",
    microTf: "5m",
  });
  loader._bars = [
    { ts: 0, open: 1, high: 1, low: 1, close: 1 },
    { ts: 300_000, open: 1, high: 1, low: 1, close: 1 },
    { ts: 600_000, open: 1, high: 1, low: 1, close: 1 },
  ];
  const slice = await loader.barsForParentBar(300_000, 300_000, 150_000);
  assert.equal(slice.length, 1);
  assert.equal(slice[0].ts, 300_000);
});
