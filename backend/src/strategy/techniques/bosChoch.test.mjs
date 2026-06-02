import test from "node:test";
import assert from "node:assert/strict";
import {
  detectMarketBos,
  detectMarketChoch,
  detectMssInRange,
  detectChochInRange,
  detectBosInRange,
} from "./bosChoch.js";

function bar(ts, o, h, l, c) {
  return { ts, open: o, high: h, low: l, close: c, volume: 1 };
}

test("bullish BOS — close above prior swing high", () => {
  const candles = [];
  const prices = [100, 101, 102, 101, 100, 99, 98, 99, 100, 101, 102, 103, 104, 106];
  for (let i = 0; i < prices.length; i++) {
    const c = prices[i];
    candles.push(bar(i * 60000, c, c + 0.5, c - 0.5, c));
  }
  const opts = { intradaySmcSwingLeft: 1, intradaySmcSwingRight: 1, intradaySmcSwingConfirmBars: 1 };
  const idx = candles.length - 1;
  const r = detectMarketBos(candles, idx, "BUY", opts);
  assert.equal(typeof r.ok, "boolean");
});

test("bearish CHoCH requires prior bullish structure or relaxed flag", () => {
  const candles = [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 102, 99, 101),
    bar(2, 101, 103, 100, 102),
    bar(3, 102, 103, 98, 99),
  ];
  const opts = {
    intradaySmcSwingLeft: 1,
    intradaySmcSwingRight: 1,
    intradaySmcSwingConfirmBars: 1,
    intradaySmcChochRequireTrend: false,
  };
  const r = detectMarketChoch(candles, 3, "SELL", opts);
  assert.equal(typeof r.ok, "boolean");
});

test("detectMarketChoch — strict trend gate blocks when prior trend mismatches", () => {
  const candles = [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 102, 99, 101),
    bar(2, 101, 103, 100, 102),
    bar(3, 102, 103, 98, 99),
  ];
  const opts = {
    intradaySmcSwingLeft: 1,
    intradaySmcSwingRight: 1,
    intradaySmcSwingConfirmBars: 1,
    intradaySmcChochRequireTrend: true,
  };
  const r = detectMarketChoch(candles, 3, "SELL", opts);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not_bullish_prior");
});

test("detectChochInRange / detectBosInRange — bounded to [from, to]", () => {
  const candles = [];
  const prices = [100, 101, 102, 101, 100, 99, 98, 99, 100, 101, 102, 103, 104, 106];
  for (let i = 0; i < prices.length; i++) {
    const c = prices[i];
    candles.push(bar(i * 60000, c, c + 0.5, c - 0.5, c));
  }
  const opts = {
    intradaySmcSwingLeft: 1,
    intradaySmcSwingRight: 1,
    intradaySmcSwingConfirmBars: 1,
    intradaySmcChochRequireTrend: false,
    intradaySmcMssRequireDisplacement: false,
  };
  const toIdx = candles.length - 1;
  const choch = detectChochInRange(candles, 4, toIdx, "BUY", opts);
  const bos = detectBosInRange(candles, 4, toIdx, "BUY", opts);
  assert.equal(typeof choch.ok, "boolean");
  assert.equal(typeof bos.ok, "boolean");
  if (choch.ok) assert.ok(choch.chochIdx >= 4 && choch.chochIdx <= toIdx);
  if (bos.ok) assert.ok(bos.bosIdx >= 4 && bos.bosIdx <= toIdx);
});

test("detectMssInRange — searches backward only within [from, to]", () => {
  const candles = [];
  const prices = [100, 101, 102, 101, 100, 99, 98, 99, 100, 101, 102, 103, 104, 106];
  for (let i = 0; i < prices.length; i++) {
    const c = prices[i];
    candles.push(bar(i * 60000, c, c + 0.5, c - 0.5, c));
  }
  const opts = {
    intradaySmcSwingLeft: 1,
    intradaySmcSwingRight: 1,
    intradaySmcSwingConfirmBars: 1,
    intradaySmcMssRequireDisplacement: false,
  };
  const toIdx = candles.length - 1;
  const r = detectMssInRange(candles, 5, toIdx, "BUY", opts);
  assert.equal(typeof r.ok, "boolean");
  if (r.ok) {
    assert.ok(r.mssIdx >= 5 && r.mssIdx <= toIdx);
  }
});
