import test from "node:test";
import assert from "node:assert/strict";
import {
  chartMinBarsForSnapshot,
  chartMinBarsForWindow,
  chartBufferSpacingLooksWrong,
  chartSnapshotNeedsRestRepair,
} from "./chartSnapshotRepair.js";

test("chartSnapshotNeedsRestRepair when buffer thinner than supertrend min bars", () => {
  assert.equal(chartSnapshotNeedsRestRepair([{ ts: 1 }], { supertrendPeriod: 10 }), true);
  assert.equal(chartSnapshotNeedsRestRepair(new Array(50).fill({ ts: 1 }), { supertrendPeriod: 10 }), false);
});

test("chartBufferSpacingLooksWrong detects wide gaps (wrong interval on chart tf)", () => {
  const tfMs = 60_000;
  const wrong = [];
  let t = 1_000_000;
  for (let i = 0; i < 20; i++) {
    wrong.push({ ts: t });
    t += 15 * tfMs;
  }
  assert.equal(chartBufferSpacingLooksWrong(wrong, "1m"), true);
  const ok = [];
  t = 2_000_000;
  for (let i = 0; i < 20; i++) {
    ok.push({ ts: t });
    t += tfMs;
  }
  assert.equal(chartBufferSpacingLooksWrong(ok, "1m"), false);
});

test("chartSnapshotNeedsRestRepair when bar spacing wrong for timeframe", () => {
  const tfMs = 60_000;
  const wrong = [];
  let t = 1_000_000;
  for (let i = 0; i < 1300; i++) {
    wrong.push({ ts: t });
    t += 15 * tfMs;
  }
  assert.equal(
    chartSnapshotNeedsRestRepair(wrong, { supertrendPeriod: 10, timeframe: "1m", hours: 24 }),
    true,
  );
});

test("chartSnapshotNeedsRestRepair when buffer thinner than requested window", () => {
  const fifty = new Array(50).fill({ ts: 1 });
  assert.equal(
    chartSnapshotNeedsRestRepair(fifty, { supertrendPeriod: 10, timeframe: "1m", hours: 24 }),
    true,
  );
  const full1mDay = new Array(1224).fill({ ts: 1 });
  assert.equal(
    chartSnapshotNeedsRestRepair(full1mDay, { supertrendPeriod: 10, timeframe: "1m", hours: 24 }),
    false,
  );
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

test("chartMinBarsForWindow scales with timeframe and hours", () => {
  assert.equal(chartMinBarsForWindow("15m", 24, 10), 81);
  assert.equal(chartMinBarsForWindow("1m", 24, 10), 1224);
});
