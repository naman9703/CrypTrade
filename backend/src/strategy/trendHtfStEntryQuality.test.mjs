import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateTrendHtfStEntryQuality,
  classifyTradeOutcome,
  shouldBlockTrendHtfStChopEntry,
} from "./trendHtfStEntryQuality.js";

function synthCandles(n, drift = 0.001) {
  const out = [];
  let px = 100;
  const start = Date.UTC(2025, 5, 1);
  for (let i = 0; i < n; i++) {
    const ts = start + i * 15 * 60 * 1000;
    const o = px;
    px *= 1 + drift * (i % 2 === 0 ? 1 : -1);
    const c = px;
    const h = Math.max(o, c) * 1.002;
    const l = Math.min(o, c) * 0.998;
    out.push({ ts, open: o, high: h, low: l, close: c, volume: 1000 });
  }
  return out;
}

test("classifyTradeOutcome labels whipsaw and instant SL", () => {
  assert.equal(
    classifyTradeOutcome({ netPnl: -1, exitReason: "sl", barsHeld: 2, mfePct: 0.002, maePct: -0.012 }),
    "INSTANT_SL",
  );
  assert.equal(
    classifyTradeOutcome({ netPnl: -1, exitReason: "sl", barsHeld: 10, mfePct: 0.015, maePct: -0.012 }),
    "WHIPSAW_GAVE_BACK",
  );
  assert.equal(classifyTradeOutcome({ netPnl: 5, exitReason: "tp" }), "WIN_TP");
});

test("evaluateTrendHtfStEntryQuality returns flags and structuralRisk", () => {
  const candles = synthCandles(600, 0.0002);
  const q = evaluateTrendHtfStEntryQuality(candles, 500, "BUY");
  assert.ok(q);
  assert.ok(Array.isArray(q.flags));
  assert.ok(["CHOP_ZONE", "TREND_OK", "MIXED"].includes(q.structuralRisk));
  assert.equal(typeof q.wouldBlock, "boolean");
});

test("shouldBlockTrendHtfStChopEntry respects cfg flag", () => {
  const candles = synthCandles(600);
  assert.equal(shouldBlockTrendHtfStChopEntry(candles, 500, "BUY", { trendHtfStRegimeGate: false }), false);
  assert.equal(
    typeof shouldBlockTrendHtfStChopEntry(candles, 500, "BUY", { trendHtfStRegimeGate: true }),
    "boolean",
  );
});
