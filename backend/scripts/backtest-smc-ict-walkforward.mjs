#!/usr/bin/env node
/**
 * SMC/ICT walk-forward — train vs holdout month PnL (requires DB + completed sim).
 * Usage: node scripts/backtest-smc-ict-walkforward.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const symbol = "BNBUSDT";
const tf = "15m";
const trainEnd = Date.parse("2026-04-01");
const holdoutStart = trainEnd;
const holdoutEnd = Date.parse("2026-05-27");

const { INTRADAY_PRO_ICT_15M } = await import("../src/strategy/presets/srIntradayOptimized.js");
const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { buildIntradayBacktestAdapter, mergeAdaptiveCfg } = await import("../src/strategy/intradayPro.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { fillSmcSoloPresetDefaults } = await import("../src/strategy/presets/srIntradayOptimized.js");

async function runWindow(label, fromMs, toMs) {
  const candles = await readCandles(symbol, tf, fromMs - 5 * 864e5, toMs);
  const cfg = fillSmcSoloPresetDefaults({ ...INTRADAY_PRO_ICT_15M, symbol, timeframe: tf });
  const merged = mergeAdaptiveCfg(cfg, candles);
  const adapter = buildIntradayBacktestAdapter(candles, merged, tf);
  const result = await runSimulation({
    candles,
    adapters: { SR_INTRADAY: adapter },
    strategyKey: "SR_INTRADAY",
    cfg: {
      ...merged,
      symbol,
      timeframe: tf,
      manualStrategy: "SR_INTRADAY",
      marketMode: "FUTURES",
      riskPerTrade: 2.5,
      futuresLeverage: 12,
    },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 10_000,
    timeframe: tf,
    symbol,
    costModelOverride: { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
  });
  const trades = (result.trades ?? []).filter((t) => t.entryTs >= fromMs && t.entryTs <= toMs);
  const pnl = trades.reduce((s, t) => s + Number(t.netPnl ?? 0), 0);
  const wins = trades.filter((t) => Number(t.netPnl ?? 0) > 0).length;
  return {
    label,
    fromMs,
    toMs,
    trades: trades.length,
    winRatePct: trades.length ? Math.round((wins / trades.length) * 1000) / 10 : 0,
    pnl: Math.round(pnl * 100) / 100,
  };
}

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const train = await runWindow("train", Date.parse("2026-01-01"), trainEnd);
const holdout = await runWindow("holdout", holdoutStart, holdoutEnd);
await closePool();
console.log(JSON.stringify({ train, holdout }, null, 2));
