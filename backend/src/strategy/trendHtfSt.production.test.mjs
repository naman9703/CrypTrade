/**
 * Production acceptance — TREND_HTF_ST macro regime (run in CI).
 * Requires DB candle data for BNBUSDT 15m.
 */
import test from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const { initPool, closePool, getPool } = await import("../db/pool.js");
const { readCandles } = await import("../backtest/data/klineIngest.js");
const { runSimulation } = await import("../backtest/engine/runner.js");
const { computeAllMetrics } = await import("../backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../backtest/engine/signals/baselines.js");
const { TREND_HTF_ST_BNB_MAX_PRESET } = await import("./presets/trendHtfStOptimized.js");

const HAS_DB = Boolean(process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING);

async function sim(from, to, cfg) {
  const fromMs = new Date(from).getTime();
  const candles = await readCandles("BNBUSDT", "15m", fromMs, new Date(to).getTime());
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
  const simResult = await runSimulation({
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
    trades: simResult.trades,
    equityCurve: simResult.equityCurve,
    tf: "15m",
    startingEquity: 100,
  });
  return {
    wr: (m.winRate ?? 0) * 100,
    ret: m.totalReturnPct ?? 0,
    n: m.totalTrades ?? 0,
    tagged: simResult.trades.filter((t) => t.entryQuality?.macroMode).length,
  };
}

test("TREND_HTF_ST balanced preset — positive Jan–May OOS window", { skip: !HAS_DB }, async () => {
  if (!getPool?.()) {
    await initPool({ info: () => {}, warn: () => {}, error: () => {} });
  }
  const cfg = (await import("./presets/trendHtfStOptimized.js")).TREND_HTF_ST_BNB_BALANCED_PRESET;
  const jan = await sim("2026-01-01", "2026-05-19", cfg);
  assert.ok(jan.n >= 40, `expected trades, got ${jan.n}`);
  assert.ok(jan.ret > 0, `Jan–May return ${jan.ret}% should be > 0`);
  assert.ok(jan.wr >= 15, `win rate ${jan.wr}%`);

  await closePool?.();
});
