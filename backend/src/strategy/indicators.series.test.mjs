import test from "node:test";
import assert from "node:assert/strict";
import { buildPerBarIndicatorSnapshots, computeIndicators } from "./indicators.js";

function mockCandles(n) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 7) * 0.5;
    out.push({
      ts: i * 60000,
      open: p - 0.2,
      high: p + 0.5,
      low: p - 0.5,
      close: p,
      volume: 1000 + i,
    });
  }
  return out;
}

test("buildPerBarIndicatorSnapshots matches computeIndicators on last bar", () => {
  const candles = mockCandles(300);
  const snaps = buildPerBarIndicatorSnapshots(candles);
  const full = computeIndicators(candles);
  const last = snaps[snaps.length - 1];
  assert.ok(last?.latest);
  assert.equal(last.latest.rsi_14, full.latest.rsi_14);
  assert.equal(last.latest.ema_fast, full.latest.ema_fast);
});
