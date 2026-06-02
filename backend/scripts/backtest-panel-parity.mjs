#!/usr/bin/env node
/**
 * Reproduce backtest panel metrics (worker parity): candles [from,to] only, raw trade legs.
 * Usage: node scripts/backtest-panel-parity.mjs [from] [to] [preset]
 *   preset: research | sweep | pro15m (default research)
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const symbol = "BNBUSDT";
const tf = "15m";
const STARTING = 10_000;

function defaultFrom() {
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  return d.toISOString().slice(0, 10);
}
function defaultTo() {
  return new Date().toISOString().slice(0, 10);
}

const argv = process.argv.slice(2);
const fromStr = argv[0] || defaultFrom();
const toStr = argv[1] || defaultTo();
const presetName = (argv[2] || "research").toLowerCase();
const fromMs = Date.parse(fromStr);
const toMs = Date.parse(toStr);

const presets = await import("../src/strategy/presets/srIntradayOptimized.js");
const presetMap = {
  research: presets.INTRADAY_PRO_ICT_RESEARCH_15M,
  sweep: presets.INTRADAY_PRO_ICT_15M,
  pro15m: presets.INTRADAY_PRO_15M,
  full: presets.INTRADAY_PRO_ICT_FULL_15M,
};
const rawPreset = presetMap[presetName] ?? presetMap.research;

const { materializeIntradayEngineCfgSync } = presets;
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles, ensureKlines } = await import("../src/backtest/data/klineIngest.js");
const { buildIntradayBacktestAdapter, mergeAdaptiveCfg } = await import("../src/strategy/intradayPro.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { ensureBacktestMarketMode } = await import("../src/lib/strategyInstanceSplit.js");

await initPool({ info: () => {}, warn: () => {}, error: console.error });
await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" }).catch(() => {});
const candles = await readCandles(symbol, tf, fromMs, toMs);
await closePool();

if (!candles.length) {
  console.error("No candles — start DB and sync klines.");
  process.exit(1);
}

clearIntradayAdapterCache();
let cfg = materializeIntradayEngineCfgSync(
  { ...rawPreset, symbol, timeframe: tf },
  materializeIntradayPanelOnCfg,
);
cfg = ensureBacktestMarketMode(cfg);
const merged = mergeAdaptiveCfg(cfg, candles);

const sim = await runSimulation({
  strategyKey: "SR_INTRADAY",
  candles,
  cfg: merged,
  gateMode: "off",
  fundingRates: [],
  startingUsdt: STARTING,
  timeframe: tf,
  symbol,
  adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, merged, tf) },
  costModelOverride: { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
});

const m = computeAllMetrics({
  trades: sim.trades,
  equityCurve: sim.equityCurve,
  tf,
  startingEquity: STARTING,
});

const byEntry = new Map();
for (const t of sim.trades) {
  byEntry.set(t.entryTs, (byEntry.get(t.entryTs) ?? 0) + Number(t.netPnl ?? 0));
}

console.log(
  JSON.stringify(
    {
      note: "Matches backtest worker: candles strictly [from,to], panel Trades = raw legs, not entries",
      preset: presetName,
      window: { from: fromStr, to: toStr, bars: candles.length },
      panelMetrics: {
        trades: m.totalTrades,
        returnPct: Math.round(m.totalReturnPct * 10) / 10,
        maxDrawdownPct: Math.round(m.maxDrawdownPct * 10) / 10,
        winRatePct: Math.round(m.winRate * 1000) / 10,
        profitFactor: Math.round(m.profitFactor * 100) / 100,
      },
      researchStyle: {
        uniqueEntries: byEntry.size,
        expectancyPerEntryUsd: byEntry.size
          ? Math.round([...byEntry.values()].reduce((a, b) => a + b, 0) / byEntry.size)
          : null,
      },
      keyConfig: {
        intradayGateSmcIct: merged.intradayGateSmcIct,
        intradaySmcRequireChoch: merged.intradaySmcRequireChoch,
        intradaySmcFvgEntryMode: merged.intradaySmcFvgEntryMode,
        intradaySmcTp2Mode: merged.intradaySmcTp2Mode,
        intradaySmcMinRr: merged.intradaySmcMinRr,
        intradayLiqSessionExtreme: merged.intradayLiqSessionExtreme,
        riskPerTrade: merged.riskPerTrade,
      },
    },
    null,
    2,
  ),
);
