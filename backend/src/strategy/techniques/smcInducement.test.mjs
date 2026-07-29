import test from "node:test";
import assert from "node:assert/strict";
import { pdArrayWasInduced, resolvePdFormedIdx } from "./smcInducement.js";

function bar(low, high) {
  return { open: (low + high) / 2, close: (low + high) / 2, low, high, volume: 1 };
}

test("pdArrayWasInduced — BUY requires pierce below zone then later entry bar", () => {
  const zone = { top: 101, bottom: 100 };
  const candles = [
    bar(100.2, 100.8), // formed
    bar(100.1, 100.5),
    bar(99.5, 100.2), // pierce below 100
    bar(100.1, 100.6), // return
  ];
  assert.equal(pdArrayWasInduced(candles, zone, "BUY", 0, 3), true);
  assert.equal(pdArrayWasInduced(candles, zone, "BUY", 0, 1), false);
});

test("pdArrayWasInduced — SELL requires pierce above zone", () => {
  const zone = { top: 100, bottom: 99 };
  const candles = [
    bar(99.2, 99.8),
    bar(99.5, 100.5), // pierce above 100
    bar(99.3, 99.7),
  ];
  assert.equal(pdArrayWasInduced(candles, zone, "SELL", 0, 2), true);
  assert.equal(pdArrayWasInduced(candles, zone, "SELL", 0, 1), false);
});

test("resolvePdFormedIdx", () => {
  assert.equal(resolvePdFormedIdx({ formedIdx: 5 }, null, "fvg"), 5);
  assert.equal(resolvePdFormedIdx(null, { obIdx: 3 }, "ob"), 3);
});
