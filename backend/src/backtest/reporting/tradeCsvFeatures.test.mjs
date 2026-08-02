import test from "node:test";
import assert from "node:assert/strict";
import {
  computeRangeBeforeSl,
  sessionFromUtcHour,
} from "./tradeCsvFeatures.js";
import { barIndexContainingMs, chartTfToMs } from "./tradeCsvTime.js";

function makeCandles(n, startTs = 1_700_000_000_000, stepMs = 60_000) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const base = 100 + i * 0.1;
    out.push({
      ts: startTs + i * stepMs,
      open: base,
      high: base + 1,
      low: base - 1,
      close: base + 0.2,
      volume: 1000 + i * 10,
    });
  }
  return out;
}

test("sessionFromUtcHour maps Asia/London/NY/Overlap", () => {
  assert.equal(sessionFromUtcHour(2), "Asia");
  assert.equal(sessionFromUtcHour(10), "London");
  assert.equal(sessionFromUtcHour(14), "Overlap");
  assert.equal(sessionFromUtcHour(18), "NY");
});

test("computeRangeBeforeSl BUY tracks max high until SL touch", () => {
  const candles = [
    { ts: 0, open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { ts: 60_000, open: 100, high: 105, low: 98, close: 104, volume: 1 },
    { ts: 120_000, open: 104, high: 106, low: 97, close: 98, volume: 1 },
    { ts: 180_000, open: 98, high: 99, low: 94, close: 95, volume: 1 },
  ];
  const trade = { direction: "BUY", initialSlPrice: 95, entryPrice: 100 };
  const r = computeRangeBeforeSl(candles, 0, 3, trade);
  assert.equal(r.rangeHighestPrice, 106);
  assert.equal(r.rangeLowestPrice, null);
  assert.equal(r.barsToSlTouch, 3);
});

test("computeRangeBeforeSl SELL tracks min low until SL touch", () => {
  const candles = [
    { ts: 0, open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { ts: 60_000, open: 100, high: 102, low: 96, close: 97, volume: 1 },
    { ts: 120_000, open: 97, high: 108, low: 96, close: 107, volume: 1 },
  ];
  const trade = { direction: "SELL", initialSlPrice: 108, entryPrice: 100 };
  const r = computeRangeBeforeSl(candles, 0, 2, trade);
  assert.equal(r.rangeLowestPrice, 96);
  assert.equal(r.rangeHighestPrice, null);
  assert.equal(r.barsToSlTouch, 2);
});

test("computeRangeBeforeSl SELL never touches SL before exit", () => {
  const candles = [
    { ts: 0, open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { ts: 60_000, open: 100, high: 102, low: 98, close: 99, volume: 1 },
    { ts: 120_000, open: 99, high: 100, low: 97, close: 98, volume: 1 },
  ];
  const trade = { direction: "SELL", initialSlPrice: 110, entryPrice: 100 };
  const r = computeRangeBeforeSl(candles, 0, 2, trade);
  assert.equal(r.barsToSlTouch, null);
  assert.equal(r.rangeHighestPrice, null);
  assert.equal(r.rangeLowestPrice, 97);
});

test("barIndexContainingMs finds candle for timestamp", () => {
  const candles = makeCandles(10);
  const tfMs = chartTfToMs("1m");
  const idx = barIndexContainingMs(candles, candles[5].ts + 30_000, tfMs);
  assert.equal(idx, 5);
});
