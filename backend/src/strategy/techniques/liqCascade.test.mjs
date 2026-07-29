import assert from "node:assert/strict";
import {
  LIQ_CASCADE_WARMUP,
  buildLiqCascadeSeries,
  createCascadeTickTracker,
  evaluateCascadeTickSignal,
  liqIntervalToMs,
  prepareLiqBars,
  prepareOiBars,
  updateCascadeFromTick,
} from "./liqCascade.js";

// 1m candles, 5min liq/OI bars. Start aligned to a 5-min boundary.
const tfMs = 60_000;
const intervalMs = liqIntervalToMs("5min");
const START = 1_700_000_100_000;
assert.equal(START % intervalMs, 0, "test start must align to liq interval");

const N = LIQ_CASCADE_WARMUP + 120;
const spikeStart = LIQ_CASCADE_WARMUP + 30; // candle idx where the cascade liq bar opens
assert.equal((spikeStart * tfMs) % intervalMs, 0, "spike must open on a liq bar boundary");

function mkCandles() {
  const out = [];
  let px = 100;
  for (let i = 0; i < N; i++) {
    const ts = START + i * tfMs;
    const o = px;
    let shock = Math.sin(i / 7) * 0.25 + Math.sin(i / 3) * 0.12;
    // Cascade: hard sell-off during the spike liq bar span [spikeStart, spikeStart+5)
    if (i >= spikeStart && i < spikeStart + 5) shock = -1.1;
    // Stall/reclaim right after the liq bar completes
    if (i === spikeStart + 5) shock = 0.3;
    const c = px + shock;
    px = c;
    out.push({
      ts,
      open: o,
      high: Math.max(o, c) + 0.6,
      low: Math.min(o, c) - 0.6,
      close: c,
      volume: 1000 + i,
    });
  }
  return out;
}

const candles = mkCandles();

// Liq bars every 5 min (ts = interval START, Coinalyze convention), quiet baseline
// with one long-liquidation spike bar opening at spikeStart.
const spikeBarOpenTs = START + spikeStart * tfMs;
const liqSeries = [];
for (let ts = START; ts < START + N * tfMs; ts += intervalMs) {
  if (ts === spikeBarOpenTs) {
    liqSeries.push({ ts, liqLongUsd: 900_000, liqShortUsd: 40_000 });
  } else {
    liqSeries.push({ ts, liqLongUsd: 20_000 + (ts % 7_000), liqShortUsd: 18_000 + (ts % 5_000) });
  }
}
const oiSeries = [];
for (let ts = START; ts < START + N * tfMs; ts += intervalMs) {
  oiSeries.push({ ts, oiCloseUsd: ts >= spikeBarOpenTs ? 980_000_000 : 1_000_000_000 });
}

// --- prepareLiqBars: z spike, dominance, causal close-time keying ---
const liqBars = prepareLiqBars(liqSeries, { intervalMs, lookbackBars: 48 });
const spikeBar = liqBars.find((b) => b.tsOpen === spikeBarOpenTs);
assert.ok(spikeBar, "spike bar missing");
assert.equal(spikeBar.ts, spikeBarOpenTs + intervalMs, "bar must be keyed at close time");
assert.ok(spikeBar.z != null && spikeBar.z > 2, `expected z spike, got ${spikeBar.z}`);
assert.equal(spikeBar.dom, "longs");

// --- prepareOiBars: bar-over-bar drop ---
const oiBars = prepareOiBars(oiSeries, intervalMs);
const oiDropBar = oiBars.find((b) => b.ts === spikeBarOpenTs + intervalMs);
assert.ok(oiDropBar?.dropPct > 1.9, `expected ~2% OI drop, got ${oiDropBar?.dropPct}`);

// --- buildLiqCascadeSeries: fade signal, only after liq bar completes ---
const opts = {
  liqInterval: "5min",
  liqZScoreMin: 1.5,
  minOiDropPct: 0.5,
  minDispAtrMult: 0.5,
  minLiqUsdBar: 100_000,
  minAtrPct: 0.001,
};
const { series } = buildLiqCascadeSeries(candles, { liqSeries, oiSeries, opts });
const hitIdxs = series.map((s, i) => (s ? i : null)).filter((i) => i != null);
assert.ok(hitIdxs.length >= 1, `expected cascade signals, got ${hitIdxs.length}`);
const firstHit = hitIdxs[0];
const barCloseIdx = spikeStart + 5;
assert.ok(
  firstHit >= barCloseIdx,
  `look-ahead: signal at idx ${firstHit} before liq bar close idx ${barCloseIdx}`,
);
assert.equal(series[firstHit].action, "BUY", "fade of long liquidations must be BUY");
assert.ok(series[firstHit].liqBrackets?.slPct > 0);
assert.ok(series[firstHit].liqBrackets?.tpPct > 0);

// One signal max per liq bar
const spikeSignals = hitIdxs.filter((i) => i >= barCloseIdx && i < barCloseIdx + 5);
assert.ok(spikeSignals.length <= 1, "must dedupe signals per liq bar");

// --- continuation mode flips the side ---
const { series: contSeries } = buildLiqCascadeSeries(candles, {
  liqSeries,
  oiSeries,
  opts: { ...opts, directionMode: "continuation" },
});
const contHit = contSeries.find(Boolean);
if (contHit) assert.equal(contHit.action, "SELL");

// --- tick tracker (live path) ---
const tracker = createCascadeTickTracker({ minLiqUsdBar: 10_000, cascadeWindowBars: 2 });
for (let i = 0; i < 20; i++) {
  updateCascadeFromTick(tracker, {
    time: 1_700_000_000_000 + i * 1000,
    side: "SELL",
    notionalUsd: 80_000,
    price: 100 - i * 0.1,
  });
}
for (let i = 0; i < 3; i++) {
  updateCascadeFromTick(tracker, {
    time: 1_700_000_020_000 + i * 1000,
    side: "SELL",
    notionalUsd: 5_000,
    price: 98,
  });
}
const sig = evaluateCascadeTickSignal(tracker, 98.2);
assert.ok(sig?.action === "BUY" || sig === null);

console.log("liqCascade.test.mjs OK", { hits: hitIdxs.length, firstHit, barCloseIdx });
