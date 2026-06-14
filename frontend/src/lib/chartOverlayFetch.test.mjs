import test from "node:test";
import assert from "node:assert/strict";
import {
  chartOverlayDataEqual,
  chartOverlayFetchKey,
  chartOverlaySpanReady,
  fetchChartOverlayDeduped,
  resetChartOverlayFetchCacheForTests,
  shouldSkipRestCandleReconcile,
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
});
