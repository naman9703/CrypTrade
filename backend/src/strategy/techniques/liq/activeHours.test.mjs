import test from "node:test";
import assert from "node:assert/strict";
import { passesLiqMarketActivation } from "./marketState.js";

test("passesLiqMarketActivation — guide active-hour gate (LIQ-native)", () => {
  const day = Date.UTC(2026, 2, 10);
  const candles = [
    { ts: day + 3 * 3600_000, open: 100, high: 101, low: 99, close: 100 },
    { ts: day + 10 * 3600_000, open: 100, high: 101, low: 99, close: 100 },
  ];
  const opts = { intradayLiqActiveHourStart: 7, intradayLiqActiveHourEnd: 20 };
  assert.equal(passesLiqMarketActivation(candles, 0, null, opts), false);
  assert.equal(passesLiqMarketActivation(candles, 1, null, opts), true);
  assert.equal(passesLiqMarketActivation(candles, 0, null, {}), true);
});
