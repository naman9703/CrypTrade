import test from "node:test";
import assert from "node:assert/strict";
import { buildBacktestTrailEventSeries } from "./backtestTrailEventOverlays.ts";
import { buildCandleChartSeries } from "./backtestChartTime.ts";

test("buildBacktestTrailEventSeries maps activation, next gate, and SL path", () => {
  const candles = [
    { ts: 1_000_000, open: 100, high: 101, low: 99, close: 100 },
    { ts: 1_060_000, open: 100, high: 102, low: 99, close: 101 },
    { ts: 1_120_000, open: 101, high: 103, low: 100, close: 102 },
  ];
  const { chartTimesSec, indexByTs } = buildCandleChartSeries(candles);
  const trade = {
    direction: "BUY",
    trailEvents: [
      {
        ts: 1_059_999,
        step: 1,
        tierLabel: "T01",
        slPrice: 100.5,
        favorablePx: 101.2,
        nextActivationPx: 101.5,
      },
      {
        ts: 1_119_999,
        step: 2,
        tierLabel: "T02",
        slPrice: 100.8,
        favorablePx: 102.1,
        nextActivationPx: 102.4,
      },
    ],
  };
  const series = buildBacktestTrailEventSeries(trade, candles, chartTimesSec, indexByTs);
  assert.equal(series.activations.length, 2);
  assert.equal(series.nextGates.length, 2);
  assert.equal(series.slPath.length, 2);
  assert.equal(series.activations[0]?.value, 101.2);
  assert.equal(series.nextGates[0]?.value, 101.5);
  assert.equal(series.slPath[1]?.value, 100.8);
});
