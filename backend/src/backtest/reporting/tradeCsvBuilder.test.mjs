import test from "node:test";
import assert from "node:assert/strict";
import {
  CSV_COLUMNS,
  LIQ_CSV_COLUMNS,
  computeTradePriceRr,
  csvEscape,
  formatTradeRr,
  marginForTrade,
  dedupeTradesByNumber,
  rangeHighestForCsv,
  rangeLowestForCsv,
  resolveCsvColumns,
  tradeHasLiqData,
} from "./tradeCsvBuilder.js";

test("csvEscape handles comma quote newline", () => {
  assert.equal(csvEscape("plain"), "plain");
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape("a,b"), '"a,b"');
  assert.equal(csvEscape("line\nbreak"), '"line\nbreak"');
});

test("computeTradePriceRr matches frontend formula", () => {
  const rr = computeTradePriceRr({
    direction: "BUY",
    entryPrice: 100,
    exitPrice: 103,
    initialSlPrice: 98,
  });
  assert.ok(rr != null && Math.abs(rr - 1.5) < 1e-9);
  assert.equal(formatTradeRr(rr), "+1.50");
});

test("marginForTrade falls back to notional/leverage", () => {
  const m = marginForTrade({ entryPrice: 100, qty: 0.5, marginUsdt: null }, 10);
  assert.ok(m != null && Math.abs(m - 5) < 1e-9);
});

test("CSV_COLUMNS excludes Liq columns by default", () => {
  assert.equal(CSV_COLUMNS[0], "#");
  assert.equal(CSV_COLUMNS[1], "Coin");
  assert.equal(CSV_COLUMNS[14], "Reason");
  assert.ok(CSV_COLUMNS.includes("ATR14"));
  assert.ok(CSV_COLUMNS.includes("Bars to SL touch"));
  assert.ok(!CSV_COLUMNS.includes("Liq ADX"));
  assert.equal(CSV_COLUMNS.length, 56);
  assert.equal(LIQ_CSV_COLUMNS.length, 4);
});

test("resolveCsvColumns omits Liq columns when no trade has liq data", () => {
  const trades = [{ tradeNumber: 1, direction: "BUY" }];
  const cols = resolveCsvColumns(trades, { 1: {} });
  assert.equal(cols.length, 56);
  assert.ok(!cols.includes("Liq ADX"));
});

test("resolveCsvColumns includes Liq columns when any trade has liq context", () => {
  const trades = [
    { tradeNumber: 1, direction: "BUY", liqContext: { features: { marketState: { adx: 22 } } } },
  ];
  const cols = resolveCsvColumns(trades, { 1: { liqAdx: 22 } });
  assert.equal(cols.length, 60);
  assert.ok(cols.includes("Liq confidence"));
});

test("tradeHasLiqData detects liqContext on trade row", () => {
  assert.equal(tradeHasLiqData({ liqContext: { features: { marketState: { regime: "trend" } } } }, {}), true);
  assert.equal(tradeHasLiqData({}, {}), false);
});

test("dedupeTradesByNumber keeps first occurrence", () => {
  const out = dedupeTradesByNumber([
    { tradeNumber: 1, direction: "BUY" },
    { tradeNumber: 1, direction: "BUY" },
    { tradeNumber: 2, direction: "SELL" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].tradeNumber, 1);
  assert.equal(out[1].tradeNumber, 2);
});

test("range columns are direction-aware (SELL blanks highest, BUY blanks lowest)", () => {
  const f = { rangeLowestPrice: 90, rangeHighestPrice: 110 };
  assert.equal(rangeLowestForCsv({ direction: "SELL" }, f), "90.0000");
  assert.equal(rangeHighestForCsv({ direction: "SELL" }, f), "");
  assert.equal(rangeLowestForCsv({ direction: "BUY" }, f), "");
  assert.equal(rangeHighestForCsv({ direction: "BUY" }, f), "110.0000");
});
