import test from "node:test";
import assert from "node:assert/strict";
import { REGIMES } from "../../regimeEngine.js";
import {
  passesLiqMarketActivation,
  resolveSessionNarrative,
  isExternalLiquidityLevel,
} from "./marketState.js";
import { parseLiqLevelModes, resolveLiquidityCandidates } from "./liquidityLevels.js";
import { computeSweepQuality, passesSweepQualityGate } from "./sweepQuality.js";
import { computeDisplacementV2 } from "./displacementV2.js";
import { evaluateContinuationRoom } from "./continuationRoom.js";
import { computeEntryScoreV2 } from "./entryScoreV2.js";

function mkCandles(n = 80) {
  const out = [];
  let px = 100;
  const step = 900_000;
  for (let i = 0; i < n; i++) {
    const o = px;
    const h = o + 0.4;
    const l = o - 0.35;
    const c = o + (i % 3 === 0 ? 0.15 : -0.05);
    px = c;
    out.push({ ts: i * step, open: o, high: h, low: l, close: c, volume: 1000 + i * 10 });
  }
  return out;
}

test("marketState blocks volatile avoid when gate on", () => {
  const candles = mkCandles();
  const pre = {
    prevDayHigh: new Array(candles.length).fill(101),
    prevDayLow: new Array(candles.length).fill(99),
  };
  const ok = passesLiqMarketActivation(candles, 50, pre, { intradayLiqMarketStateGate: false });
  assert.equal(ok, true);
  const blocked = passesLiqMarketActivation(candles, 50, pre, {
    intradayLiqMarketStateGate: true,
    _regimeSeries: new Array(candles.length).fill({ regime: REGIMES.VOLATILE_AVOID }),
  });
  assert.equal(blocked, false);
});

test("liquidityLevels parses modes and returns daily candidate", () => {
  const modes = parseLiqLevelModes({ intradayLiqLevels: "daily,weekly" });
  assert.ok(modes.has("daily"));
  assert.ok(modes.has("weekly"));
  const candles = mkCandles();
  const pre = {
    prevDayHigh: new Array(candles.length).fill(105),
    prevDayLow: new Array(candles.length).fill(95),
    prevWeekHigh: new Array(candles.length).fill(110),
    prevWeekLow: new Array(candles.length).fill(90),
  };
  const buy = resolveLiquidityCandidates(candles, 40, "BUY", pre, { intradayLiqLevels: "daily,weekly" });
  assert.ok(buy.some((c) => c.levelType === "pdl"));
  assert.ok(buy.some((c) => c.levelType === "prev_week_low"));
});

test("sweepQuality computes velocity and gate respects max attempts", () => {
  const candles = mkCandles(30);
  const cycle = { sweepStartIdx: 10, reclaimIdx: 14, level: 100, wick: 99.2, extension: 0.008, attemptCount: 5 };
  const m = computeSweepQuality(candles, cycle, "BUY", { atrSeries: new Array(30).fill(0.5) }, {});
  assert.ok(m.sweepVelocity > 0);
  assert.equal(passesSweepQualityGate(candles, cycle, "BUY", {}, { intradayLiqSweepQualityGate: true, intradayLiqMaxSweepAttempts: 3 }), false);
});

test("continuationRoom gate rejects low opposing R", () => {
  const candles = mkCandles();
  const pre = { atrSeries: new Array(candles.length).fill(0.5) };
  const room = evaluateContinuationRoom(candles, 40, "BUY", 100, 99, 100.3, pre, {
    intradayLiqMinContinuationR: 1.5,
  });
  assert.equal(room.passed, false);
  assert.ok(room.distanceToOpposingR < 1.5);
});

test("entryScoreV2 returns bounded score with breakdown", () => {
  const candles = mkCandles(20);
  const cycle = { sweepStartIdx: 8, reclaimIdx: 12, level: 100, levelType: "pdl", extension: 0.01 };
  const reclaimBar = candles[12];
  const r = computeEntryScoreV2({
    candles,
    cycle,
    side: "BUY",
    pre: { htfUp: { 14: true }, htfDown: {}, htfSep: { 14: 0.001 }, prevDayHigh: { 14: 105 }, prevDayLow: { 14: 95 }, ema9: { 14: 99 } },
    opts: {},
    entryBarIdx: 14,
    reclaimBar,
    sweepQuality: { sweepVelocityAtr: 0.1, sweepVolSpike: 1.5, exhaustionScore: 0.5, absorptionProxy: 0.2, attemptCount: 1 },
    displacementV2: { impulseAtr: 1.6, consecutiveImbalanceBars: 2, bodyEfficiency: 0.5, overlapRatio: 0.3, momentumPersistence: 0.6, atrExpansion: 1.1 },
    continuationRoom: { score: 12 },
    marketContext: { sessionNarrative: "london_sweep", regime: REGIMES.RANGE },
  });
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.ok(r.breakdown.sweepQuality >= 0);
});

test("isExternalLiquidityLevel identifies weekly levels", () => {
  assert.equal(isExternalLiquidityLevel("prev_week_high"), true);
  assert.equal(isExternalLiquidityLevel("swing_low"), false);
});

test("resolveSessionNarrative maps UTC hours", () => {
  const ts = Date.UTC(2025, 0, 1, 8, 0, 0);
  assert.equal(resolveSessionNarrative(ts), "london_sweep");
});
