import test from "node:test";
import assert from "node:assert/strict";
import { buildHtfBiasSeries } from "./htfBias.js";

function bar(ts, c) {
  return { ts, open: c, high: c + 1, low: c - 1, close: c, volume: 1 };
}

test("buildHtfBiasSeries — no lookahead when future bars appended", () => {
  const H4 = 4 * 60 * 60 * 1000;
  const base = [];
  for (let i = 0; i < 400; i++) {
    base.push(bar(i * 15 * 60 * 1000, 100 + Math.sin(i / 20) * 5));
  }
  const idx = 250;
  const partial = buildHtfBiasSeries(base.slice(0, idx + 1));
  const full = buildHtfBiasSeries([...base, bar(999 * H4, 200)]);
  assert.equal(partial.h4Up[idx], full.h4Up[idx]);
  assert.equal(partial.h4Down[idx], full.h4Down[idx]);
  assert.equal(partial.h4Sep[idx], full.h4Sep[idx]);
});
