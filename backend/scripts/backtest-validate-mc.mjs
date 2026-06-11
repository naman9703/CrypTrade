#!/usr/bin/env node
/**
 * Trustworthy-validation harness: runs a strategy across a window, then applies
 * Monte Carlo bootstrap (on trade R-multiples) + purged walk-forward (with
 * embargo) and checks the acceptance gates.
 *
 * Today it validates the Phase 1 research baselines so the machinery is proven;
 * once REGIME_ADAPTIVE exists it validates that via the same path (swap the
 * adapter builder). Acceptance gates: OOS > 0, MC 5th-pct > 0, Calmar > 1,
 * walk-forward degradation < 35%.
 *
 * Usage:
 *   node scripts/backtest-validate-mc.mjs BTCUSDT 15m mean_reversion
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const sym = process.argv[2] || "BTCUSDT";
const tf = process.argv[3] || "15m";
const technique = process.argv[4] || "mean_reversion";
const fromMs = new Date(process.env.FROM || "2026-01-01").getTime();
const toMs = new Date(process.env.TO || "2026-05-18").getTime();
const OFFLINE = process.env.OFFLINE !== "0";

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const { buildBaselineSignals } = await import("./lib/researchSignals.mjs");
const { monteCarloBootstrap, purgedWalkForwardSplits, acceptanceGates } = await import(
  "../src/backtest/engine/validation.js"
);

const BRACKETS = {
  trend_pullback: { sl: 0.006, tp: 0.012 },
  mean_reversion: { sl: 0.005, tp: 0.0075 },
  donchian_break: { sl: 0.007, tp: 0.014 },
};
const b = BRACKETS[technique] || BRACKETS.mean_reversion;
const cfg = {
  symbol: sym,
  marketMode: "FUTURES",
  futuresLeverage: 5,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 1.0,
  riskPerTradeUnit: "PCT",
  slippagePct: 0.0005,
  supertrendFuturesFixedSlPct: b.sl,
  supertrendFuturesFixedTpPct: b.tp,
};

if (!OFFLINE) {
  try {
    await ensureKlines(sym, tf, { from: fromMs, to: toMs, market: "futures" });
  } catch (e) {
    console.log(`[warn] backfill failed (${e?.message}); using DB`);
  }
}
const candles = await readCandles(sym, tf, fromMs, toMs);
if (!candles?.length) {
  console.error(`No candles for ${sym} ${tf}`);
  await closePool?.();
  process.exit(1);
}
let fundingRates = [];
try {
  fundingRates = await readFundingRates(sym, fromMs, toMs);
} catch {
  fundingRates = [];
}

const STRAT = `RESEARCH_${technique}`;

async function runWindow(slice, fundSlice) {
  const signals = buildBaselineSignals(slice);
  const adapters = { [STRAT]: signals[technique] };
  const sim = await runSimulation({
    strategyKey: STRAT,
    candles: slice,
    cfg,
    gateMode: "off",
    fundingRates: fundSlice,
    startingUsdt: 1000,
    timeframe: tf,
    adapters,
    symbol: sym,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf, startingEquity: 1000 });
  return { sim, m };
}

console.log(`\n=== Validating ${technique} on ${sym} ${tf} (${candles.length} bars) ===\n`);

// 1) Full-window backtest.
const { sim, m } = await runWindow(candles, fundingRates);
console.log(`Full window: trades=${m.totalTrades} net=${m.totalReturnPct.toFixed(1)}% ` +
  `CAGR=${(m.cagrPct || 0).toFixed(1)}% Calmar=${(m.calmar ?? 0).toFixed(2)} ` +
  `maxDD=${m.maxDrawdownPct.toFixed(1)}% Sharpe=${(m.sharpe || 0).toFixed(2)} ` +
  `PF=${(m.profitFactor || 0).toFixed(2)} expR=${(m.expectancyR || 0).toFixed(3)}`);

// 2) Monte Carlo on trade R-multiples.
const rstats = rMultipleStats(sim.trades);
const mc = monteCarloBootstrap(rstats.rValues, { paths: 3000, riskFrac: 0.01, ruinDrawdownPct: 50 });
console.log(`\nMonte Carlo (${mc.paths} paths, 1% risk/trade):`);
if (mc.insufficient) {
  console.log(`  insufficient trades for MC (${rstats.rCount})`);
} else {
  console.log(`  return  p5=${mc.p5ReturnPct.toFixed(1)}%  p50=${mc.p50ReturnPct.toFixed(1)}%  p95=${mc.p95ReturnPct.toFixed(1)}%  mean=${mc.meanReturnPct.toFixed(1)}%`);
  console.log(`  maxDD   p50=${mc.medianMaxDdPct.toFixed(1)}%  p95=${mc.p95MaxDdPct.toFixed(1)}%`);
  console.log(`  risk-of-ruin (>=50% DD) = ${mc.riskOfRuinPct.toFixed(1)}%`);
}

// 3) Purged walk-forward (bar-based folds, embargo = 1 day of bars).
const stepMs = candles.length > 1 ? candles[1].ts - candles[0].ts : 900_000;
const embargo = Math.max(1, Math.round(86_400_000 / stepMs));
const splits = purgedWalkForwardSplits(candles.length, { folds: 4, embargo, mode: "rolling", minTrain: 300 });
console.log(`\nPurged walk-forward (${splits.length} folds, embargo=${embargo} bars):`);
let trainExpSum = 0;
let testExpSum = 0;
let testRetSum = 0;
let foldsWithTrades = 0;
for (const s of splits) {
  const trainSlice = candles.slice(s.trainStart, s.trainEnd);
  const testSlice = candles.slice(s.testStart, s.testEnd);
  const fundTrain = fundingRates.filter((f) => f.ts >= trainSlice[0]?.ts && f.ts <= trainSlice[trainSlice.length - 1]?.ts);
  const fundTest = fundingRates.filter((f) => f.ts >= testSlice[0]?.ts && f.ts <= testSlice[testSlice.length - 1]?.ts);
  const tr = await runWindow(trainSlice, fundTrain);
  const te = await runWindow(testSlice, fundTest);
  trainExpSum += tr.m.expectancy || 0;
  testExpSum += te.m.expectancy || 0;
  testRetSum += te.m.totalReturnPct || 0;
  if (te.m.totalTrades > 0) foldsWithTrades++;
  console.log(
    `  fold ${s.fold}: train[n=${tr.m.totalTrades} exp=$${(tr.m.expectancy || 0).toFixed(2)}] ` +
      `test[n=${te.m.totalTrades} ret=${(te.m.totalReturnPct || 0).toFixed(1)}% exp=$${(te.m.expectancy || 0).toFixed(2)} PF=${(te.m.profitFactor || 0).toFixed(2)}]`,
  );
}
const avgTrainExp = splits.length ? trainExpSum / splits.length : 0;
const avgTestExp = splits.length ? testExpSum / splits.length : 0;
const wfDegradationPct = avgTrainExp !== 0 ? ((avgTrainExp - avgTestExp) / Math.abs(avgTrainExp)) * 100 : 100;
const oosReturnPct = testRetSum; // summed OOS return across folds

console.log(`\n  avg train exp=$${avgTrainExp.toFixed(2)}  avg test exp=$${avgTestExp.toFixed(2)}  degradation=${wfDegradationPct.toFixed(1)}%  OOS sum ret=${oosReturnPct.toFixed(1)}%`);

// 4) Acceptance gates.
const gate = acceptanceGates({
  oosReturnPct,
  mcP5ReturnPct: mc.insufficient ? -1 : mc.p5ReturnPct,
  calmar: m.calmar ?? -1,
  walkForwardDegradationPct: wfDegradationPct,
});
console.log(`\n========== ACCEPTANCE GATES ==========`);
for (const [name, g] of Object.entries(gate.gates)) {
  console.log(`  ${g.pass ? "PASS" : "FAIL"}  ${name.padEnd(18)} value=${Number(g.value).toFixed(2)} (need ${g.threshold})`);
}
console.log(`\n  VERDICT: ${gate.allPass ? "ACCEPTED ✅" : "REJECTED ❌ — do not trust / do not deploy"}`);

await closePool?.();
