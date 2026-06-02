import test from "node:test";
import assert from "node:assert/strict";
import { getConfirmedSwings } from "./marketStructure.js";
import { evaluateSmcIctSetup } from "../evaluateSmcIctSetup.js";
import { precomputeIntraday } from "../intradayPro.js";

function bar(ts, o, h, l, c) {
  return { ts, open: o, high: h, low: l, close: c, volume: 1 };
}

test("truncation audit — swings at idx unchanged when future bars appended", () => {
  const opts = { intradaySmcSwingLeft: 1, intradaySmcSwingRight: 1, intradaySmcSwingConfirmBars: 2 };
  const base = [];
  for (let i = 0; i < 30; i++) {
    const w = Math.sin(i / 3) * 2;
    const c = 100 + w;
    base.push(bar(i * 60000, c, c + 1, c - 1, c));
  }
  const idx = 20;
  const partial = getConfirmedSwings(base.slice(0, idx + 1), idx, opts);
  const full = getConfirmedSwings([...base, bar(99 * 60000, 101, 102, 100, 101)], idx, opts);
  assert.deepEqual(
    partial.highs.map((x) => x.pivotIdx),
    full.highs.map((x) => x.pivotIdx),
  );
  assert.deepEqual(
    partial.lows.map((x) => x.pivotIdx),
    full.lows.map((x) => x.pivotIdx),
  );
});

test("SMC orchestrator — evaluateBest path stable when future bars appended", () => {
  const candles = [];
  for (let i = 0; i < 80; i++) {
    const c = 500 + Math.sin(i / 6) * 4;
    candles.push(bar(i * 900000, c, c + 1.5, c - 1.5, c));
  }
  const idx = 55;
  const opts = {
    intradayGateSmcIct: true,
    intradaySmcKillzoneMode: "ALL",
    intradaySmcRequireHtfBias: false,
    intradaySmcVolFilterEnabled: false,
    intradaySmcMinAdx: 0,
    intradaySmcRequireMss: false,
    intradaySmcRequireRetrace: false,
  };
  const preP = precomputeIntraday(candles.slice(0, idx + 1));
  const preF = precomputeIntraday([...candles, bar(99 * 900000, 510, 511, 509, 510)]);
  let bestP = null;
  let bestF = null;
  for (const side of ["BUY", "SELL"]) {
    const p = evaluateSmcIctSetup(candles.slice(0, idx + 1), idx, side, preP, opts);
    const f = evaluateSmcIctSetup(candles, idx, side, preF, opts);
    if (p && (!bestP || (p.liqQuality ?? 0) > (bestP.liqQuality ?? 0))) bestP = p;
    if (f && (!bestF || (f.liqQuality ?? 0) > (bestF.liqQuality ?? 0))) bestF = f;
  }
  assert.equal(bestP?.action ?? null, bestF?.action ?? null);
});
