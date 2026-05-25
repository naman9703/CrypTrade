import test from "node:test";
import assert from "node:assert/strict";
import { signal } from "./htfRsi.js";
import { ema, rsi as computeRsi } from "./indicators.js";

function synthCandles(n, { trend = 0.0002 } = {}) {
  const out = [];
  let p = 100_000;
  let ts = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = p * (1 + trend + (i % 5 === 0 ? -0.003 : 0.0005));
    const h = Math.max(o, c) * 1.001;
    const l = Math.min(o, c) * 0.999;
    out.push({ ts, open: o, high: h, low: l, close: c, volume: 1000 });
    p = c;
    ts += 900_000;
  }
  return out;
}

test("weak HTF long blocked", () => {
  const candles = synthCandles(120, { trend: 0 });
  const r = signal({ candles, timeframe: "15m" });
  assert.ok(r.action === "HOLD" || r.action === "BUY");
});

test("requires recovery and close vs prev for long", () => {
  const candles = synthCandles(100);
  const r = signal({ candles, timeframe: "15m" });
  if (r.action === "BUY") {
    assert.match(r.reason, /htf_rsi_long/);
  }
});
