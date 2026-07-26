#!/usr/bin/env node
/**
 * BUYBD + compression≥0.75 — walk-forward + Monte Carlo + 4-gate harness.
 *
 * Windows (causal, no calendar cherry-pick for live readiness):
 *   HOLD  2023-07-01 → 2024-07-01  (pre-tune holdout)
 *   IS    2024-07-01 → 2025-07-01
 *   OOS   2025-07-01 → 2026-07-24
 *   FULL  2023-07-01 → 2026-07-24
 *   Per-half reporting on FULL (must not hide a red half).
 *
 * Usage (backend/): SKIP_ENSURE=1 node scripts/research-liq-buybd-comp075-validate.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "BNBUSDT";
const TF = "15m";
const PAD = 150 * 864e5;

const WINDOWS = {
  HOLD: [Date.parse("2023-07-01"), Date.parse("2024-07-01")],
  IS: [Date.parse("2024-07-01"), Date.parse("2025-07-01")],
  OOS: [Date.parse("2025-07-01"), Date.parse("2026-07-24")],
  FULL: [Date.parse("2023-07-01"), Date.parse("2026-07-24")],
};

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildIntradayBacktestAdapter } = await import("../src/strategy/intradayPro.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const {
  INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { monteCarloBootstrap, acceptanceGates, purgedWalkForwardSplits } = await import(
  "../src/backtest/engine/validation.js"
);

function rOf(t) {
  let risk = Number(t.initialRiskUsd ?? 0);
  if (!(risk > 0)) {
    const entry = Number(t.entryPrice ?? t.entryFill);
    const stop = Number(t.initialSlPrice ?? t.slPrice ?? t.stopPrice);
    const qty = Math.abs(Number(t.qty) || 0);
    if (Number.isFinite(entry) && Number.isFinite(stop) && stop > 0 && qty > 0) {
      risk = Math.abs(entry - stop) * qty;
    }
  }
  return risk > 0 ? Number(t.netPnl) / risk : null;
}

function halfKey(ts) {
  const d = new Date(Number(ts));
  return `${d.getUTCFullYear()}H${d.getUTCMonth() < 6 ? 1 : 2}`;
}

function maxDdFromCurve(curve) {
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of curve ?? []) {
    const e = Number(p.equity ?? p.eq ?? 0);
    if (e > peak) peak = e;
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - e) / peak) * 100);
  }
  return maxDd;
}

async function runWindow(label, from, to, candlesAll, fundingAll) {
  clearIntradayAdapterCache?.();
  const slice = candlesAll.filter((c) => Number(c.ts) >= from - PAD && Number(c.ts) < to);
  const funding = fundingAll.filter((f) => Number(f.ts ?? f.time) >= from - PAD && Number(f.ts ?? f.time) < to);
  let cfg = {
    ...INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M,
    // Keep research guards off for expectancy measurement; live uses preset guards.
    maxDailyLoss: 0,
    riskConsecutiveLossLimit: 0,
    backtestSignalStartMs: from,
  };
  cfg = materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
  const adapter = buildIntradayBacktestAdapter(slice, cfg, TF);
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles: slice,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: 100,
    timeframe: TF,
    adapters: { SR_INTRADAY: adapter, INTRADAY_PRO: adapter },
    symbol: SYMBOL,
  });
  const trades = (sim.trades ?? [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= from && Number(t.entryTs) < to);
  const weeks = (to - from) / (7 * 864e5);
  const finalEq = Number(sim.finalEquity ?? 100);
  const retPct = ((finalEq - 100) / 100) * 100;
  const ddPct = maxDdFromCurve(sim.equityCurve);
  const rs = trades.map(rOf).filter((x) => x != null && Number.isFinite(x));
  const meanR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
  const pos = rs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const neg = rs.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  const pfR = neg < 0 ? pos / -neg : pos > 0 ? 99 : 0;
  const years = (to - from) / (365.25 * 864e5);
  const cagr = years > 0 && finalEq > 0 ? (Math.pow(finalEq / 100, 1 / years) - 1) * 100 : null;
  const calmar = ddPct > 0 && cagr != null ? cagr / ddPct : cagr != null && cagr > 0 ? 99 : 0;
  const halves = {};
  for (const h of [...new Set(trades.map((t) => halfKey(t.entryTs)))].sort()) {
    const hrs = trades.filter((t) => halfKey(t.entryTs) === h).map(rOf).filter((x) => x != null);
    halves[h] = {
      n: hrs.length,
      meanR: hrs.length ? +(hrs.reduce((a, b) => a + b, 0) / hrs.length).toFixed(3) : null,
    };
  }
  const row = {
    label,
    n: trades.length,
    tw: +(trades.length / weeks).toFixed(2),
    retPct: +retPct.toFixed(2),
    ddPct: +ddPct.toFixed(2),
    meanR: meanR != null ? +meanR.toFixed(3) : null,
    pfR: +pfR.toFixed(3),
    wr: trades.length ? +((trades.filter((t) => Number(t.netPnl) > 0).length / trades.length) * 100).toFixed(1) : null,
    cagr: cagr != null ? +cagr.toFixed(2) : null,
    calmar: +Number(calmar).toFixed(2),
    halves,
    rs,
  };
  console.log(
    `${label.padEnd(5)} n=${String(row.n).padStart(3)} tw=${String(row.tw).padStart(5)} ret=${String(row.retPct).padStart(7)}% dd=${String(row.ddPct).padStart(5)}% pfR=${String(row.pfR).padStart(6)} meanR=${String(row.meanR).padStart(7)} calmar=${row.calmar}`,
  );
  if (Object.keys(halves).length) {
    console.log(
      `      halves: ${Object.entries(halves)
        .map(([h, m]) => `${h}:${m.meanR}(n${m.n})`)
        .join(" ")}`,
    );
  }
  return row;
}

console.log("=== BUYBD+comp≥0.75 validate (preset includes compression) ===");
console.log(`preset compressionMin=${INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M.intradayLiqRangeCompressionMin}`);

const fullFrom = WINDOWS.FULL[0];
const fullTo = WINDOWS.FULL[1];
const candlesAll = await readCandles(SYMBOL, TF, fullFrom - PAD, fullTo, { market: "futures" });
const fundingAll = await readFundingRates(SYMBOL, fullFrom - PAD, fullTo).catch(() => []);

const results = {};
for (const [label, [from, to]] of Object.entries(WINDOWS)) {
  results[label] = await runWindow(label, from, to, candlesAll, fundingAll);
}

// Walk-forward on FULL trade R sequence (purged folds)
const fullRs = results.FULL.rs;
const splits = purgedWalkForwardSplits(fullRs.length, { folds: 4, embargo: 2, mode: "rolling", minTrain: 30 });
const foldStats = [];
for (const s of splits) {
  const train = fullRs.slice(s.trainStart, s.trainEnd);
  const test = fullRs.slice(s.testStart, s.testEnd);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const trainM = mean(train);
  const testM = mean(test);
  const deg = trainM !== 0 ? ((trainM - testM) / Math.abs(trainM)) * 100 : 0;
  foldStats.push({ fold: s.fold, trainN: train.length, testN: test.length, trainMeanR: +trainM.toFixed(3), testMeanR: +testM.toFixed(3), degPct: +deg.toFixed(1) });
}
const avgDeg =
  foldStats.length > 0 ? foldStats.reduce((a, f) => a + f.degPct, 0) / foldStats.length : 999;
console.log("\n══ Walk-forward (trade-R folds) ══");
for (const f of foldStats) {
  console.log(
    `  fold${f.fold} train n=${f.trainN} meanR=${f.trainMeanR} | test n=${f.testN} meanR=${f.testMeanR} | deg=${f.degPct}%`,
  );
}
console.log(`  avg degradation = ${avgDeg.toFixed(1)}%`);

// Monte Carlo on OOS R
const mc = monteCarloBootstrap(results.OOS.rs, { paths: 2000, riskFrac: 0.025, seed: 20260725 });
console.log("\n══ Monte Carlo (OOS R, riskFrac=2.5%) ══");
console.log(
  `  p5=${mc.p5ReturnPct.toFixed(1)}% p50=${mc.p50ReturnPct.toFixed(1)}% p95=${mc.p95ReturnPct.toFixed(1)}% medianDD=${mc.medianMaxDdPct.toFixed(1)}% RoR=${mc.riskOfRuinPct.toFixed(1)}%`,
);

const gates = acceptanceGates({
  oosReturnPct: results.OOS.retPct,
  mcP5ReturnPct: mc.p5ReturnPct,
  calmar: results.FULL.calmar,
  walkForwardDegradationPct: avgDeg,
});
console.log("\n══ Acceptance gates ══");
for (const [k, g] of Object.entries(gates.gates)) {
  console.log(`  ${g.pass ? "PASS" : "FAIL"} ${k}: ${g.value} (need ${g.threshold})`);
}
console.log(`  ALL = ${gates.allPass ? "PASS" : "FAIL"}`);

// Research frequency floor
const freqOk = results.OOS.tw >= 2 && results.HOLD.tw >= 1.5 && results.FULL.tw >= 2;
console.log(`\nFrequency floor: OOS tw=${results.OOS.tw} HOLD tw=${results.HOLD.tw} FULL tw=${results.FULL.tw} → ${freqOk ? "OK" : "FAIL"}`);

// Per-half red check on FULL
const redHalves = Object.entries(results.FULL.halves).filter(
  ([, m]) => m.n >= 10 && (m.meanR ?? 0) < -0.05,
);
console.log(
  `Per-half red (meanR<-0.05, n≥10): ${redHalves.length ? redHalves.map(([h, m]) => `${h}:${m.meanR}`).join(", ") : "none"}`,
);

const verdict =
  gates.allPass && freqOk && redHalves.length === 0
    ? "ACCEPT_RESEARCH_SLEEVE"
    : gates.gates.oosPositive.pass && freqOk
      ? "PROMISING_PARTIAL_GATES"
      : "REJECT";
console.log(`\nVERDICT: ${verdict}`);

fs.writeFileSync(
  path.join(__dirname, ".liq-buybd-comp075-validate.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      preset: "INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M",
      compressionMin: INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M.intradayLiqRangeCompressionMin,
      results: Object.fromEntries(
        Object.entries(results).map(([k, v]) => {
          const { rs, ...rest } = v;
          return [k, rest];
        }),
      ),
      walkForward: { folds: foldStats, avgDegPct: +avgDeg.toFixed(1) },
      monteCarlo: mc,
      gates,
      freqOk,
      redHalves: redHalves.map(([h, m]) => ({ h, ...m })),
      verdict,
    },
    null,
    2,
  ),
);
console.log("Wrote .liq-buybd-comp075-validate.json");
await closePool?.();
