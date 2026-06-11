#!/usr/bin/env node
/**
 * Trustworthy validation of the BEST LIQ + S/R (A+) tuning: full-window backtest +
 * Monte Carlo bootstrap on trade R-multiples + purged walk-forward + acceptance gates.
 *
 *   SYMBOLS=BTCUSDT,ETHUSDT,BNBUSDT FROM=2025-01-01 TO=2026-06-01 node scripts/backtest-liqsr-validate.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT").split(",").map((s) => s.trim()).filter(Boolean);
const TF = "15m";
const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-06-01";
const START = Number(process.env.START_USDT || 1000);
const RISK = Number(process.env.RISK_PCT || 1.5);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { monteCarloBootstrap, purgedWalkForwardSplits, acceptanceGates } = await import("../src/backtest/engine/validation.js");
const { LIQSR_BEST_15M } = await import("../src/strategy/presets/liqSrBest.js");

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();
const cfgFor = (symbol) => ({ ...LIQSR_BEST_15M, riskPerTrade: RISK, symbol, timeframe: TF });

async function runWindow(symbol, slice, fundSlice) {
  const cfg = cfgFor(symbol);
  const adapters = await buildBacktestAdapters({ strategyKey: "SR_INTRADAY", cfg, symbol, tf: TF, candles: slice, fromMs: slice[0]?.ts ?? fromMs });
  const sim = await runSimulation({ strategyKey: "SR_INTRADAY", candles: slice, cfg, gateMode: "off", fundingRates: fundSlice, startingUsdt: START, timeframe: TF, adapters, symbol });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: START });
  return { sim, m };
}

const fmt = (n, d = 1) => (Number.isFinite(n) ? Number(n).toFixed(d) : "—");
console.log(`\n=== LIQ + S/R (A+) BEST-TUNING VALIDATION ===`);
console.log(`${SYMBOLS.join(",")} ${TF} ${FROM}->${TO} risk=${RISK}% | gates: OOS>0, MC p5>0, Calmar>1, WF deg<35%\n`);

const verdicts = [];
for (const symbol of SYMBOLS) {
  const candles = await readCandles(symbol, TF, fromMs, toMs);
  if (!candles?.length) { console.log(`[skip] ${symbol}: no candles\n`); continue; }
  let funding = [];
  try { funding = await readFundingRates(symbol, fromMs, toMs); } catch { funding = []; }

  console.log(`────────── ${symbol} (${candles.length} bars) ──────────`);
  const { sim, m } = await runWindow(symbol, candles, funding);
  console.log(`Full window: trades=${m.totalTrades} net=${fmt(m.totalReturnPct)}% CAGR=${fmt(m.cagrPct || 0)}% Calmar=${fmt(m.calmar ?? 0, 2)} maxDD=${fmt(m.maxDrawdownPct)}% PF=${fmt(m.profitFactor || 0, 2)} expR=${fmt(m.expectancyR || 0, 3)}`);

  const rstats = rMultipleStats(sim.trades);
  const mc = monteCarloBootstrap(rstats.rValues, { paths: 3000, riskFrac: RISK / 100, ruinDrawdownPct: 50 });
  if (mc.insufficient) {
    console.log(`Monte Carlo: insufficient trades (${rstats.rCount})`);
  } else {
    console.log(`Monte Carlo (3000 paths @ ${RISK}%): return p5=${fmt(mc.p5ReturnPct)}% p50=${fmt(mc.p50ReturnPct)}% p95=${fmt(mc.p95ReturnPct)}% | maxDD p50=${fmt(mc.medianMaxDdPct)}% p95=${fmt(mc.p95MaxDdPct)}% | ruin=${fmt(mc.riskOfRuinPct)}%`);
  }

  const stepMs = candles.length > 1 ? candles[1].ts - candles[0].ts : 900_000;
  const embargo = Math.max(1, Math.round(86_400_000 / stepMs));
  const splits = purgedWalkForwardSplits(candles.length, { folds: 4, embargo, mode: "rolling", minTrain: 1000 });
  let trainExpSum = 0, testExpSum = 0, testRetSum = 0;
  for (const s of splits) {
    const trainSlice = candles.slice(s.trainStart, s.trainEnd);
    const testSlice = candles.slice(s.testStart, s.testEnd);
    const fTr = funding.filter((f) => f.ts >= trainSlice[0]?.ts && f.ts <= trainSlice.at(-1)?.ts);
    const fTe = funding.filter((f) => f.ts >= testSlice[0]?.ts && f.ts <= testSlice.at(-1)?.ts);
    const tr = await runWindow(symbol, trainSlice, fTr);
    const te = await runWindow(symbol, testSlice, fTe);
    trainExpSum += tr.m.expectancy || 0;
    testExpSum += te.m.expectancy || 0;
    testRetSum += te.m.totalReturnPct || 0;
    console.log(`  fold ${s.fold}: train[n=${tr.m.totalTrades} exp=$${fmt(tr.m.expectancy || 0, 2)}] test[n=${te.m.totalTrades} ret=${fmt(te.m.totalReturnPct || 0)}% PF=${fmt(te.m.profitFactor || 0, 2)}]`);
  }
  const avgTrainExp = splits.length ? trainExpSum / splits.length : 0;
  const avgTestExp = splits.length ? testExpSum / splits.length : 0;
  const wfDeg = avgTrainExp !== 0 ? ((avgTrainExp - avgTestExp) / Math.abs(avgTrainExp)) * 100 : 100;
  console.log(`  WF: avgTrainExp=$${fmt(avgTrainExp, 2)} avgTestExp=$${fmt(avgTestExp, 2)} degradation=${fmt(wfDeg)}% OOS-sum=${fmt(testRetSum)}%`);

  const gate = acceptanceGates({
    oosReturnPct: testRetSum,
    mcP5ReturnPct: mc.insufficient ? -1 : mc.p5ReturnPct,
    calmar: m.calmar ?? -1,
    walkForwardDegradationPct: wfDeg,
  });
  for (const [name, g] of Object.entries(gate.gates)) {
    console.log(`  ${g.pass ? "PASS" : "FAIL"}  ${name.padEnd(18)} value=${fmt(Number(g.value), 2)} (need ${g.threshold})`);
  }
  console.log(`  VERDICT: ${gate.allPass ? "ACCEPTED" : "REJECTED"}\n`);
  verdicts.push({ symbol, accepted: gate.allPass, net: m.totalReturnPct, calmar: m.calmar ?? 0, mcP5: mc.p5ReturnPct, wfDeg });
}

console.log(`=== SUMMARY ===`);
for (const v of verdicts) {
  console.log(`${v.symbol.padEnd(9)} ${v.accepted ? "ACCEPTED" : "REJECTED"}  net=${fmt(v.net)}% Calmar=${fmt(v.calmar, 2)} mcP5=${fmt(v.mcP5)}% wfDeg=${fmt(v.wfDeg)}%`);
}

await closePool?.();
