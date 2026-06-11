#!/usr/bin/env node
/**
 * Order-flow edge test on REAL aggressor (taker) volume.
 *
 * Drives the existing order-flow engine (`evaluateOrderFlowSoloSetup`:
 * absorption / stacked-delta / CVD-divergence at key levels, with delta
 * confirmation) directly per bar, so we measure the genuine order-flow edge
 * now that `taker_buy_volume` is backfilled (previously it ran on an OHLC proxy).
 *
 * Confirms the data tier per symbol so we KNOW we're not on the proxy.
 *
 * Usage:
 *   SYMBOLS=BTCUSDT,ETHUSDT TF=15m FROM=2025-01-01 node scripts/backtest-orderflow-real.mjs
 *   MIN_SCORE=5 CONF_MODE=full node scripts/backtest-orderflow-real.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT").split(",").map((s) => s.trim()).filter(Boolean);
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-06-01";
const START_USDT = Number(process.env.START_USDT || 1000);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const { precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const { evaluateOrderFlowSoloSetup, buildOrderFlowOpts } = await import("../src/strategy/techniques/orderFlowPatterns.js");
const { resolveSeriesDataTier } = await import("../src/strategy/techniques/orderFlow.js");
const { monteCarloBootstrap, purgedWalkForwardSplits, acceptanceGates } = await import(
  "../src/backtest/engine/validation.js"
);

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();

const cfg = {
  marketMode: "FUTURES",
  futuresLeverage: Number(process.env.LEVERAGE || 10),
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: Number(process.env.RISK_PCT || 1.0),
  riskPerTradeUnit: "PCT",
  slippagePct: Number(process.env.SLIPPAGE || 0.0005),
  // Order-flow knobs.
  intradayOfConfluenceMode: process.env.CONF_MODE || "full",
  intradayOfKillzoneMode: process.env.KILLZONE || "LONDON_NY",
  intradayOfRequireKeyLevel: process.env.REQ_KEY !== "0",
  intradayOfRequireConfirmation: process.env.REQ_CONF !== "0",
  intradayOfAllowProxy: false, // force REAL data only
  intradayOfSoloMinScore: Number(process.env.MIN_SCORE || 5),
  intradayOfMinStackBars: Number(process.env.STACK_BARS || 3),
  intradayOfStackDeltaRatio: Number(process.env.STACK_RATIO || 0.75),
  intradayOfDivergenceLookback: Number(process.env.DIV_LB || 12),
  timeframe: TF,
};

// Build a backtest adapter that fires the order-flow solo setup on the signal bar.
function buildOfAdapter(candles) {
  const pre = precomputeIntraday(candles);
  // Cap to ~3 trades/day so cost drag is controlled.
  const maxPerDay = Number(process.env.MAX_TRADES || 3);
  const minGap = Number(process.env.MIN_GAP || 6);
  let lastIdx = -Infinity;
  let day = null;
  let count = 0;
  return function ofAdapter(bar, idx) {
    const d = Math.floor(bar.ts / 86400000);
    if (d !== day) {
      day = d;
      count = 0;
    }
    if (count >= maxPerDay) return null;
    if (idx - lastIdx < minGap) return null;
    const sig = evaluateOrderFlowSoloSetup(candles, idx, pre, cfg, {});
    if (!sig || !sig.liqBrackets) return null;
    lastIdx = idx;
    count += 1;
    return {
      action: sig.action,
      reason: sig.reason,
      liqBrackets: sig.liqBrackets,
      grade: sig.tier,
      techniques: sig.techniques,
    };
  };
}

async function runWindow(sym, slice, fund) {
  const adapter = buildOfAdapter(slice);
  const sim = await runSimulation({
    strategyKey: "INTRADAY_PRO",
    candles: slice,
    cfg: { ...cfg, symbol: sym },
    gateMode: "off",
    fundingRates: fund,
    startingUsdt: START_USDT,
    timeframe: TF,
    adapters: { INTRADAY_PRO: adapter },
    symbol: sym,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: START_USDT });
  return { sim, m };
}

console.log(`\n=== ORDER-FLOW (real taker) — ${SYMBOLS.join(", ")} ${TF} ${FROM}->${TO} ===`);
console.log(`confMode=${cfg.intradayOfConfluenceMode} reqKey=${cfg.intradayOfRequireKeyLevel} reqConf=${cfg.intradayOfRequireConfirmation} minScore=${cfg.intradayOfSoloMinScore}\n`);

for (const sym of SYMBOLS) {
  const candles = await readCandles(sym, TF, fromMs, toMs);
  if (!candles?.length) {
    console.log(`[skip] ${sym}: no candles`);
    continue;
  }
  let fund = [];
  try {
    fund = await readFundingRates(sym, fromMs, toMs);
  } catch {
    fund = [];
  }

  // Confirm we're on REAL order-flow data, not the proxy.
  const ofOpts = typeof buildOrderFlowOpts === "function" ? buildOrderFlowOpts(cfg) : { allowProxy: false };
  const tier = typeof resolveSeriesDataTier === "function"
    ? resolveSeriesDataTier(candles.slice(-200), ofOpts)
    : "unknown";
  const withTaker = candles.filter((c) => Number.isFinite(c.taker_buy_volume) && c.taker_buy_volume > 0).length;

  console.log(`────────── ${sym} (${candles.length} bars, taker-coverage ${((withTaker / candles.length) * 100).toFixed(1)}%, dataTier=${tier}) ──────────`);
  if (tier === "proxy" || tier === "none") {
    console.log(`  [!] data tier is "${tier}" — NOT real order flow; skipping (backfill taker volume first).\n`);
    continue;
  }

  const { sim, m } = await runWindow(sym, candles, fund);
  console.log(
    `full: trades=${m.totalTrades} WR=${((m.winRate || 0) * 100).toFixed(0)}% net=${m.totalReturnPct.toFixed(1)}% ` +
      `CAGR=${(m.cagrPct || 0).toFixed(1)}% Calmar=${(m.calmar ?? 0).toFixed(2)} maxDD=${m.maxDrawdownPct.toFixed(1)}% ` +
      `Sharpe=${(m.sharpe || 0).toFixed(2)} PF=${(m.profitFactor || 0).toFixed(2)} expR=${(m.expectancyR || 0).toFixed(3)}`,
  );

  const rstats = rMultipleStats(sim.trades);
  const mc = monteCarloBootstrap(rstats.rValues, { paths: 3000, riskFrac: 0.01, ruinDrawdownPct: 50 });
  if (!mc.insufficient) {
    console.log(`  MC(1% risk): ret p5=${mc.p5ReturnPct.toFixed(1)}% p50=${mc.p50ReturnPct.toFixed(1)}% p95=${mc.p95ReturnPct.toFixed(1)}%  ruin=${mc.riskOfRuinPct.toFixed(1)}%`);
  } else {
    console.log(`  MC: insufficient trades (${rstats.rCount})`);
  }

  if (process.env.WF === "0") {
    console.log(`  (walk-forward skipped: WF=0)\n`);
    continue;
  }
  const stepMs = candles.length > 1 ? candles[1].ts - candles[0].ts : 900_000;
  const embargo = Math.max(1, Math.round(86_400_000 / stepMs));
  const splits = purgedWalkForwardSplits(candles.length, { folds: 4, embargo, mode: "rolling", minTrain: 300 });
  let trainExp = 0;
  let testExp = 0;
  let testRet = 0;
  for (const s of splits) {
    const trSlice = candles.slice(s.trainStart, s.trainEnd);
    const teSlice = candles.slice(s.testStart, s.testEnd);
    const ft = fund.filter((f) => f.ts >= trSlice[0]?.ts && f.ts <= trSlice[trSlice.length - 1]?.ts);
    const fe = fund.filter((f) => f.ts >= teSlice[0]?.ts && f.ts <= teSlice[teSlice.length - 1]?.ts);
    const tr = await runWindow(sym, trSlice, ft);
    const te = await runWindow(sym, teSlice, fe);
    trainExp += tr.m.expectancy || 0;
    testExp += te.m.expectancy || 0;
    testRet += te.m.totalReturnPct || 0;
    console.log(`    WF fold ${s.fold}: train[n=${tr.m.totalTrades} exp=$${(tr.m.expectancy || 0).toFixed(2)}] test[n=${te.m.totalTrades} ret=${(te.m.totalReturnPct || 0).toFixed(1)}% PF=${(te.m.profitFactor || 0).toFixed(2)}]`);
  }
  const avgTr = splits.length ? trainExp / splits.length : 0;
  const avgTe = splits.length ? testExp / splits.length : 0;
  const wfDeg = avgTr !== 0 ? ((avgTr - avgTe) / Math.abs(avgTr)) * 100 : 100;
  console.log(`  WF: degradation=${wfDeg.toFixed(1)}% OOSsumRet=${testRet.toFixed(1)}%`);

  const gate = acceptanceGates({
    oosReturnPct: testRet,
    mcP5ReturnPct: mc.insufficient ? -1 : mc.p5ReturnPct,
    calmar: m.calmar ?? -1,
    walkForwardDegradationPct: wfDeg,
  });
  console.log(`  GATES: ${Object.entries(gate.gates).map(([k, g]) => `${g.pass ? "✅" : "❌"}${k}`).join(" ")} -> ${gate.allPass ? "ACCEPTED ✅" : "REJECTED ❌"}\n`);
}

await closePool?.();
