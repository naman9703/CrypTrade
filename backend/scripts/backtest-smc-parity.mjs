#!/usr/bin/env node
/**
 * Parity check: lab metrics vs runSimulation (SMC solo, worker cfg path).
 * Usage: node scripts/backtest-smc-parity.mjs [from] [to]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const symbol = process.env.TUNE_SYMBOL || "BNBUSDT";
const tf = "15m";
const fromMs = Date.parse(process.argv[2] || "2026-01-01");
const toMs = Date.parse(process.argv[3] || "2026-05-27");

const { INTRADAY_PRO_ICT_15M, fillSmcSoloPresetDefaults } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { buildIntradayBacktestAdapter, mergeAdaptiveCfg } = await import("../src/strategy/intradayPro.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { metricsFromTrades } = await import("./_smc-lab.mjs");

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const candles = await readCandles(symbol, tf, fromMs - 5 * 864e5, toMs);
await closePool();
if (!candles.length) {
  console.error("No candles — sync klines first.");
  process.exit(1);
}

const rawCfg = fillSmcSoloPresetDefaults({
  ...INTRADAY_PRO_ICT_15M,
  symbol,
  timeframe: tf,
});
const workerCfg = materializeIntradayPanelOnCfg(rawCfg);
const merged = mergeAdaptiveCfg(workerCfg, candles);
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
const lab = metricsFromTrades(out.trades, fromMs, toMs);

console.log(
  JSON.stringify(
    {
      symbol,
      tf,
      profile: merged.intradaySmcIctProfile,
      gates: {
        smc: merged.intradayGateSmcIct,
        liq: merged.intradayGateLiquidity,
        fib: merged.intradayGateFib,
      },
      simTrades: out.trades.filter((t) => t.entryTs >= fromMs && t.entryTs <= toMs).length,
      lab,
      parityOk: lab.ret === lab.returnPct,
    },
    null,
    2,
  ),
);
