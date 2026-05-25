import test from "node:test";
import assert from "node:assert/strict";
import { fibLevels, nearFibLevel, swingHighLow } from "./techniques/fibonacci.js";
import { rollingVolumeProfile } from "./techniques/volumeProfile.js";
import { computeAdaptiveIntradayParams } from "./adaptiveIntraday.js";
import { selectIntradayPicks, evaluateIntradayBar } from "./intradayPro.js";

function bar(ts, o, h, l, c, vol = 1000) {
  return { ts, open: o, high: h, low: l, close: c, volume: vol };
}

test("fibonacci levels between swing high and low", () => {
  const swing = { high: 110, low: 100, range: 10 };
  const levels = fibLevels(swing, "up");
  assert.ok(levels.some((l) => Math.abs(l.ratio - 0.618) < 0.001));
  const hit = nearFibLevel(105.382, levels, 0.01);
  assert.ok(hit);
});

test("volume profile returns POC", () => {
  const candles = Array.from({ length: 60 }, (_, i) =>
    bar(i * 60_000, 100, 101, 99, 100 + (i % 5), 500 + i * 10),
  );
  const vp = rollingVolumeProfile(candles, 59, 48);
  assert.ok(vp && Number.isFinite(vp.poc));
});

test("adaptive params scale with volatility", () => {
  const calm = Array.from({ length: 150 }, (_, i) => bar(i * 300_000, 100, 100.2, 99.8, 100, 1000));
  const wild = Array.from({ length: 150 }, (_, i) =>
    bar(i * 300_000, 100, 102, 98, 100 + Math.sin(i) * 2, 1000),
  );
  const a1 = computeAdaptiveIntradayParams(calm);
  const a2 = computeAdaptiveIntradayParams(wild);
  assert.ok(a2.slPct >= a1.slPct * 0.8);
});

test("selectIntradayPicks returns series length match", () => {
  const n = 200;
  const candles = Array.from({ length: n }, (_, i) => {
    const c = 100 + Math.sin(i / 8) * 3;
    return bar(Date.UTC(2026, 0, 2, 10, 0) + i * 300_000, c - 0.5, c + 1, c - 1.5, c, 800);
  });
  const { series } = selectIntradayPicks(candles, { minScore: 5, maxTradesPerDay: 3 });
  assert.equal(series.length, n);
});

test("evaluateIntradayBar null during warmup", () => {
  const candles = Array.from({ length: 50 }, (_, i) => bar(i * 60_000, 100, 101, 99, 100));
  assert.equal(evaluateIntradayBar(candles, 40), null);
});
