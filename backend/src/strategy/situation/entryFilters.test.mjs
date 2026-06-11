import { test } from "node:test";
import assert from "node:assert/strict";
import { passesEntryFilters } from "./entryFilters.js";
import { SITUATIONS as S } from "./situationConstants.js";

test("blocks exhaustion_long on extended day", () => {
  const dayState = { dayRangePct: () => 0.06 };
  const ok = passesEntryFilters([], 10, { htfDown: { 10: true }, adxSeries: { 10: 40 } }, dayState, {
    trigger: "exhaustion_long",
  }, S.BREAKDOWN_BEAR, { situationMaxDayRangeAtEntry: 0.04 });
  assert.equal(ok, false);
});

test("allows range displacement when day range ok", () => {
  const dayState = { dayRangePct: () => 0.02, bearBias: false };
  const ok = passesEntryFilters([], 10, { adxSeries: { 10: 25 } }, dayState, {
    trigger: "displacement_short",
  }, S.RANGE_ABOVE_PDL, {});
  assert.equal(ok, true);
});
