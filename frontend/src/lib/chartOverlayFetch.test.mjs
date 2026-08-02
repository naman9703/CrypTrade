import test from "node:test";
import assert from "node:assert/strict";
import {
  chartOverlayDataEqual,
  chartOverlayFetchKey,
  chartOverlaySpanReady,
  fetchChartOverlayDeduped,
  resetChartOverlayFetchCacheForTests,
  shouldSkipRestCandleReconcile,
  restCandleResponseExpandsStore,
  chartBufferSpacingLooksWrong,
  chartBufferCoverageInsufficient,
} from "./chartOverlayFetch.ts";

test("chartOverlaySpanReady requires at least two bars and positive span", () => {
  assert.equal(chartOverlaySpanReady(100, 100, 1), false);
  assert.equal(chartOverlaySpanReady(100, 200, 1), false);
  assert.equal(chartOverlaySpanReady(100, 200, 2), true);
});

test("fetchChartOverlayDeduped coalesces concurrent and cached loads", async () => {
  resetChartOverlayFetchCacheForTests();
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return { events: [{ id: "1", title: "CPI", eventTime: "2026-01-01T00:00:00.000Z", impactLevel: "high" }], whales: [] };
  };
  const key = chartOverlayFetchKey("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "ETHUSDT");
  const [a, b] = await Promise.all([fetchChartOverlayDeduped(key, loader), fetchChartOverlayDeduped(key, loader)]);
  assert.equal(calls, 1);
  assert.equal(a.events[0]?.id, "1");
  assert.deepEqual(a, b);

  const c = await fetchChartOverlayDeduped(key, loader);
  assert.equal(calls, 1);
  assert.deepEqual(c, a);
});

test("chartOverlayDataEqual compares payload ids", () => {
  const a = { events: [{ id: "1", title: "x", eventTime: "t", impactLevel: "low" }], whales: [] };
  const b = { events: [{ id: "1", title: "x", eventTime: "t", impactLevel: "low" }], whales: [] };
  const c = { events: [{ id: "2", title: "x", eventTime: "t", impactLevel: "low" }], whales: [] };
  assert.equal(chartOverlayDataEqual(a, b), true);
  assert.equal(chartOverlayDataEqual(a, c), false);
});

test("shouldSkipRestCandleReconcile never skips initial hydrate or thin WS buffer", () => {
  const tail = { storeLastTs: 1_000, restLastTs: 1_000, storeMatchesView: true };
  assert.equal(
    shouldSkipRestCandleReconcile({ preserveView: false, storeBarCount: 1, ...tail }),
    false,
  );
  assert.equal(
    shouldSkipRestCandleReconcile({ preserveView: true, storeBarCount: 1, ...tail }),
    false,
  );
  assert.equal(
    shouldSkipRestCandleReconcile({ preserveView: true, storeBarCount: 120, ...tail }),
    true,
  );
  assert.equal(
    shouldSkipRestCandleReconcile({
      preserveView: true,
      storeBarCount: 120,
      timeframe: "1m",
      hours: 24,
      ...tail,
    }),
    false,
    "1m/24h needs ~1224 bars — 120 must not skip REST",
  );
});

test("restCandleResponseExpandsStore detects REST history backfill", () => {
  assert.equal(restCandleResponseExpandsStore(1, 96), true);
  assert.equal(restCandleResponseExpandsStore(120, 121), false);
});

test("chartBufferCoverageInsufficient rejects thin 1m WS buffer (15m chart ok)", () => {
  const tfMs = 60_000;
  const thin1m = [];
  let t = 1_000_000;
  for (let i = 0; i < 96; i++) {
    thin1m.push({ ts: t });
    t += tfMs;
  }
  assert.equal(chartBufferCoverageInsufficient(thin1m, "1m", 24), true);
  assert.equal(chartBufferCoverageInsufficient(thin1m, "15m", 24), false);

  const wrong15on1m = [];
  t = 2_000_000;
  for (let i = 0; i < 96; i++) {
    wrong15on1m.push({ ts: t });
    t += 15 * tfMs;
  }
  assert.equal(chartBufferCoverageInsufficient(wrong15on1m, "1m", 24), true);
});

test("chartBufferSpacingLooksWrong rejects wrong-interval WS buffer", () => {
  const tfMs = 60_000;
  const wrong = [];
  let t = 1_000_000;
  for (let i = 0; i < 20; i++) {
    wrong.push({ ts: t });
    t += 15 * tfMs;
  }
  assert.equal(chartBufferSpacingLooksWrong(wrong, "1m"), true);
  assert.equal(
    shouldSkipRestCandleReconcile({
      preserveView: true,
      storeBarCount: wrong.length,
      storeMatchesView: true,
      storeLastTs: wrong[wrong.length - 1].ts,
      restLastTs: wrong[wrong.length - 1].ts,
      timeframe: "1m",
      hours: 24,
      storeCandles: wrong,
    }),
    false,
    "gappy 15m-on-1m buffer must not skip REST",
  );
});
