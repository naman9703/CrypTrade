#!/usr/bin/env node
/** Quick SR_INTRADAY signal + single-run stats */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const symbol = process.argv[2] || "BTCUSDT";
const tf = "15m";
const fromMs = new Date("2026-01-01").getTime();
const toMs = new Date("2026-05-18").getTime();

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { buildSrIntradaySignalSeries } = await import("../src/strategy/srIntraday.js");

await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
const candles = await readCandles(symbol, tf, fromMs, toMs);
const series = buildSrIntradaySignalSeries(candles);
const signals = series.filter(Boolean);
const buys = signals.filter((s) => s.action === "BUY").length;
const sells = signals.filter((s) => s.action === "SELL").length;
const days = (toMs - fromMs) / 86_400_000;
console.log({ symbol, bars: candles.length, rawSignals: signals.length, buys, sells, signalsPerDay: (signals.length / days).toFixed(2) });

const cfg = {
  marketMode: "FUTURES",
  futuresLeverage: 20,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 5,
  riskPerTradeUnit: "PCT",
  supertrendFuturesAuto: false,
  strategyMode: "MANUAL",
  manualStrategy: "SR_INTRADAY",
  supertrendFuturesFixedSlPct: 0.006,
  supertrendFuturesFixedTpPct: 0.015,
  trailingStopLossAuto: false,
  slippagePct: 0.0005,
};
const adapters = await buildBacktestAdapters({ strategyKey: "SR_INTRADAY", cfg, symbol, tf, candles, fromMs });
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
const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf, startingEquity: 100 });
console.log({
  trades: m.totalTrades,
  tradesPerDay: ((m.totalTrades ?? 0) / days).toFixed(2),
  winRate: ((m.winRate ?? 0) * 100).toFixed(1) + "%",
  returnPct: (m.totalReturnPct ?? 0).toFixed(1) + "%",
  pf: (m.profitFactor ?? 0).toFixed(2),
  maxDd: (m.maxDrawdownPct ?? 0).toFixed(1) + "%",
});
await closePool?.();
