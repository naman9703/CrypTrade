import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateSrIntradayBar,
  buildSrIntradaySignalSeries,
} from "./srIntraday.js";

function bar(ts, o, h, l, c, vol = 1000) {
  return { ts, open: o, high: h, low: l, close: c, volume: vol };
}

test("evaluateSrIntradayBar returns null during warmup", () => {
  const candles = Array.from({ length: 50 }, (_, i) =>
    bar(Date.UTC(2026, 0, 2, 10, i * 15) , 100, 101, 99, 100)
  );
  assert.equal(evaluateSrIntradayBar(candles, 40), null);
});

test("buildSrIntradaySignalSeries produces array of same length", () => {
  const n = 200;
  const base = 50_000;
  const candles = Array.from({ length: n }, (_, i) => {
    const drift = Math.sin(i / 12) * 80;
    const c = base + drift + i * 0.5;
    return bar(
      Date.UTC(2026, 0, 1, 8, 0) + i * 900_000,
      c - 5,
      c + 20,
      c - 25,
      c,
      1000 + (i % 7) * 100
    );
  });
  const series = buildSrIntradaySignalSeries(candles);
  assert.equal(series.length, n);
});
