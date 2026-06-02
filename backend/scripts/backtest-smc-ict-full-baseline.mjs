#!/usr/bin/env node
/** Compare SMC Sweep vs SMC ICT Full presets on BNB 15m (Jan–May 2026 window). */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const symbol = process.env.TUNE_SYMBOL || "BNBUSDT";
const tf = "15m";
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const fromMs = Date.parse(args[0] || "2026-01-01");
const toMs = Date.parse(args[1] || "2026-05-27");

const {
  INTRADAY_PRO_ICT_15M,
  INTRADAY_PRO_ICT_FULL_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { buildIntradayBacktestAdapter, mergeAdaptiveCfg } = await import("../src/strategy/intradayPro.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const candles = await readCandles(symbol, tf, fromMs - 5 * 864e5, toMs);
await closePool();

if (!candles.length) {
  console.error("No candles — sync klines first.");
  process.exit(1);
}

async function run(label, preset) {
  const cfg = materializeIntradayEngineCfgSync(
    { ...preset, symbol, timeframe: tf },
    materializeIntradayPanelOnCfg,
  );
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
  const byEntry = new Map();
  for (const t of trades) {
    byEntry.set(t.entryTs, (byEntry.get(t.entryTs) ?? 0) + Number(t.netPnl ?? 0));
  }
  const pnls = [...byEntry.values()];
  const entries = pnls.length;
  const wins = pnls.filter((p) => p > 0).length;
  const pnl = pnls.reduce((a, b) => a + b, 0);
  return {
    label,
    profile: cfg.intradaySmcIctProfile,
    killzone: cfg.intradaySmcKillzoneMode,
    premiumDiscount: cfg.intradaySmcRequirePremiumDiscount === true,
    entries,
    winRatePct: entries ? Math.round((wins / entries) * 1000) / 10 : 0,
    returnPct: Math.round((pnl / 10_000) * 10000) / 100,
  };
}

const sweep = await run("SMC Sweep (INTRADAY_PRO_ICT_15M)", INTRADAY_PRO_ICT_15M);
const full = await run("SMC ICT Full (INTRADAY_PRO_ICT_FULL_15M)", INTRADAY_PRO_ICT_FULL_15M);

console.log(
  JSON.stringify(
    {
      symbol,
      tf,
      from: new Date(fromMs).toISOString().slice(0, 10),
      to: new Date(toMs).toISOString().slice(0, 10),
      sweep,
      full,
    },
    null,
    2,
  ),
);
