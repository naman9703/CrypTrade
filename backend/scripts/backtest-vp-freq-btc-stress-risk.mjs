#!/usr/bin/env node
/**
 * BTC VP FREQ — stress scenarios + risk-overlay ablations on locked preset.
 *
 * Usage: node scripts/backtest-vp-freq-btc-stress-risk.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const FROM = process.env.FROM || "2022-06-01";
const TO = process.env.TO || "2026-05-31";
const START = 100;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const {
  VOLUME_PROFILE_FREQ_BTC_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");
const {
  SYNTHETIC_SCENARIOS,
  REAL_CRASH_WINDOWS,
  liquidityCrunchCostModel,
} = await import("../src/backtest/engine/stressScenarios.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

function cfg(over = {}) {
  return {
    ...VOLUME_PROFILE_FREQ_BTC_15M,
    symbol: "BTCUSDT",
    timeframe: "15m",
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE",
    riskPerTrade: 2.5,
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
    backtestSignalStartMs: fromMs,
    ...over,
  };
}

async function run(candles, funding, over = {}) {
  const c = cfg(over);
  const adapters = { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, c, "15m") };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg: c,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START,
    timeframe: "15m",
    symbol: "BTCUSDT",
    adapters,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: "15m",
    startingEquity: START,
  });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  return {
    n: closed.length,
    ret: m.totalReturnPct,
    dd: m.maxDrawdownPct,
    pf: m.profitFactor,
    calmar: m.calmar,
  };
}

const candles = await readCandles(
  "BTCUSDT",
  "15m",
  volumeProfilePadFromMs(fromMs, "15m", VOLUME_PROFILE_FREQ_BTC_15M),
  toMs,
  { market: "futures" },
);
let funding = [];
try {
  funding = await readFundingRates("BTCUSDT", fromMs, toMs);
} catch {
  funding = [];
}

console.log(`\n=== BTC VP FREQ stress/risk — ${FROM}→${TO} bars=${candles.length} ===\n`);

const baseline = await run(candles, funding);
console.log(`baseline N=${baseline.n} ret=${baseline.ret.toFixed(1)}% DD=${baseline.dd.toFixed(1)}%`);

const riskOverlays = [
  { label: "kill_dd_15", patch: { riskKillSwitchDdPct: 15 } },
  { label: "weekly_8", patch: { riskWeeklyMaxLossPct: 8 } },
  { label: "consec_3", patch: { riskConsecutiveLossLimit: 3 } },
  {
    label: "stack_safe",
    patch: { riskKillSwitchDdPct: 15, riskWeeklyMaxLossPct: 8, riskConsecutiveLossLimit: 3, volTargetSizing: true },
  },
];

const riskRows = [];
console.log("\nRISK OVERLAY ABLATION:");
for (const r of riskOverlays) {
  const out = await run(candles, funding, r.patch);
  riskRows.push({ label: r.label, ...out });
  console.log(
    `  ${r.label.padEnd(12)} N=${out.n} ret=${out.ret.toFixed(1)}% DD=${out.dd.toFixed(1)}% Calmar=${Number(out.calmar ?? 0).toFixed(2)}`,
  );
}

const stressRows = [];
console.log("\nSYNTHETIC STRESS:");
for (const sc of SYNTHETIC_SCENARIOS) {
  if (sc.kind === "candles") {
    const shocked = sc.apply(candles);
    const out = await run(shocked, funding);
    stressRows.push({ id: sc.id, label: sc.label, ...out });
    console.log(`  ${sc.id.padEnd(20)} N=${out.n} ret=${out.ret.toFixed(1)}% DD=${out.dd.toFixed(1)}%`);
  } else if (sc.kind === "costModel") {
    const out = await run(candles, funding, sc.applyCost({ slippagePct: 0.0005 }));
    stressRows.push({ id: sc.id, label: sc.label, ...out });
    console.log(`  ${sc.id.padEnd(20)} N=${out.n} ret=${out.ret.toFixed(1)}% DD=${out.dd.toFixed(1)}%`);
  }
}

// Extra cost ladders
for (const [label, patch] of [
  ["slip_x2", { slippagePct: 0.001 }],
  ["slip_x4", { slippagePct: 0.002 }],
  ["liq_x8", liquidityCrunchCostModel({ slippagePct: 0.0005 })],
]) {
  const out = await run(candles, funding, patch);
  stressRows.push({ id: label, label, ...out });
  console.log(`  ${label.padEnd(20)} N=${out.n} ret=${out.ret.toFixed(1)}% DD=${out.dd.toFixed(1)}%`);
}

const crashRows = [];
console.log("\nREAL CRASH WINDOWS:");
for (const w of REAL_CRASH_WINDOWS) {
  const a = Date.parse(w.from);
  const b = Date.parse(w.to);
  const slice = await readCandles(
    "BTCUSDT",
    "15m",
    volumeProfilePadFromMs(a, "15m", VOLUME_PROFILE_FREQ_BTC_15M),
    b,
    { market: "futures" },
  );
  if (!slice?.length) {
    console.log(`  ${w.id}: no data`);
    continue;
  }
  let fund = [];
  try {
    fund = await readFundingRates("BTCUSDT", a, b);
  } catch {
    fund = [];
  }
  const c = {
    ...VOLUME_PROFILE_FREQ_BTC_15M,
    symbol: "BTCUSDT",
    timeframe: "15m",
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE",
    riskPerTrade: 2.5,
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
    backtestSignalStartMs: a,
  };
  const adapters = { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(slice, c, "15m") };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles: slice,
    cfg: c,
    gateMode: "off",
    fundingRates: fund,
    startingUsdt: START,
    timeframe: "15m",
    symbol: "BTCUSDT",
    adapters,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: "15m",
    startingEquity: START,
  });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const row = { id: w.id, label: w.label, n: closed.length, ret: m.totalReturnPct, dd: m.maxDrawdownPct };
  crashRows.push(row);
  console.log(`  ${w.id.padEnd(14)} N=${row.n} ret=${row.ret.toFixed(1)}% DD=${row.dd.toFixed(1)}%`);
}

// Lock risk overlay only if it cuts DD without crushing return below 70% of baseline.
const lockRisk = riskRows.find((r) => r.label === "stack_safe");
const riskLockOk =
  lockRisk &&
  lockRisk.dd <= baseline.dd + 0.1 &&
  lockRisk.ret >= baseline.ret * 0.7 &&
  lockRisk.n >= Math.floor(baseline.n * 0.5);

const report = {
  generatedAt: new Date().toISOString(),
  window: { from: FROM, to: TO },
  baseline,
  riskRows,
  stressRows,
  crashRows,
  riskOverlayLock: riskLockOk
    ? { ...lockRisk.patchSuggested, note: "stack_safe candidate" }
    : { note: "keep overlays OFF (0) — ablation did not clearly improve risk/return" },
  recommendedOverlay: riskLockOk
    ? { riskKillSwitchDdPct: 15, riskWeeklyMaxLossPct: 8, riskConsecutiveLossLimit: 3, volTargetSizing: true }
    : { riskKillSwitchDdPct: 0, riskWeeklyMaxLossPct: 0, riskConsecutiveLossLimit: 0, volTargetSizing: false },
};

// Fix report - I referenced undefined patchSuggested
report.riskOverlayLock = riskLockOk
  ? { candidate: "stack_safe", ...lockRisk }
  : { note: "keep overlays OFF (0) — ablation did not clearly improve risk/return without masking edge" };

const outPath = path.resolve(__dirname, ".vp-freq-btc-stress-risk.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.error("\nwrote", outPath);
console.log(`\nRISK OVERLAY RECOMMENDATION: ${riskLockOk ? "LOCK stack_safe" : "KEEP OFF (research default)"}`);
await closePool?.();
