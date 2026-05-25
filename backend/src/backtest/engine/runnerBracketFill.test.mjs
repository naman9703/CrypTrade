import test from "node:test";
import assert from "node:assert/strict";
import { clampBracketFillToBar } from "./runner.js";

test("short trail exit below bar low clamps to bar low", () => {
  const bar = { low: 655.26, high: 655.89 };
  const fill = clampBracketFillToBar(653.72371269, bar);
  assert.equal(fill, 655.26);
});

test("long exit above bar high clamps to bar high", () => {
  const bar = { low: 100, high: 105 };
  const fill = clampBracketFillToBar(108, bar);
  assert.equal(fill, 105);
});
