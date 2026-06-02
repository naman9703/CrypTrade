import test from "node:test";
import assert from "node:assert/strict";
import { detectFvgAt, findFvgFromDisplacement, priceAtFvgMidpoint } from "./fairValueGap.js";

function bar(ts, o, h, l, c) {
  return { ts, open: o, high: h, low: l, close: c, volume: 1 };
}

test("bullish FVG — gap between candle0 high and candle2 low", () => {
  const candles = [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 105, 99, 104),
    bar(2, 104, 108, 103, 107),
  ];
  const fvg = detectFvgAt(candles, 2, "BUY", { intradaySmcFvgMinGapPct: 0 });
  assert.ok(fvg);
  assert.equal(fvg.type, "bullish_fvg");
  assert.ok(fvg.bottom < fvg.top);
});

test("findFvgFromDisplacement — prefers gap at MSS bar", () => {
  const candles = [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 105, 99, 104),
    bar(2, 104, 108, 103, 107),
    bar(3, 107, 109, 106, 108),
  ];
  const fvg = findFvgFromDisplacement(candles, 2, "BUY", { intradaySmcFvgMinGapPct: 0 }, 0);
  assert.ok(fvg);
  assert.equal(fvg.formedIdx, 2);
});

test("priceAtFvgMidpoint — touch CE and close on trade side", () => {
  const candles = [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 105, 99, 104),
    bar(2, 104, 108, 103, 107),
    bar(3, 107, 108, 101.5, 102.5),
  ];
  const fvg = detectFvgAt(candles, 2, "BUY", { intradaySmcFvgMinGapPct: 0 });
  assert.ok(fvg);
  assert.equal(priceAtFvgMidpoint(candles, 3, fvg, "BUY"), true);
  assert.equal(priceAtFvgMidpoint(candles, 2, fvg, "BUY"), false);
});
