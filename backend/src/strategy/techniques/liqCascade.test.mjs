import assert from "node:assert/strict";
import { atr as atrFn } from "../indicators.js";
import {
  LIQ_CASCADE_WARMUP,
  buildBrackets,
  buildLiqCascadeSeries,
  computeInBarDisplacement,
  createCascadeTickTracker,
  evaluateCascadeTickSignal,
  liqExhaustionConfirm,
  liqIntervalToMs,
  oiWindowDropPct,
  prepareLiqBars,
  prepareOiBars,
  resolveOiGate,
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
  oiGateMode: "same_bar",
  confirmMode: "stall_reclaim",
  confirmLiqBars: 1,
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

// --- oiWindowDropPct: cascade unwind over N bars, not same-bar noise ---
const oiBarsSimple = [
  { ts: 1000, oi: 1_000_000, dropPct: null },
  { ts: 2000, oi: 1_000_000, dropPct: 0 },
  { ts: 3000, oi: 1_000_000, dropPct: 0 },
  { ts: 4000, oi: 1_000_000, dropPct: 0 },
  { ts: 5000, oi: 990_000, dropPct: 1 },
];
const windowDrop = oiWindowDropPct(oiBarsSimple, 5000, 3);
assert.ok(windowDrop != null && windowDrop >= 0.99, `window OI drop expected ~1%, got ${windowDrop}`);
const oiGateWindow = resolveOiGate(oiBarsSimple, 5000, {
  oiGateMode: "window",
  oiWindowBars: 3,
  minOiDropPct: 0.5,
});
assert.equal(oiGateWindow.ok, true, "window OI gate should pass on gradual unwind");

// --- confirm either: exhaustion on post-spike quiet liq bar ---
const liqWithDecay = [];
for (let ts = START; ts < START + N * tfMs; ts += intervalMs) {
  if (ts === spikeBarOpenTs) {
    liqWithDecay.push({ ts, liqLongUsd: 900_000, liqShortUsd: 40_000 });
  } else if (ts === spikeBarOpenTs + intervalMs) {
    liqWithDecay.push({ ts, liqLongUsd: 25_000, liqShortUsd: 20_000 });
  } else {
    liqWithDecay.push({ ts, liqLongUsd: 20_000, liqShortUsd: 18_000 });
  }
}
const decayBars = prepareLiqBars(liqWithDecay, { intervalMs, lookbackBars: 48 });
const postSpikeBar = decayBars.find((b) => b.tsOpen === spikeBarOpenTs + intervalMs);
assert.ok(
  postSpikeBar?.decayFromPeak != null && postSpikeBar.decayFromPeak <= 0.55,
  "post-spike bar should show exhaustion decay",
);
const cascadeStub = { liqBarTs: spikeBarOpenTs + intervalMs, dom: "longs" };
assert.ok(
  liqExhaustionConfirm(decayBars, postSpikeBar.ts, cascadeStub, { exhaustionDecayRatio: 0.55 }),
  "exhaustion confirm on post-spike decay bar",
);

// --- one-shot detection: no late chase when post-close move inflates displacement ---
const chaseStart = LIQ_CASCADE_WARMUP + 50;
assert.equal((chaseStart * tfMs) % intervalMs, 0, "chase spike must open on liq boundary");
const chaseBarOpenTs = START + chaseStart * tfMs;
const chaseCandles = [];
let chasePx = 100;
for (let i = 0; i < N; i++) {
  const ts = START + i * tfMs;
  const o = chasePx;
  let shock = Math.sin(i / 7) * 0.25;
  // Flat through liq bar close (in-bar disp ~0)
  if (i >= chaseStart && i <= chaseStart + 5) shock = 0;
  // Large continuation after bar close — old logic would chase here
  if (i >= chaseStart + 6 && i < chaseStart + 9) shock = -1.5;
  const c = chasePx + shock;
  chasePx = c;
  chaseCandles.push({
    ts,
    open: o,
    high: Math.max(o, c) + 0.6,
    low: Math.min(o, c) - 0.6,
    close: c,
    volume: 1000 + i,
  });
}
const chaseLiq = [];
for (let ts = START; ts < START + N * tfMs; ts += intervalMs) {
  if (ts === chaseBarOpenTs) {
    chaseLiq.push({ ts, liqLongUsd: 900_000, liqShortUsd: 40_000 });
  } else {
    chaseLiq.push({ ts, liqLongUsd: 20_000, liqShortUsd: 18_000 });
  }
}
const chaseOi = [];
for (let ts = START; ts < START + N * tfMs; ts += intervalMs) {
  chaseOi.push({ ts, oiCloseUsd: ts >= chaseBarOpenTs ? 980_000_000 : 1_000_000_000 });
}
const chaseBars = prepareLiqBars(chaseLiq, { intervalMs, lookbackBars: 48 });
const chaseSpike = chaseBars.find((b) => b.tsOpen === chaseBarOpenTs);
const chaseAtr = atrFn(chaseCandles, 14);
const inBar = computeInBarDisplacement(chaseCandles, chaseAtr, chaseSpike);
assert.ok(
  inBar.disp != null && inBar.disp < 1.0,
  `in-bar disp should stay below threshold, got ${inBar.disp}`,
);
// Post-close displacement would exceed threshold if re-checked on later candles.
const postCloseIdx = chaseStart + 8;
const postCloseDisp =
  chaseAtr[postCloseIdx] > 0
    ? Math.abs(chaseCandles[postCloseIdx].close - chaseCandles[chaseStart].close) /
      chaseAtr[postCloseIdx]
    : 0;
assert.ok(postCloseDisp >= 1.0, `post-close disp should exceed threshold, got ${postCloseDisp}`);
const { series: chaseSeries } = buildLiqCascadeSeries(chaseCandles, {
  liqSeries: chaseLiq,
  oiSeries: chaseOi,
  opts: {
    ...opts,
    oiGateMode: "same_bar",
    confirmMode: "ladder",
    minDispAtrMult: 1.0,
    strongDispAtrMult: 2.0,
  },
});
const chaseHits = chaseSeries.map((s, i) => (s ? i : null)).filter((i) => i != null);
assert.equal(chaseHits.length, 0, "must not chase post-close displacement inflation");

// --- Tier A: strong in-bar disp enters on bar close or +1 ---
const tierStart = LIQ_CASCADE_WARMUP + 70;
assert.equal((tierStart * tfMs) % intervalMs, 0);
const tierBarOpenTs = START + tierStart * tfMs;
const tierCandles = [];
let tierPx = 100;
for (let i = 0; i < N; i++) {
  const ts = START + i * tfMs;
  const o = tierPx;
  let shock = Math.sin(i / 7) * 0.25;
  if (i >= tierStart && i < tierStart + 5) shock = -2.5;
  const c = tierPx + shock;
  tierPx = c;
  tierCandles.push({
    ts,
    open: o,
    high: Math.max(o, c) + 0.6,
    low: Math.min(o, c) - 0.6,
    close: c,
    volume: 1000 + i,
  });
}
const tierLiq = [];
for (let ts = START; ts < START + N * tfMs; ts += intervalMs) {
  if (ts === tierBarOpenTs) {
    tierLiq.push({ ts, liqLongUsd: 900_000, liqShortUsd: 40_000 });
  } else {
    tierLiq.push({ ts, liqLongUsd: 20_000, liqShortUsd: 18_000 });
  }
}
const tierOi = [];
for (let ts = START; ts < START + N * tfMs; ts += intervalMs) {
  tierOi.push({ ts, oiCloseUsd: ts >= tierBarOpenTs ? 980_000_000 : 1_000_000_000 });
}
const { series: tierSeries } = buildLiqCascadeSeries(tierCandles, {
  liqSeries: tierLiq,
  oiSeries: tierOi,
  opts: {
    ...opts,
    oiGateMode: "same_bar",
    confirmMode: "ladder",
    minDispAtrMult: 1.0,
    strongDispAtrMult: 2.0,
  },
});
const tierHit = tierSeries.findIndex(Boolean);
const tierCloseIdx = tierStart + 5;
assert.ok(tierHit >= tierCloseIdx && tierHit <= tierCloseIdx + 1, "Tier A entry at bar close or +1");
assert.equal(tierSeries[tierHit].confirmTier, "A");

// --- buildBrackets: tpRr=1 sets TP distance equal to SL distance ---
const brAtr = atrFn(candles, 14);
const brCloses = candles.map((c) => Number(c.close));
const brIdx = spikeStart + 6;
const brAtrOnly = buildBrackets(candles, spikeStart, brIdx, "BUY", brAtr, brCloses, {
  slBufferPct: 0.0015,
  tpAtrMult: 1.25,
  tpRr: 0,
  minRr: 0.8,
});
const br1R = buildBrackets(candles, spikeStart, brIdx, "BUY", brAtr, brCloses, {
  slBufferPct: 0.0015,
  tpRr: 1,
  minRr: 0,
});
assert.ok(brAtrOnly, "ATR TP brackets expected");
assert.ok(br1R, "1R TP brackets expected");
assert.ok(Math.abs(br1R.tpPct - br1R.slPct) < 1e-9, "tpRr=1 must equal SL distance");
assert.ok(br1R.tpPct / br1R.slPct >= 0.99, "1R RR ~1");

// --- eventCooldownLiqBars: second cascade within cooldown is suppressed ---
const cdLiq = [];
for (let ts = START; ts < START + N * tfMs; ts += intervalMs) {
  if (ts === spikeBarOpenTs || ts === spikeBarOpenTs + intervalMs) {
    cdLiq.push({ ts, liqLongUsd: 900_000, liqShortUsd: 40_000 });
  } else {
    cdLiq.push({ ts, liqLongUsd: 20_000, liqShortUsd: 18_000 });
  }
}
const { series: cdSeries } = buildLiqCascadeSeries(candles, {
  liqSeries: cdLiq,
  oiSeries,
  opts: {
    ...opts,
    oiGateMode: "same_bar",
    minDispAtrMult: 1.0,
    eventCooldownLiqBars: 6,
  },
});
const cdHits = cdSeries.map((s, i) => (s ? i : null)).filter((i) => i != null);
assert.equal(cdHits.length, 1, "cooldown should allow only one cascade trade per cluster window");

console.log("liqCascade.test.mjs OK", { hits: hitIdxs.length, firstHit, barCloseIdx });
