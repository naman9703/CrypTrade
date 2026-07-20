import test from "node:test";
import assert from "node:assert/strict";
import { isTrailReplaySkipped, replayTradeTrailingTicks, computeTrailReplayStartMs } from "./trailTickReplay.js";

test("isTrailReplaySkipped flags non-trail exits", () => {
  assert.equal(isTrailReplaySkipped("flip"), true);
  assert.equal(isTrailReplaySkipped("tp"), true);
  assert.equal(isTrailReplaySkipped("trail"), false);
});

test("computeTrailReplayStartMs skips entry parent bar (fill at close)", () => {
  const entryTs = Date.parse("2025-06-09T09:00:00.000Z");
  const tfMs = 3_600_000;
  assert.equal(computeTrailReplayStartMs(entryTs, tfMs), entryTs + tfMs);
});

test("replayTradeTrailingTicks advances trail on synthetic ticks", () => {
  const entry = 100;
  const trade = {
    symbol: "BTCUSDT",
    direction: "BUY",
    entryPrice: entry,
    qty: 1,
    entryTs: new Date(0).toISOString(),
    exitTs: new Date(600_000).toISOString(),
    exitReason: "trail",
    initialSlPrice: entry * 0.98,
    slPrice: entry * 1.001,
    trailStep: 2,
    netPnl: 0,
  };
  const cfg = {
    trailingStopLossAuto: true,
    marketMode: "FUTURES",
    futuresTrailingStopMode: "FEE_LADDER",
    trailBufferRate: 0.0005,
    futuresTrailingStFeeBreakeven: true,
    futuresTrailingStAdvanced: true,
    tradeHistoryTakerOpenFeeRate: 0.0004,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    futuresLeverage: 10,
  };
  const ticks = [];
  for (let i = 1; i <= 120; i++) {
    ticks.push({ ts: i * 5000, markPx: entry * (1 + i * 0.0002) });
  }
  const out = replayTradeTrailingTicks({
    trade,
    cfg,
    ticks,
    supertrendAtTs: () => null,
    tickSize: 0.01,
    leverage: 10,
  });
  assert.equal(out.ok, true);
  assert.equal(out.replaySkipped, false);
  assert.ok(out.trailStep >= 0);
});
