import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeCandlesForSt } from "./supertrendChartAlign.js";

function bar(ts, open, high, low, close) {
  return { ts, open, high, low, close };
}

const MIN = 60_000;

test("keeps a normal transition from quiet to active BTC ranges (no cascading false-positive drops)", () => {
  const t0 = 1_700_000_000_000;
  const candles = [];
  let ts = t0;
  // 55 ultra-quiet bars (range ~0.1) establish a tiny rolling median.
  let px = 63000;
  for (let i = 0; i < 55; i++) {
    candles.push(bar(ts, px, px + 0.1, px, px + 0.05));
    ts += MIN;
    px += 0.02;
  }
  // Then normal-sized (but much larger relative to the prior quiet median) bars follow —
  // this is real BTC 1m behavior and must not be dropped as "spikes".
  for (let i = 0; i < 10; i++) {
    candles.push(bar(ts, px, px + 15, px - 15, px + 5));
    ts += MIN;
    px += 5;
  }
  const clean = sanitizeCandlesForSt(candles, "BTCUSDT");
  assert.equal(clean.length, candles.length, "no bars should be dropped for ordinary volatility increase");
  for (let i = 1; i < clean.length; i++) {
    assert.equal(clean[i].ts - clean[i - 1].ts, MIN, "bar spacing must stay contiguous (no gaps)");
  }
});

test("still rejects a genuinely corrupt / outlier wick", () => {
  const t0 = 1_700_000_000_000;
  const candles = [];
  let ts = t0;
  let px = 63000;
  for (let i = 0; i < 55; i++) {
    candles.push(bar(ts, px, px + 5, px - 5, px + 1));
    ts += MIN;
    px += 1;
  }
  // Inject one bar with a wildly implausible wick (~5% of price) amid otherwise normal bars.
  candles.push(bar(ts, px, px * 1.05, px - 5, px + 1));
  const corruptTs = ts;
  ts += MIN;
  for (let i = 0; i < 5; i++) {
    candles.push(bar(ts, px, px + 5, px - 5, px + 1));
    ts += MIN;
  }
  const clean = sanitizeCandlesForSt(candles, "BTCUSDT");
  assert.ok(!clean.some((c) => c.ts === corruptTs), "corrupt wick bar must still be rejected");
  assert.equal(clean.length, candles.length - 1);
});

test("dedupes same-timestamp bars and sorts oldest-first", () => {
  const candles = [
    bar(2_000, 10, 11, 9, 10.5),
    bar(1_000, 10, 11, 9, 10),
    bar(2_000, 10, 11.5, 9, 10.8),
  ];
  const clean = sanitizeCandlesForSt(candles, "");
  assert.equal(clean.length, 2);
  assert.equal(clean[0].ts, 1_000);
  assert.equal(clean[1].ts, 2_000);
  assert.equal(clean[1].close, 10.8, "later duplicate wins");
});
