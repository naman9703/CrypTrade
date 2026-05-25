#!/usr/bin/env node
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const symbol = process.argv[2] || "BNBUSDT";
const tf = process.argv[3] || "15m";
const fromMs = new Date("2026-01-01").getTime();
const toMs = new Date("2026-05-18").getTime();
const days = (toMs - fromMs) / 86_400_000;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
const candles = await readCandles(symbol, tf, fromMs, toMs);

async function run(strat, extra = {}) {
  const cfg = {
    marketMode: "FUTURES",
    futuresLeverage: 15,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: 3,
    riskPerTradeUnit: "PCT",
    strategyMode: "MANUAL",
    manualStrategy: strat,
    supertrendFuturesAuto: false,
    supertrendFuturesFixedSlPct: 0.006,
    supertrendFuturesFixedTpPct: 0.012,
    trailingStopLossAuto: false,
    slippagePct: 0.0005,
    ...extra,
  };
  const adapters = await buildBacktestAdapters({
    strategyKey: strat,
    cfg,
    symbol,
    tf,
    candles,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey: strat,
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: tf,
    adapters,
    symbol,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf, startingEquity: 100 });
  return {
    strat,
    n: m.totalTrades,
    tpd: +((m.totalTrades ?? 0) / days).toFixed(2),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    ret: +(m.totalReturnPct ?? 0).toFixed(1),
  };
}

for (const strat of ["SMART_REVERSAL", "SR_INTRADAY"]) {
  console.log(await run(strat, strat === "SR_INTRADAY" ? {
    srIntradayMinScore: 5,
    srIntradayMaxTradesPerDay: 3,
    supertrendHtf4hEnabled: true,
  } : {}));
}
await closePool?.();
