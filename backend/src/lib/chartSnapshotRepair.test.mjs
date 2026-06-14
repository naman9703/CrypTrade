import test from "node:test";
import assert from "node:assert/strict";
import { chartMinBarsForSnapshot, chartSnapshotNeedsRestRepair } from "./chartSnapshotRepair.js";

test("chartSnapshotNeedsRestRepair when buffer thinner than min bars", () => {
  assert.equal(chartSnapshotNeedsRestRepair([{ ts: 1 }], { supertrendPeriod: 10 }), true);
  assert.equal(chartSnapshotNeedsRestRepair(new Array(50).fill({ ts: 1 }), { supertrendPeriod: 10 }), false);
});

test("chartSnapshotNeedsRestRepair when tail stale even with enough bars", () => {
  const bars = new Array(50).fill({ ts: 1 });
  assert.equal(chartSnapshotNeedsRestRepair(bars, { supertrendPeriod: 10, tailStale: true }), true);
  assert.equal(chartSnapshotNeedsRestRepair(bars, { supertrendPeriod: 10, tailStale: false }), false);
});

test("chartMinBarsForSnapshot respects supertrend period", () => {
  assert.equal(chartMinBarsForSnapshot(10), 30);
  assert.equal(chartMinBarsForSnapshot(25), 30);
});
