#!/usr/bin/env node
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const symbol = process.argv[2] || "BNBUSDT";
const tf = "15m";
const fromMs = new Date("2026-01-01").getTime();
const toMs = new Date("2026-05-18").getTime();

const grid = [
  { sl: 0.005, tp: 0.012, risk: 4, lev: 20 },
  { sl: 0.005, tp: 0.015, risk: 5, lev: 20 },
  { sl: 0.006, tp: 0.015, risk: 5, lev: 20 },
  { sl: 0.006, tp: 0.018, risk: 5, lev: 25 },
  { sl: 0.007, tp: 0.021, risk: 5, lev: 20 },
  { sl: 0.004, tp: 0.01, risk: 4, lev: 15 },
];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
const candles = await readCandles(symbol, tf, fromMs, toMs);

let best = null;
for (const g of grid) {
  const cfg = {
    marketMode: "FUTURES",
    futuresLeverage: g.lev,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: g.risk,
    riskPerTradeUnit: "PCT",
    supertrendFuturesAuto: false,
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    supertrendFuturesFixedSlPct: g.sl,
    supertrendFuturesFixedTpPct: g.tp,
    trailingStopLossAuto: false,
    slippagePct: 0.0005,
    srIntradayCooldownBars: 6,
  };
  const adapters = await buildBacktestAdapters({
    strategyKey: "SR_INTRADAY",
    cfg,
    symbol,
    tf,
    candles,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: tf,
    adapters,
    symbol,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf,
    startingEquity: 100,
  });
  const row = {
    ...g,
    ret: +(m.totalReturnPct ?? 0).toFixed(1),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    n: m.totalTrades,
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +(Math.abs(m.maxDrawdownPct ?? 0)).toFixed(1),
  };
  console.log(row);
  if (!best || row.ret > best.ret) best = row;
}
console.log("BEST", best);
await closePool?.();
