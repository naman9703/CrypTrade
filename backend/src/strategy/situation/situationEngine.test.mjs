import { test } from "node:test";
import assert from "node:assert/strict";
import { precomputeIntraday } from "../intradayPro.js";
import { classifySituation, isBreakdownBear, isRangeAbovePdl } from "./situationEngine.js";
import { SITUATIONS as S } from "./situationConstants.js";

function mkCandle(ts, o, h, l, c, v = 1000) {
  return { ts, open: o, high: h, low: l, close: c, volume: v };
}

test("classifySituation returns CHOP_NEUTRAL on short history", () => {
  const candles = Array.from({ length: 30 }, (_, i) => mkCandle(i * 900_000, 100, 101, 99, 100));
  const pre = precomputeIntraday(candles);
  const r = classifySituation(candles, 20, pre);
  assert.equal(r.situation, S.CHOP_NEUTRAL);
});

test("isBreakdownBear detects multiple closes below PDL with HTF bear", () => {
  const base = Date.parse("2026-06-03T00:00:00Z");
  const candles = [];
  for (let i = 0; i < 120; i++) {
    const pdl = 640;
    const close = i >= 100 ? pdl - 5 - (i - 100) * 0.5 : 650;
    candles.push(mkCandle(base + i * 900_000, close, close + 2, close - 2, close));
  }
  const pre = precomputeIntraday(candles);
  pre.htfDown[119] = true;
  pre.prevDayLow[119] = 640;
  assert.equal(isBreakdownBear(candles, 119, pre, 4), true);
  const r = classifySituation(candles, 119, pre);
  assert.equal(r.situation, S.BREAKDOWN_BEAR);
});

test("isRangeAbovePdl true when day low holds above PDL", () => {
  const base = Date.parse("2026-06-01T00:00:00Z");
  const candles = [];
  for (let i = 0; i < 80; i++) {
    candles.push(mkCandle(base + i * 900_000, 700, 705, 698, 702));
  }
  const pre = precomputeIntraday(candles);
  pre.prevDayLow[79] = 690;
  pre.htfDown[79] = false;
  assert.equal(isRangeAbovePdl(candles, 79, pre), true);
  const r = classifySituation(candles, 79, pre);
  assert.equal(r.situation, S.RANGE_ABOVE_PDL);
});
