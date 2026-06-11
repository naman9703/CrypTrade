#!/usr/bin/env node
/**
 * Deep validation of SUPERTREND_ELITE — the only strategy showing a real edge.
 *
 * - Param sweep (multiplier × minAdx × HTF-gate toggles) per symbol, full history.
 * - Walk-forward (purged, embargo) + Monte Carlo + acceptance gates on the best.
 * - Honest per-symbol achievable return with realistic costs + trailing-ST exit.
 *
 * Usage:
 *   SYMBOLS=BTCUSDT,ETHUSDT,BNBUSDT TF=15m FROM=2025-01-01 node scripts/backtest-validate-supertrend.mjs
 *   RISK_PCT=5 LEVERAGE=25 node scripts/backtest-validate-supertrend.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT").split(",").map((s) => s.trim()).filter(Boolean);
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-06-01";
const START_USDT = Number(process.env.START_USDT || 1000);
const RISK_PCT = Number(process.env.RISK_PCT || 2);
const LEVERAGE = Number(process.env.LEVERAGE || 25);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const { buildEliteStBacktestAdapter, buildEliteStOptsFromCfg } = await import("../src/strategy/supertrendElite.js");
const { monteCarloBootstrap, purgedWalkForwardSplits, acceptanceGates } = await import(
  "../src/backtest/engine/validation.js"
);

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();

function eliteCfg(sym, over = {}) {
  return {
    symbol: sym,
    marketMode: "FUTURES",
    futuresLeverage: LEVERAGE,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: RISK_PCT,
    riskPerTradeUnit: "PCT",
    slippagePct: 0.0005,
    // Elite ST: trailing Supertrend exit, exit on flip (let winners run).
    trailingStopLossAuto: true,
    futuresTrailingStopMode: "SUPERTREND",
    supertrendFuturesExitOnFlip: true,
    supertrendFuturesFixedSlPct: 0,
    supertrendFuturesFixedTpPct: 0,
    supertrendWilderAtr: true,
    supertrendPeriod: 10,
    supertrendMultiplier: 3.0,
    eliteStRequireHtf4hAlign: true,
    eliteStRequireHtf1hEmaAlign: true,
    eliteStMinAdx: 25,
    eliteStRequireAdxRising: true,
    eliteStMinVolumeVsAvg: 1.5,
    eliteStRequireAtrExpansion: true,
    ...over,
  };
}

const data = {};
for (const sym of SYMBOLS) {
  const candles = await readCandles(sym, TF, fromMs, toMs);
  if (!candles?.length) {
    console.log(`[skip] ${sym}: no candles`);
    continue;
  }
  let funding = [];
  try {
    funding = await readFundingRates(sym, fromMs, toMs);
  } catch {
    funding = [];
  }
  data[sym] = { candles, funding };
}

async function runWindow(sym, slice, fund, cfg) {
  const opts = buildEliteStOptsFromCfg(cfg);
  const adapter = buildEliteStBacktestAdapter(slice, opts);
  const sim = await runSimulation({
    strategyKey: "SUPERTREND_ELITE",
    candles: slice,
    cfg,
    gateMode: "off",
    fundingRates: fund,
    startingUsdt: START_USDT,
    timeframe: TF,
    adapters: { SUPERTREND_ELITE: adapter },
    symbol: sym,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: START_USDT });
  return { sim, m };
}

// Param sweep grid.
const SWEEP = [];
for (const mult of [2.5, 3.0, 3.5]) {
  for (const minAdx of [20, 25, 30]) {
    for (const htf4h of [true, false]) {
      SWEEP.push({ supertrendMultiplier: mult, eliteStMinAdx: minAdx, eliteStRequireHtf4hAlign: htf4h, tag: `m${mult}/adx${minAdx}/4h${htf4h ? 1 : 0}` });
    }
  }
}

const fmt = (n, d = 1) => (Number.isFinite(n) ? Number(n).toFixed(d) : "—");

console.log(`\n=== SUPERTREND_ELITE deep validation — ${Object.keys(data).join(", ")} ${TF} ${FROM}->${TO} ===`);
console.log(`normalized: risk%=${RISK_PCT} lev=${LEVERAGE}x · ${SWEEP.length} configs/symbol\n`);

for (const sym of Object.keys(data)) {
  const { candles, funding } = data[sym];
  console.log(`────────── ${sym} (${candles.length} bars) ──────────`);
  const cells = [];
  for (const g of SWEEP) {
    const cfg = eliteCfg(sym, g);
    const { m } = await runWindow(sym, candles, funding, cfg);
    cells.push({ g, m });
  }
  cells.sort((a, b) => b.m.totalReturnPct - a.m.totalReturnPct);
  console.log(`  top configs:`);
  for (const c of cells.slice(0, 5)) {
    console.log(
      `    ${c.g.tag.padEnd(18)} net=${fmt(c.m.totalReturnPct).padStart(7)}% trades=${String(c.m.totalTrades).padStart(3)} WR=${fmt((c.m.winRate || 0) * 100, 0)}% PF=${fmt(c.m.profitFactor, 2)} maxDD=${fmt(c.m.maxDrawdownPct)}% Calmar=${fmt(c.m.calmar, 2)}`,
    );
  }

  // Deep-validate the best config for this symbol.
  const best = cells[0];
  const cfg = eliteCfg(sym, best.g);
  const { sim, m } = await runWindow(sym, candles, funding, cfg);
  console.log(`  >> BEST: ${best.g.tag}  net=${fmt(m.totalReturnPct)}% CAGR=${fmt(m.cagrPct)}% Calmar=${fmt(m.calmar, 2)} maxDD=${fmt(m.maxDrawdownPct)}% Sharpe=${fmt(m.sharpe, 2)} PF=${fmt(m.profitFactor, 2)} trades=${m.totalTrades}`);

  const rstats = rMultipleStats(sim.trades);
  const mc = monteCarloBootstrap(rstats.rValues, { paths: 3000, riskFrac: 0.01, ruinDrawdownPct: 50 });
  if (!mc.insufficient) {
    console.log(`     MC(1% risk): ret p5=${fmt(mc.p5ReturnPct)}% p50=${fmt(mc.p50ReturnPct)}% p95=${fmt(mc.p95ReturnPct)}%  ruin(>=50%)=${fmt(mc.riskOfRuinPct)}%`);
  } else {
    console.log(`     MC: insufficient trades (${rstats.rCount})`);
  }

  const stepMs = candles.length > 1 ? candles[1].ts - candles[0].ts : 900_000;
  const embargo = Math.max(1, Math.round(86_400_000 / stepMs));
  const splits = purgedWalkForwardSplits(candles.length, { folds: 4, embargo, mode: "rolling", minTrain: 300 });
  let trainExp = 0;
  let testExp = 0;
  let testRet = 0;
  for (const s of splits) {
    const tr = await runWindow(sym, candles.slice(s.trainStart, s.trainEnd), funding, cfg);
    const te = await runWindow(sym, candles.slice(s.testStart, s.testEnd), funding, cfg);
    trainExp += tr.m.expectancy || 0;
    testExp += te.m.expectancy || 0;
    testRet += te.m.totalReturnPct || 0;
    console.log(`     WF fold ${s.fold}: train[n=${tr.m.totalTrades} exp=$${fmt(tr.m.expectancy, 2)}] test[n=${te.m.totalTrades} ret=${fmt(te.m.totalReturnPct)}% PF=${fmt(te.m.profitFactor, 2)}]`);
  }
  const avgTr = splits.length ? trainExp / splits.length : 0;
  const avgTe = splits.length ? testExp / splits.length : 0;
  const wfDeg = avgTr !== 0 ? ((avgTr - avgTe) / Math.abs(avgTr)) * 100 : 100;
  const gate = acceptanceGates({
    oosReturnPct: testRet,
    mcP5ReturnPct: mc.insufficient ? -1 : mc.p5ReturnPct,
    calmar: m.calmar ?? -1,
    walkForwardDegradationPct: wfDeg,
  });
  console.log(`     WF: degradation=${fmt(wfDeg)}% OOSsumRet=${fmt(testRet)}%`);
  console.log(`     GATES: ${Object.entries(gate.gates).map(([k, gg]) => `${gg.pass ? "✅" : "❌"}${k}`).join(" ")} -> ${gate.allPass ? "ACCEPTED ✅" : "REJECTED ❌"}\n`);
}

await closePool?.();
