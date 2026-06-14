#!/usr/bin/env node
/** Fast HTF_RSI two-phase sweep: signal opts then brackets (BNB 15m). */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildHtfRsiSignalSeriesWithOpts } = await import("../src/strategy/htfRsi.js");

const SYMBOL = "BNBUSDT";
const TF = "15m";
const FULL_FROM = new Date("2025-06-01").getTime();
const FULL_TO = new Date("2026-06-13").getTime();
const OOS_FROM = new Date("2026-01-01").getTime();
const CAP = 1000;

const allCandles = await readCandles(SYMBOL, TF, FULL_FROM, FULL_TO, { market: "futures" });
const oosStartIdx = allCandles.findIndex((c) => c.ts >= OOS_FROM);

function makeAdapter(candles, opts) {
  const series = buildHtfRsiSignalSeriesWithOpts(candles, TF, opts);
  let lastDir = 0;
  return function adapter(_bar, idx) {
    const sig = series[idx];
    if (!sig) return null;
    if (sig.action === "BUY" && lastDir !== 1) {
      lastDir = 1;
      return sig;
    }
    if (sig.action === "SELL" && lastDir !== -1) {
      lastDir = -1;
      return sig;
    }
    return null;
  };
}

function simSlice(fromIdx, toIdx, opts, sl, tp, risk = 1) {
  const candles = allCandles.slice(fromIdx, toIdx + 1);
  const cfg = {
    manualStrategy: "HTF_RSI",
    strategyMode: "MANUAL",
    marketMode: "FUTURES",
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: risk,
    riskPerTradeUnit: "PCT_EQUITY",
    futuresLeverage: 5,
    supertrendFuturesFixedSlPct: sl,
    supertrendFuturesFixedTpPct: tp,
    trailingStopLossAuto: false,
    slippagePct: 0.0005,
    tradeHistoryTakerOpenFeeRate: 0.0004,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    symbol: SYMBOL,
    timeframe: TF,
    ...opts,
  };
  const adapter = makeAdapter(candles, opts);
  return runSimulation({
    strategyKey: "HTF_RSI",
    candles,
    cfg,
    gateMode: "off",
    startingUsdt: CAP,
    timeframe: TF,
    adapters: { HTF_RSI: adapter },
    symbol: SYMBOL,
  }).then((s) =>
    computeAllMetrics({
      trades: s.trades,
      equityCurve: s.equityCurve,
      tf: TF,
      startingEquity: CAP,
    }),
  );
}

async function scoreOpts(opts, sl, tp) {
  const train = await simSlice(0, oosStartIdx - 1, opts, sl, tp);
  const oos = await simSlice(oosStartIdx, allCandles.length - 1, opts, sl, tp);
  const trainRet = train.totalReturnPct ?? -999;
  const oosRet = oos.totalReturnPct ?? -999;
  if ((train.totalTrades ?? 0) < 6 || (oos.totalTrades ?? 0) < 4) return null;
  return {
    score: trainRet * 0.35 + oosRet * 0.65,
    trainRet,
    oosRet,
    trainN: train.totalTrades,
    oosN: oos.totalTrades,
    oosDd: oos.maxDrawdownPct,
    oosPf: oos.profitFactor,
    opts,
    sl,
    tp,
  };
}

const signalGrid = [];
for (const minSep of [0.0008, 0.001, 0.0012]) {
  for (const [rsiLong, rsiShort] of [
    [35, 65],
    [38, 62],
    [40, 60],
  ]) {
    for (const confirmMode of ["recovery_only", "strict", "rsi_turn"]) {
      for (const pullbackMode of ["above_ema50", "ema21_zone", "off"]) {
        for (const sideMode of ["both", "long_only"]) {
          signalGrid.push({
            minHtfSep: minSep,
            rsiLongMax: rsiLong,
            rsiShortMin: rsiShort,
            confirmMode,
            pullbackMode,
            sideMode,
            requireHtfSlope: true,
            blockThreeBarMomentum: true,
          });
        }
      }
    }
  }
}

console.log(`Phase 1: ${signalGrid.length} signal configs @ SL0.8 TP2.5...\n`);
const phase1 = [];
for (const opts of signalGrid) {
  const r = await scoreOpts(opts, 0.008, 0.025);
  if (r) phase1.push(r);
}
phase1.sort((a, b) => b.score - a.score);

for (const r of phase1.slice(0, 8)) {
  const o = r.opts;
  console.log(
    `score=${r.score.toFixed(1)} train=${r.trainRet.toFixed(1)}% oos=${r.oosRet.toFixed(1)}% oosN=${r.oosN} | ` +
      `sep=${o.minHtfSep} rsi=${o.rsiLongMax}/${o.rsiShortMin} ${o.confirmMode} ${o.pullbackMode} ${o.sideMode}`,
  );
}

const topOpts = phase1.slice(0, 5).map((r) => r.opts);
const brackets = [
  [0.006, 0.018],
  [0.007, 0.021],
  [0.008, 0.024],
  [0.008, 0.025],
  [0.009, 0.027],
  [0.01, 0.03],
];

console.log(`\nPhase 2: brackets on top ${topOpts.length} signal configs...\n`);
const phase2 = [];
for (const opts of topOpts) {
  for (const [sl, tp] of brackets) {
    const r = await scoreOpts(opts, sl, tp);
    if (r) phase2.push(r);
  }
}
phase2.sort((a, b) => b.score - a.score);

for (const r of phase2.slice(0, 10)) {
  const o = r.opts;
  console.log(
    `score=${r.score.toFixed(1)} train=${r.trainRet.toFixed(1)}% oos=${r.oosRet.toFixed(1)}% oosN=${r.oosN} dd=${r.oosDd?.toFixed(1)}% PF=${r.oosPf?.toFixed(2)} | ` +
      `sl=${(r.sl * 100).toFixed(1)} tp=${(r.tp * 100).toFixed(1)} rsi=${o.rsiLongMax}/${o.rsiShortMin} ${o.pullbackMode} ${o.sideMode}`,
  );
}

if (phase2[0]) {
  console.log("\nBEST:");
  console.log(JSON.stringify(phase2[0], null, 2));
}

await closePool?.();
