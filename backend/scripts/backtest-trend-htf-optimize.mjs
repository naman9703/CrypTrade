#!/usr/bin/env node
/** TREND_HTF_ST production preset validation — run: npm run backtest:trend-htf */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const {
  TREND_HTF_ST_BNB_MAX_PRESET,
  TREND_HTF_ST_BNB_AGGRESSIVE_PRESET,
} = await import("../src/strategy/presets/trendHtfStOptimized.js");

async function runWindow(label, from, to, cfg) {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  const candles = await readCandles("BNBUSDT", "15m", fromMs, toMs);
  const full = {
    marketMode: "FUTURES",
    futuresLeverage: 25,
    backtestPositionSizing: "RISK_AT_SL",
    strategyMode: "MANUAL",
    manualStrategy: "TREND_HTF_ST",
    trailingStopLossAuto: false,
    slippagePct: 0.0005,
    tradeHistoryTakerOpenFeeRate: 0.0004,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    ...cfg,
  };
  const adapters = await buildBacktestAdapters({
    strategyKey: "TREND_HTF_ST",
    cfg: full,
    symbol: "BNBUSDT",
    tf: "15m",
    candles,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "TREND_HTF_ST",
    candles,
    cfg: full,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: "15m",
    adapters,
    symbol: "BNBUSDT",
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: "15m",
    startingEquity: 100,
  });
  const sl = sim.trades.filter((t) => t.exitReason === "sl").length;
  const n = m.totalTrades ?? 0;
  const chop = sim.trades.filter((t) => t.entryQuality?.macroMode === "CHOP_SEASON").length;
  console.log(
    `${label.padEnd(24)} n=${String(n).padStart(2)} WR=${((m.winRate ?? 0) * 100).toFixed(1).padStart(5)}% ret=${(m.totalReturnPct ?? 0).toFixed(0).padStart(5)}% SL%=${n ? ((sl / n) * 100).toFixed(0) : "—"}% chop=${chop}`,
  );
}

console.log("── TREND_HTF_ST production validation ──\n");
await runWindow("H2 2025", "2025-06-01", "2025-12-31", TREND_HTF_ST_BNB_MAX_PRESET);
await runWindow("Jan26", "2026-01-01", "2026-05-19", TREND_HTF_ST_BNB_MAX_PRESET);
await runWindow("1yr", "2025-06-01", "2026-05-19", TREND_HTF_ST_BNB_MAX_PRESET);
await runWindow("Jan26 10% risk", "2026-01-01", "2026-05-19", TREND_HTF_ST_BNB_AGGRESSIVE_PRESET);

await closePool?.();
