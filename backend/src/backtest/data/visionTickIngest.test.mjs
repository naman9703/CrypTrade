import test from "node:test";
import assert from "node:assert/strict";
import { parseAggTradesLine, parseAggTradesCsv, visionAggTradesUrl } from "./visionTickIngest.js";

test("visionAggTradesUrl builds futures um daily path", () => {
  const url = visionAggTradesUrl("btcusdt", "2025-01-15");
  assert.ok(url.includes("futures/um/daily/aggTrades/BTCUSDT/BTCUSDT-aggTrades-2025-01-15.zip"));
});

test("parseAggTradesLine parses Vision CSV row", () => {
  const row = parseAggTradesLine("26129,0.01633102,4.70443515,27781,27781,1498793709153,true");
  assert.equal(row.aggId, 26129);
  assert.equal(row.price, 0.01633102);
  assert.equal(row.ts, 1498793709153);
  assert.equal(row.isBuyerMaker, true);
});

test("parseAggTradesCsv filters by window", () => {
  const csv = [
    "1,100,1,1,1,1000,false",
    "2,101,1,2,2,5000,false",
    "3,102,1,3,3,9000,false",
  ].join("\n");
  const rows = parseAggTradesCsv(csv, { fromMs: 2000, toMs: 8000 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].aggId, 2);
});
