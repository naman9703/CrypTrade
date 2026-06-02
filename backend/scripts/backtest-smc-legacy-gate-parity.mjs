#!/usr/bin/env node
/** Verify SMC backtest uses ICT engine even when legacy gates are saved ON. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const symbol = "BNBUSDT";
const tf = "15m";
const fromMs = Date.parse("2026-01-01");
const toMs = Date.parse("2026-05-27");

const { INTRADAY_PRO_ICT_15M } = await import("../src/strategy/presets/srIntradayOptimized.js");
const { materializeIntradayEngineCfgSync } = await import("../src/strategy/presets/srIntradayOptimized.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { buildIntradayBacktestAdapter, mergeAdaptiveCfg } = await import("../src/strategy/intradayPro.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const candles = await readCandles(symbol, tf, fromMs - 5 * 864e5, toMs);
await closePool();

async function run(label, rawCfg) {
  const cfg = materializeIntradayEngineCfgSync(rawCfg, materializeIntradayPanelOnCfg);
  const merged = mergeAdaptiveCfg(cfg, candles);
  const out = await runSimulation({
    candles,
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
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, merged, tf) },
    costModelOverride: { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
  });
  const trades = out.trades.filter((t) => t.entryTs >= fromMs && t.entryTs <= toMs);
  const pnl = trades.reduce((a, t) => a + Number(t.netPnl ?? 0), 0);
  const wins = new Set(
    trades.filter((t) => Number(t.netPnl ?? 0) > 0).map((t) => t.entryTs),
  ).size;
  const entries = new Set(trades.map((t) => t.entryTs)).size;
  console.log(
    `${label}: entries=${entries} wr=${entries ? Math.round((wins / entries) * 1000) / 10 : 0}% ` +
      `ret=${Math.round((pnl / 10_000) * 10000) / 100}% smcGate=${cfg.intradayGateSmcIct} ` +
      `liqGate=${cfg.intradayGateLiquidity} choch=${cfg.intradaySmcRequireChoch}`,
  );
}

const smcOnly = { ...INTRADAY_PRO_ICT_15M, symbol, timeframe: tf };
const smcWithLegacy = {
  ...smcOnly,
  intradayGateLiquidity: true,
  intradayGateSession: true,
  intradayGateFib: true,
  intradayGateVp: true,
  intradayGateOrderFlow: true,
  intradayGateHtfRegime: true,
};
const performance = {
  ...smcOnly,
  intradaySmcRequireChoch: false,
  intradaySmcKillzoneMode: "ALL",
  intradaySmcHtfBiasMode: "ema",
};

await run("SMC solo (preset)", smcOnly);
await run("SMC + legacy gates ON (saved UI bug)", smcWithLegacy);
await run("SMC performance hybrid", performance);
