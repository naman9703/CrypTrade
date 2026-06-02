import test from "node:test";
import assert from "node:assert/strict";
import { detectStructureShift } from "./structureShift.js";

function bar(ts, o, h, l, c) {
  return { ts, open: o, high: h, low: l, close: c, volume: 1 };
}

test("detectStructureShift — long BOS above pullback leg high", () => {
  const candles = [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 100.5, 98, 98.5),
    bar(2, 98.5, 99, 97, 97.5),
    bar(3, 97.5, 101.5, 97, 101),
  ];
  const cycle = { reclaimIdx: 3, sweepStartIdx: 1, wick: 97 };
  const r = detectStructureShift(candles, cycle, "BUY", { intradaySrBosMaxBarsAfterReclaim: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.bosIdx, 3);
});

test("detectStructureShift — short BOS below leg low", () => {
  const candles = [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 102, 100, 101.5),
    bar(2, 101.5, 103, 101, 102.5),
    bar(3, 102.5, 103, 99, 99.5),
  ];
  const cycle = { reclaimIdx: 3, sweepStartIdx: 1, wick: 103 };
  const r = detectStructureShift(candles, cycle, "SELL", { intradaySrBosMaxBarsAfterReclaim: 0 });
  assert.equal(r.ok, true);
});
