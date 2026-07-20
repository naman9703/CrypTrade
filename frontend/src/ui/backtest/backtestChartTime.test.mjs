import test from "node:test";
import assert from "node:assert/strict";
import {
  activeBracketPrice,
  barIndexContainingMs,
  chartTfToMs,
  resolveTradeEntryFillMs,
  resolveTradeExitFillMs,
} from "./backtestChartTime.ts";

test("activeBracketPrice treats disabled bracket levels as absent", () => {
  assert.equal(activeBracketPrice(0), null);
  assert.equal(activeBracketPrice(null), null);
  assert.equal(activeBracketPrice(105_000), 105_000);
});

test("elite same-bar entry fill maps to last minute of 1h bar on 1m chart", () => {
  const barOpen = Date.parse("2025-06-09T04:00:00.000Z");
  const trade = {
    entryTs: new Date(barOpen).toISOString(),
    entryBarTs: new Date(barOpen).toISOString(),
    entryFillTs: null,
    entrySameBar: true,
  };
  const fillMs = resolveTradeEntryFillMs(trade, "1h", "SUPERTREND_ELITE");
  assert.equal(fillMs, barOpen + chartTfToMs("1h") - 1);

  const candles = [];
  for (let m = 0; m < 120; m++) {
    candles.push({ ts: barOpen + m * 60_000, open: 1, high: 1, low: 1, close: 1 });
  }
  const idx = barIndexContainingMs(candles, fillMs, chartTfToMs("1m"));
  assert.equal(candles[idx].ts, barOpen + 59 * 60_000);
});

test("1h chart places same fill on parent bar open", () => {
  const barOpen = Date.parse("2025-06-09T04:00:00.000Z");
  const fillMs = barOpen + chartTfToMs("1h") - 1;
  const candles = [{ ts: barOpen, open: 1, high: 2, low: 0.5, close: 1.5 }];
  const idx = barIndexContainingMs(candles, fillMs, chartTfToMs("1h"));
  assert.equal(idx, 0);
});

test("trail exit without exitFillTs maps to exit bar open on 1m chart", () => {
  const exitBarOpen = Date.parse("2025-06-09T10:00:00.000Z");
  const trade = {
    exitTs: new Date(exitBarOpen).toISOString(),
    exitFillTs: null,
    exitReason: "trail",
  };
  const fillMs = resolveTradeExitFillMs(trade, "1h");
  assert.equal(fillMs, exitBarOpen);
  const candles = [];
  for (let m = 0; m < 120; m++) {
    candles.push({ ts: exitBarOpen + m * 60_000, open: 1, high: 1, low: 1, close: 1 });
  }
  const idx = barIndexContainingMs(candles, fillMs, chartTfToMs("1m"));
  assert.equal(candles[idx].ts, exitBarOpen);
});
