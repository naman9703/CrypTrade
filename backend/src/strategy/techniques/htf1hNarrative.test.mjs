import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCompleted1hBars,
  buildHtf1hNarrativeSeries,
  h1StructureAllowsSide,
  passesHtf1hNarrative,
} from "./htf1hNarrative.js";

function bar(ts, o, h, l, c) {
  return { ts, open: o, high: h, low: l, close: c, volume: 100 };
}

test("buildCompleted1hBars — excludes forming hour", () => {
  const base = Date.UTC(2026, 0, 1, 10, 0, 0);
  const candles = [];
  // 10:00–10:45 complete hour, 11:00–11:15 forming
  for (let i = 0; i < 4; i++) {
    candles.push(bar(base + i * 15 * 60 * 1000, 100 + i, 101 + i, 99 + i, 100.5 + i));
  }
  candles.push(bar(base + 4 * 15 * 60 * 1000, 105, 106, 104, 105)); // 11:00
  candles.push(bar(base + 5 * 15 * 60 * 1000, 105, 107, 104, 106)); // 11:15 forming
  const completed = buildCompleted1hBars(candles);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].ts, base);
  assert.equal(completed[0].closeChartIdx, 3);
});

test("h1StructureAllowsSide — soft: only hard opposite blocks", () => {
  const narr = {
    h1StructureState: ["BULLISH", "BEARISH", "NEUTRAL", "UNKNOWN"],
  };
  assert.equal(h1StructureAllowsSide("BUY", narr, 0), true);
  assert.equal(h1StructureAllowsSide("SELL", narr, 0), false);
  assert.equal(h1StructureAllowsSide("BUY", narr, 1), false);
  assert.equal(h1StructureAllowsSide("SELL", narr, 1), true);
  assert.equal(h1StructureAllowsSide("BUY", narr, 2), true);
  assert.equal(h1StructureAllowsSide("SELL", narr, 3), true);
});

test("passesHtf1hNarrative — strict requires directional 1H", () => {
  const pre = {
    _smcH1Narr: {
      h1StructureState: ["BULLISH", "NEUTRAL"],
      h1DrHigh: [110, 110],
      h1DrLow: [100, 100],
      h1DrEq: [105, 105],
    },
  };
  const soft = { intradaySmcRequireHtfNarrative: true, intradaySmcHtfNarrativeStrictness: "soft" };
  const strict = { ...soft, intradaySmcHtfNarrativeStrictness: "strict" };
  assert.equal(passesHtf1hNarrative("BUY", pre, 0, 103, soft), true);
  assert.equal(passesHtf1hNarrative("BUY", pre, 1, 103, soft), true);
  assert.equal(passesHtf1hNarrative("BUY", pre, 0, 103, strict), true);
  assert.equal(passesHtf1hNarrative("BUY", pre, 1, 103, strict), false);
});

test("buildHtf1hNarrativeSeries — maps completed segments onto chart bars", () => {
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  const candles = [];
  for (let h = 0; h < 40; h++) {
    for (let q = 0; q < 4; q++) {
      const i = h * 4 + q;
      const px = 100 + Math.sin(h / 3) * 5 + q * 0.1;
      candles.push(bar(base + i * 15 * 60 * 1000, px, px + 1, px - 1, px));
    }
  }
  // leave last hour incomplete by dropping last 2 bars
  candles.length = candles.length - 2;
  const series = buildHtf1hNarrativeSeries(candles, {
    intradaySmcH1ChochRequireDisplacement: false,
  });
  assert.equal(series.h1StructureState.length, candles.length);
  // last incomplete hour bars should still carry prior completed narrative
  const last = candles.length - 1;
  assert.ok(series.h1StructureState[last] != null);
  assert.ok(series.h1DrEq[20] != null);
});
