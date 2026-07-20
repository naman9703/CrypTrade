import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHybridTickSeries,
  buildMarkOhlcTickSeries,
  calendarDaysInRange,
  indexMarkBarsByMinute,
  mergeHoldWindows,
} from "./trailTickSeries.js";

test("mergeHoldWindows merges overlaps per symbol", () => {
  const out = mergeHoldWindows([
    { symbol: "BTCUSDT", fromMs: 0, toMs: 100 },
    { symbol: "BTCUSDT", fromMs: 50, toMs: 200 },
    { symbol: "ETHUSDT", fromMs: 0, toMs: 50 },
  ]);
  assert.equal(out.length, 2);
  const btc = out.find((w) => w.symbol === "BTCUSDT");
  assert.equal(btc.fromMs, 0);
  assert.equal(btc.toMs, 200);
});

test("buildHybridTickSeries uses mark close per minute", () => {
  const mark = indexMarkBarsByMinute([
    { ts: 60_000, open: 100, high: 101, low: 99, close: 100.5 },
  ]);
  const ticks = buildHybridTickSeries([{ ts: 90_000, price: 100.2 }], mark, "hybrid");
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].markPx, 100.5);
  assert.equal(ticks[0].tradePx, 100.2);
});

test("buildMarkOhlcTickSeries emits four points per bar", () => {
  const ticks = buildMarkOhlcTickSeries(
    [{ ts: 0, open: 1, high: 2, low: 0.5, close: 1.5 }],
    0,
    60_000,
  );
  assert.equal(ticks.length, 4);
});

test("calendarDaysInRange spans UTC days", () => {
  const days = calendarDaysInRange(Date.parse("2025-01-01T12:00:00Z"), Date.parse("2025-01-02T01:00:00Z"));
  assert.deepEqual(days, ["2025-01-01", "2025-01-02"]);
});
