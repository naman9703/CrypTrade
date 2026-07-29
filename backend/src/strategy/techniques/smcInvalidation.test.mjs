import test from "node:test";
import assert from "node:assert/strict";
import {
  isChochReclaimed,
  isObBlownThrough,
  isSweepContinuation,
  checkSmcInvalidation,
  resolveEnforceInvalidation,
} from "./smcInvalidation.js";
import { isFvgMitigated } from "./fairValueGap.js";

function bar(ts, o, h, l, c) {
  return { ts, open: o, high: h, low: l, close: c, volume: 1000 };
}

test("resolveEnforceInvalidation — ON with CHoCH / full; OFF on bare sweep", () => {
  assert.equal(resolveEnforceInvalidation({ intradaySmcIctProfile: "sweep" }, false), false);
  assert.equal(resolveEnforceInvalidation({ intradaySmcIctProfile: "sweep" }, true), true);
  assert.equal(resolveEnforceInvalidation({ intradaySmcIctProfile: "full" }, false), true);
  assert.equal(
    resolveEnforceInvalidation({ intradaySmcIctProfile: "sweep", intradaySmcEnforceInvalidation: false }, true),
    false,
  );
});

test("isChochReclaimed — BUY close back below break level", () => {
  const candles = [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 105, 100, 104), // CHoCH break above 102
    bar(2, 104, 105, 103, 104),
    bar(3, 104, 104, 100, 101), // reclaim close < 102
  ];
  assert.equal(isChochReclaimed(candles, 1, 102, "BUY", 3), true);
  assert.equal(isChochReclaimed(candles, 1, 102, "BUY", 2), false);
});

test("isObBlownThrough — close through bottom, not wick-only", () => {
  const ob = { top: 110, bottom: 100, obIdx: 1 };
  const candles = [
    bar(0, 105, 106, 104, 105),
    bar(1, 104, 110, 100, 108), // OB bar
    bar(2, 108, 109, 99, 107), // wick below, close inside — not blown
    bar(3, 107, 108, 98, 99), // close below — blown
  ];
  assert.equal(isObBlownThrough(candles, ob, "BUY", 1, 2), false);
  assert.equal(isObBlownThrough(candles, ob, "BUY", 1, 3), true);
});

test("isFvgMitigated — far-edge wick fills gap", () => {
  const fvg = { top: 110, bottom: 100, formedIdx: 2, mid: 105 };
  const candles = [
    bar(0, 100, 100, 99, 99),
    bar(1, 99, 112, 99, 111),
    bar(2, 111, 112, 110, 111), // formed
    bar(3, 111, 111, 100, 110), // low touches bottom → mitigated
  ];
  assert.equal(isFvgMitigated(candles, fvg, 2, "BUY"), false);
  assert.equal(isFvgMitigated(candles, fvg, 3, "BUY"), true);
});

test("isSweepContinuation — close beyond swept wick after reclaim", () => {
  const cycle = { reclaimIdx: 2, wick: 95, level: 100 };
  const candles = [
    bar(0, 101, 102, 100, 101),
    bar(1, 101, 101, 94, 96), // sweep
    bar(2, 96, 102, 96, 101), // reclaim
    bar(3, 101, 102, 100, 101),
    bar(4, 101, 101, 93, 94), // continuation close < wick
  ];
  assert.equal(isSweepContinuation(candles, cycle, "BUY", 3), false);
  assert.equal(isSweepContinuation(candles, cycle, "BUY", 4), true);
});

test("checkSmcInvalidation — packages reason codes", () => {
  const candles = [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 105, 100, 104),
    bar(2, 104, 104, 100, 101),
  ];
  const r = checkSmcInvalidation({
    candles,
    side: "BUY",
    entryIdx: 2,
    cycle: { reclaimIdx: 0, wick: 99, level: 100 },
    chochIdx: 1,
    chochLevel: 102,
    fvg: null,
    ob: null,
    opts: { intradaySmcEnforceInvalidation: true },
    requireChoch: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "choch_reclaimed");
});
