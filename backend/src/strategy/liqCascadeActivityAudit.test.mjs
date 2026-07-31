import assert from "node:assert/strict";
import {
  buildLiqCascadeGateRows,
  collectLiqCascadeBarCloseAuditEvents,
  formatLiqCascadeSkipReason,
  initLiqCascadeActivityPersisted,
  stepLiqCascadeActivityAudit,
} from "./liqCascadeActivityAudit.js";
import { LIQ_CASCADE_WARMUP, liqIntervalToMs, prepareLiqBars, prepareOiBars } from "./techniques/liqCascade.js";

const tfMs = 60_000;
const intervalMs = liqIntervalToMs("5min");
const START = 1_700_000_200_000;
const N = LIQ_CASCADE_WARMUP + 80;
const spikeStart = LIQ_CASCADE_WARMUP + 30;

function mkCandles() {
  const out = [];
  let px = 100;
  for (let i = 0; i < N; i++) {
    const ts = START + i * tfMs;
    const o = px;
    let shock = Math.sin(i / 7) * 0.2;
    if (i >= spikeStart && i < spikeStart + 5) shock = -1.1;
    const c = px + shock;
    px = c;
    out.push({
      ts,
      open: o,
      high: Math.max(o, c) + 0.5,
      low: Math.min(o, c) - 0.5,
      close: c,
      volume: 1000,
    });
  }
  return out;
}

const candles = mkCandles();
const spikeBarOpenTs = START + spikeStart * tfMs;
const liqSeries = [];
for (let ts = START; ts < START + N * tfMs; ts += intervalMs) {
  if (ts === spikeBarOpenTs) {
    liqSeries.push({ ts, liqLongUsd: 900_000, liqShortUsd: 40_000 });
  } else {
    liqSeries.push({ ts, liqLongUsd: 20_000, liqShortUsd: 18_000 });
  }
}
const oiSeries = [];
for (let ts = START; ts < START + N * tfMs; ts += intervalMs) {
  oiSeries.push({ ts, oiCloseUsd: 1_000_000_000 });
}

const opts = {
  liqInterval: "5min",
  liqZScoreMin: 1.5,
  minOiDropPct: 0.5,
  oiGateMode: "same_bar",
  minDispAtrMult: 1.0,
  minLiqUsdBar: 100_000,
  minAtrPct: 0.001,
  confirmMode: "ladder",
};

const liqBars = prepareLiqBars(liqSeries, { intervalMs, lookbackBars: 48 });
const oiBars = prepareOiBars(oiSeries, intervalMs);
const barCloseIdx = spikeStart + 5;
const persisted = initLiqCascadeActivityPersisted();

const events = stepLiqCascadeActivityAudit(persisted, candles, barCloseIdx, {
  opts,
  liqBars,
  oiBars,
});

assert.ok(events.length >= 1, "expected gate skip");
assert.equal(events[0].type, "gate_skip");
assert.equal(events[0].failedGate.key, "oiDrop");
assert.ok(formatLiqCascadeSkipReason(events[0]).includes("gate:oiDrop"));

const spikeBar = liqBars.find((b) => b.tsOpen === spikeBarOpenTs);
const gates = buildLiqCascadeGateRows(spikeBar, {
  disp: 0.2,
  atrPct: 0.05,
  oiGate: { ok: false, dropPct: 0, mode: "same_bar" },
  opts,
});
assert.equal(gates.find((g) => g.key === "oiDrop")?.pass, false);

const persisted2 = initLiqCascadeActivityPersisted();
const collected = collectLiqCascadeBarCloseAuditEvents(persisted2, candles, barCloseIdx, {
  liqSeries,
  oiSeries,
  opts,
});
assert.ok(collected.length >= 1);
const again = collectLiqCascadeBarCloseAuditEvents(persisted2, candles, barCloseIdx, {
  liqSeries,
  oiSeries,
  opts,
});
assert.equal(again.length, 0, "dedupe same skip");

console.log("liqCascadeActivityAudit.test.mjs OK", { gateSkip: events[0].reasonCode });
