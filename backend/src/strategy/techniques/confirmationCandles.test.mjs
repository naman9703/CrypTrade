import test from "node:test";
import assert from "node:assert/strict";
import {
  isBullishEngulfing,
  isBearishEngulfing,
  passesConfirmationCandle,
} from "./confirmationCandles.js";

function bar(o, h, l, c) {
  return { open: o, high: h, low: l, close: c, volume: 1 };
}

test("isBullishEngulfing", () => {
  const prev = bar(102, 103, 100, 100.5);
  const curr = bar(100, 104, 99, 103);
  assert.equal(isBullishEngulfing(curr, prev), true);
});

test("passesConfirmationCandle — hammer wick", () => {
  const prev = bar(100, 101, 99.5, 99.8);
  const curr = bar(99.8, 100.2, 97, 100);
  assert.equal(passesConfirmationCandle(curr, prev, "BUY", { intradaySrMinConfirmWick: 0.35 }), true);
});

test("isBearishEngulfing", () => {
  const prev = bar(100, 102, 99, 101);
  const curr = bar(101, 101.5, 97, 98);
  assert.equal(isBearishEngulfing(curr, prev), true);
});
