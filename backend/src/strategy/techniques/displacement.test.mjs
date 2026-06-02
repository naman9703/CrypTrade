import test from "node:test";
import assert from "node:assert/strict";
import { rollingAvgBody, passesDisplacementAt } from "./displacement.js";

function bar(o, h, l, c) {
  return { ts: 0, open: o, high: h, low: l, close: c, volume: 1 };
}

test("rollingAvgBody — average of prior bodies", () => {
  const candles = [
    bar(100, 101, 99, 100.5),
    bar(100.5, 101, 100, 100.2),
    bar(100.2, 101, 100, 100.8),
    bar(100.8, 102, 100, 101.5),
  ];
  const avg = rollingAvgBody(candles, 3, 3);
  assert.ok(avg > 0);
  assert.ok(avg < 1);
});

test("passesDisplacementAt — rejects tiny body vs rolling average", () => {
  const candles = [];
  for (let i = 0; i < 20; i++) {
    candles.push(bar(100, 100.2, 99.8, 100.05));
  }
  candles.push(bar(100, 100.08, 99.92, 100.04));
  const ok = passesDisplacementAt(candles, candles.length - 1, "BUY", {
    intradaySmcDisplacementBodyMult: 2.5,
    intradaySmcDisplacementAtrMult: 0,
  });
  assert.equal(ok, false);
});

test("passesDisplacementAt — accepts large directional body", () => {
  const candles = [];
  for (let i = 0; i < 20; i++) {
    candles.push(bar(100, 100.2, 99.8, 100.05));
  }
  candles.push(bar(100, 105, 99.5, 104));
  const ok = passesDisplacementAt(candles, candles.length - 1, "BUY", {
    intradaySmcDisplacementBodyMult: 1.2,
    intradaySmcDisplacementAtrMult: 0,
  });
  assert.equal(ok, true);
});
