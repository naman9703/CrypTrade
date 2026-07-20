import test from "node:test";
import assert from "node:assert/strict";
import { LineStyle } from "lightweight-charts";
import { buildBacktestTrailTierLines } from "./backtestTrailTierLines.ts";

test("buildBacktestTrailTierLines returns lock + activation pairs for tiered elite run", () => {
  const run = {
    timeframe: "1h",
    configSnapshot: {
      bot: {
        trailingStopLossAuto: true,
        futuresTrailingStopMode: "SUPERTREND",
        futuresTrailingStFeeBreakeven: true,
        futuresTrailingStAdvanced: true,
        trailOpenFeeRate: 0.0004,
        trailCloseFeeRate: 0.0004,
        trailFeeBeMultiplier: 1,
        trailT01LockSlippageFrac: 0,
        trailBufferRate: 0.0005,
      },
    },
  };
  const trade = {
    direction: "BUY",
    entryPrice: 107906.02605,
  };
  const lines = buildBacktestTrailTierLines(run, trade);
  const labels = lines.map((l) => l.title);
  assert.deepEqual(labels, ["T01", "T01a", "T02", "T02a", "T1", "T1a", "T2", "T2a", "T3", "T3a"]);
  assert.ok(lines.every((l) => l.axisLabelVisible === false));

  for (let i = 0; i < TIER_PAIRS.length; i++) {
    const lock = lines[i * 2];
    const act = lines[i * 2 + 1];
    assert.ok(lock.price < act.price, `${lock.title} lock below ${act.title} activation on LONG`);
    assert.equal(lock.lineStyle, LineStyle.Dotted);
    assert.equal(act.lineStyle, LineStyle.Dashed);
  }
});

const TIER_PAIRS = ["T01", "T02", "T1", "T2", "T3"];

test("buildBacktestTrailTierLines empty when trailing off", () => {
  const run = {
    configSnapshot: { bot: { trailingStopLossAuto: false } },
  };
  const trade = { direction: "BUY", entryPrice: 100 };
  assert.equal(buildBacktestTrailTierLines(run, trade).length, 0);
});
