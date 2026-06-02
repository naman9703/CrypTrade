import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCompleted4hBars,
  buildHtfStructureBiasSeries,
  structureBiasAllowsSide,
} from "./htfStructureBias.js";

const H4 = 4 * 60 * 60 * 1000;
const M15 = 15 * 60 * 1000;

function bar(ts, o, h, l, c) {
  return { ts, open: o, high: h, low: l, close: c, volume: 1 };
}

test("buildCompleted4hBars — aggregates 15m into closed 4H buckets", () => {
  const candles = [];
  const base = Date.UTC(2026, 0, 5, 0, 0, 0);
  for (let i = 0; i < 32; i++) {
    candles.push(bar(base + i * M15, 100, 101, 99, 100 + i * 0.1));
  }
  const h4 = buildCompleted4hBars(candles);
  assert.ok(h4.length >= 1);
  assert.equal(h4[0].closeChartIdx, 15);
});

test("buildHtfStructureBiasSeries — NEUTRAL allows both sides", () => {
  const candles = Array.from({ length: 400 }, (_, i) =>
    bar(i * M15, 100, 101, 99, 100 + Math.sin(i / 30) * 2),
  );
  const series = buildHtfStructureBiasSeries(candles);
  const idx = 300;
  if (series.h4StructureNeutral[idx]) {
    assert.equal(structureBiasAllowsSide("BUY", series, idx), true);
    assert.equal(structureBiasAllowsSide("SELL", series, idx), true);
  }
});

test("buildHtfStructureBiasSeries — no lookahead when future bars appended", () => {
  const base = [];
  for (let i = 0; i < 400; i++) {
    base.push(bar(i * M15, 100 + Math.sin(i / 20) * 5, 106, 94, 100 + Math.sin(i / 20) * 5));
  }
  const idx = 250;
  const partial = buildHtfStructureBiasSeries(base.slice(0, idx + 1));
  const full = buildHtfStructureBiasSeries([...base, bar(999 * H4, 200, 210, 190, 205)]);
  assert.equal(partial.h4StructureState[idx], full.h4StructureState[idx]);
});
