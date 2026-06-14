import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateLiquidityGuards,
  spreadBpsFromBook,
  depthNotionalUsd,
} from "./executionGuards.js";
import {
  clampQtyToBracketNotionalCap,
  notionalCapFromLeverageBrackets,
} from "../lib/binanceUsdMPositionCap.js";

test("evaluateLiquidityGuards blocks wide spread", () => {
  const book = { bids: [[100, 10]], asks: [[101, 10]] };
  const r = evaluateLiquidityGuards({
    book,
    side: "BUY",
    referenceMid: 100.5,
    config: { maxSpreadBps: 50, minDepthUsd: 0, depthLevels: 5, maxOrderVsDepthFrac: 0 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "spread_too_wide");
});

test("evaluateLiquidityGuards blocks thin depth", () => {
  const book = { bids: [[100, 0.1]], asks: [[100.01, 0.1]] };
  const r = evaluateLiquidityGuards({
    book,
    side: "BUY",
    referenceMid: 100,
    config: { maxSpreadBps: 0, minDepthUsd: 500, depthLevels: 5, maxOrderVsDepthFrac: 0 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "depth_too_thin");
});

test("evaluateLiquidityGuards blocks order vs depth fraction", () => {
  const book = { bids: [[100, 10]], asks: [[100.01, 10]] };
  const r = evaluateLiquidityGuards({
    book,
    side: "BUY",
    referenceMid: 100,
    orderNotionalUsd: 2000,
    config: { maxSpreadBps: 0, minDepthUsd: 100, depthLevels: 5, maxOrderVsDepthFrac: 0.5 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "order_exceeds_depth");
});

test("notionalCapFromLeverageBrackets picks nearest leverage tier", () => {
  const cap = notionalCapFromLeverageBrackets(
    [
      { initialLeverage: 10, notionalCap: 1_000_000 },
      { initialLeverage: 20, notionalCap: 500_000 },
    ],
    10,
  );
  assert.equal(cap, 1_000_000);
});

test("clampQtyToBracketNotionalCap downsizes qty", () => {
  const r = clampQtyToBracketNotionalCap({
    qty: 100,
    entryPx: 100,
    capNotional: 5000,
    currentNotional: 2000,
  });
  assert.equal(r.capped, true);
  assert.ok(Math.abs(r.qty - 30) < 1e-9);
});
