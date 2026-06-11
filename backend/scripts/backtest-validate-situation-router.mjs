#!/usr/bin/env node
/**
 * Validate SITUATION_INTRADAY — monthly, Jun 1-4, attribution, WF, MC gates.
 * Usage: node scripts/backtest-validate-situation-router.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SYMBOL = process.env.SYMBOL || "BNBUSDT";
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2025-06-01";
const TO = process.env.TO || "2026-06-05";
const RISK = Number(process.env.RISK || 2);
const START_USDT = Number(process.env.START_USDT || 100);

const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const { buildSituationIntradayBacktestAdapter } = await import("../src/strategy/situationIntraday.js");
const { BNB_SITUATION_ROUTER_15M } = await import("../src/strategy/presets/bnbSituationRouter.js");
const { INTRADAY_PRO_LIQ_DAILY_15M, fillLiqSoloPresetDefaults, fillFibSoloPresetDefaults } =
  await import("../src/strategy/presets/srIntradayOptimized.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { mergeAdaptiveCfg, buildIntradayBacktestAdapter } = await import("../src/strategy/intradayPro.js");
const { monteCarloBootstrap, purgedWalkForwardSplits, acceptanceGates } = await import(
  "../src/backtest/engine/validation.js"
);
const { aggregateSituationEntries } = await import("./lib/situationBacktestMetrics.mjs");

await initPool({ info: () => {}, warn: () => {}, error: console.error });

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
// Match UI backtest worker: exact run window only (no lookback pad — WARMUP handled in strategy).
const candles = await readCandles(SYMBOL, TF, fromMs, toMs);

const sitCfg = { ...BNB_SITUATION_ROUTER_15M, symbol: SYMBOL, timeframe: TF, riskPerTrade: RISK };
const cost = { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 };
const STRAT = "SITUATION_INTRADAY";

async function runSituation(slice, start = START_USDT) {
  const adapter = buildSituationIntradayBacktestAdapter(slice, sitCfg, TF);
  return runSimulation({
    candles: slice,
    strategyKey: STRAT,
    cfg: { ...sitCfg, symbol: SYMBOL },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: start,
    timeframe: TF,
    adapters: { [STRAT]: adapter },
    symbol: SYMBOL,
    costModelOverride: cost,
  });
}

const sim = await runSituation(candles);
const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: START_USDT });

const list = aggregateSituationEntries(sim.trades, fromMs, toMs);
const totalReturnPct = m.totalReturnPct ?? 0;
const wins = list.filter((t) => t.pnlPct > 0).length;

const byMonth = new Map();
const bySituation = new Map();
const byTrigger = new Map();
const byDay = new Map();
for (const t of list) {
  const d = new Date(t.ts).toISOString().slice(0, 10);
  const mo = d.slice(0, 7);
  byMonth.set(mo, (byMonth.get(mo) || 0) + t.pnlPct);
  bySituation.set(t.situation, (bySituation.get(t.situation) || 0) + t.pnlPct);
  byTrigger.set(t.trigger, (byTrigger.get(t.trigger) || 0) + t.pnlPct);
  byDay.set(d, (byDay.get(d) || 0) + t.pnlPct);
}

const days = [...byDay.keys()].length;
const tpd = list.length / Math.max(1, days);

console.log(`\n=== SITUATION_INTRADAY ${SYMBOL} ${TF} ${FROM} → ${TO} @ ${RISK}% ===`);
console.log(
  `Entries: ${list.length} | Total: ${totalReturnPct >= 0 ? "+" : ""}${totalReturnPct.toFixed(2)}% (equity) | WR: ${((wins / Math.max(1, list.length)) * 100).toFixed(0)}%`,
);
console.log(`Starting equity: $${START_USDT} | Trades/day: ${tpd.toFixed(2)} | Max/day cap: ${sitCfg.situationMaxTradesPerDay}`);
console.log(`Calmar: ${(m.calmar || 0).toFixed(2)} | MaxDD: ${(m.maxDrawdownPct || 0).toFixed(1)}%`);

console.log("\n--- Monthly ---");
for (const [mo, p] of [...byMonth.entries()].sort()) {
  console.log(`  ${mo}: ${p >= 0 ? "+" : ""}${p.toFixed(2)}%`);
}

console.log("\n--- Situation attribution ---");
for (const [s, p] of [...bySituation.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s}: ${p >= 0 ? "+" : ""}${p.toFixed(2)}%`);
}

console.log("\n--- Trigger attribution ---");
for (const [s, p] of [...byTrigger.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s}: ${p >= 0 ? "+" : ""}${p.toFixed(2)}%`);
}

console.log("\n--- Jun 1–4 2026 ---");
for (const t of list.filter((t) => t.ts >= Date.parse("2026-06-01") && t.ts < Date.parse("2026-06-05"))) {
  console.log(
    `  ${new Date(t.ts).toISOString().slice(0, 16)} ${t.dir} ${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(2)}% | ${t.situation}/${t.trigger}`,
  );
}

const rStats = rMultipleStats(sim.trades.filter((t) => t.exitReason !== "tp1_partial"));
const mc = monteCarloBootstrap(rStats.rValues, { paths: 2000, riskFrac: RISK / 100 });
console.log(`\n--- Monte Carlo (${rStats.rValues.length} R-values) ---`);
console.log(`  p5=${mc.p5ReturnPct.toFixed(2)}% p50=${mc.p50ReturnPct.toFixed(2)}% p95=${mc.p95ReturnPct.toFixed(2)}%`);

const stepMs = candles.length > 1 ? candles[1].ts - candles[0].ts : 900_000;
const embargo = Math.max(1, Math.round(86_400_000 / stepMs));
const splits = purgedWalkForwardSplits(candles.length, { folds: 4, embargo, mode: "rolling", minTrain: 300 });
let trainExpSum = 0;
let testExpSum = 0;
let oosSum = 0;
for (const sp of splits) {
  const trainSlice = candles.slice(sp.trainStart, sp.trainEnd);
  const testSlice = candles.slice(sp.testStart, sp.testEnd);
  if (testSlice.length < 50) continue;
  const trainSim = await runSituation(trainSlice);
  const testSim = await runSituation(testSlice);
  const trainM = computeAllMetrics({ trades: trainSim.trades, equityCurve: trainSim.equityCurve, tf: TF, startingEquity: START_USDT });
  const testM = computeAllMetrics({ trades: testSim.trades, equityCurve: testSim.equityCurve, tf: TF, startingEquity: START_USDT });
  trainExpSum += trainM.expectancy || 0;
  testExpSum += testM.expectancy || 0;
  oosSum += testM.totalReturnPct || 0;
}
const avgTrainExp = splits.length ? trainExpSum / splits.length : 0;
const avgTestExp = splits.length ? testExpSum / splits.length : 0;
const wfDeg = avgTrainExp !== 0 ? ((avgTrainExp - avgTestExp) / Math.abs(avgTrainExp)) * 100 : 100;
const gates = acceptanceGates({
  oosReturnPct: oosSum,
  mcP5ReturnPct: mc.p5ReturnPct,
  calmar: m.calmar,
  walkForwardDegradationPct: wfDeg,
});
console.log(`\n--- Walk-forward (OOS sum ${oosSum.toFixed(2)}%, degradation ${wfDeg.toFixed(1)}%) ---`);
for (const [k, g] of Object.entries(gates.gates)) {
  console.log(`  ${k}: ${g.pass ? "PASS" : "FAIL"} (${g.value})`);
}
console.log(`  VERDICT: ${gates.allPass ? "ACCEPTED" : "REJECTED"} (honest — BNB solo may not pass all gates)`);

console.log("\n--- LIQ_DAILY baseline (same window) ---");
clearIntradayAdapterCache();
const liqMerged = mergeAdaptiveCfg(
  fillLiqSoloPresetDefaults(fillFibSoloPresetDefaults({ ...INTRADAY_PRO_LIQ_DAILY_15M, symbol: SYMBOL, timeframe: TF })),
  candles,
);
const liqSim = await runSimulation({
  candles,
  strategyKey: "SR_INTRADAY",
  cfg: { ...liqMerged, symbol: SYMBOL, riskPerTrade: RISK, futuresLeverage: 12, backtestPositionSizing: "RISK_AT_SL" },
  gateMode: "off",
  fundingRates: [],
  startingUsdt: START_USDT,
  timeframe: TF,
  adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, liqMerged, TF) },
  symbol: SYMBOL,
  costModelOverride: cost,
});
const liqM = computeAllMetrics({
  trades: liqSim.trades,
  equityCurve: liqSim.equityCurve,
  tf: TF,
  startingEquity: START_USDT,
});
const liqList = aggregateSituationEntries(liqSim.trades, fromMs, toMs);
console.log(`  LIQ_DAILY: ${liqList.length} entries, ${(liqM.totalReturnPct ?? 0).toFixed(2)}%`);
console.log(`  SITUATION: ${list.length} entries, ${totalReturnPct.toFixed(2)}%`);

await closePool();
