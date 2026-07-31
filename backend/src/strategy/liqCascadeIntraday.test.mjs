import assert from "node:assert/strict";
import { aggregateTicksToLiqSeries } from "./liqCascadeIntraday.js";
import { liqIntervalToMs } from "./techniques/liqCascade.js";

const intervalMs = liqIntervalToMs("5min");
const fromMs = Math.floor(1_700_000_000_000 / intervalMs) * intervalMs;
const toMs = fromMs + intervalMs * 3;

const ticks = [
  { time: fromMs + 60_000, side: "SELL", notionalUsd: 50_000 },
  { time: fromMs + 120_000, side: "SELL", notionalUsd: 30_000 },
  { time: fromMs + intervalMs + 30_000, side: "BUY", notionalUsd: 20_000 },
];

const sparse = aggregateTicksToLiqSeries(ticks, intervalMs);
assert.equal(sparse.length, 2, "sparse mode only emits buckets with ticks");

const filled = aggregateTicksToLiqSeries(ticks, intervalMs, fromMs, toMs);
assert.equal(filled.length, 4, "filled mode emits every interval in range");
assert.equal(filled[0].liqLongUsd, 80_000);
assert.equal(filled[1].liqShortUsd, 20_000);
assert.equal(filled[2].liqLongUsd + filled[2].liqShortUsd, 0);

console.log("liqCascadeIntraday.test.mjs OK");
