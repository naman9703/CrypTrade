#!/usr/bin/env node
/**
 * Daily trade coverage + win-rate stats for SMC profiles.
 * Usage: node scripts/backtest-smc-daily-stats.mjs [from] [to]
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

function utcDay(ts) {
  return Math.floor(ts / 86400000);
}

async function runProfile(label, overrides) {
  const cfg = fillSmcSoloPresetDefaults({
    ...INTRADAY_PRO_ICT_15M,
    symbol,
    timeframe: tf,
    ...overrides,
  });
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
  const byDay = new Map();
  for (const t of trades) {
    const d = utcDay(t.entryTs);
    byDay.set(d, (byDay.get(d) ?? 0) + Number(t.netPnl ?? 0));
  }

  const tradingDays = new Set();
  for (const c of candles) {
    if (c.ts >= fromMs && c.ts <= toMs) tradingDays.add(utcDay(c.ts));
  }

  let winDays = 0;
  let lossDays = 0;
  let flatDays = 0;
  for (const d of tradingDays) {
    if (!byDay.has(d)) continue;
    const pnl = byDay.get(d);
    if (pnl > 0) winDays += 1;
    else if (pnl < 0) lossDays += 1;
    else flatDays += 1;
  }

  const tradedDays = byDay.size;
  const totalDays = tradingDays.size;
  const entryPnls = [...byDay.values()];
  const wins = entryPnls.filter((p) => p > 0).length;
  const pnl = entryPnls.reduce((a, b) => a + b, 0);

  return {
    label,
    totalDays,
    tradedDays,
    zeroTradeDays: totalDays - tradedDays,
    coveragePct: Math.round((tradedDays / totalDays) * 1000) / 10,
    winDays,
    lossDays,
    profitableDayPct: tradedDays ? Math.round((winDays / tradedDays) * 1000) / 10 : 0,
    entries: byDay.size,
    winRatePct: tradedDays ? Math.round((wins / tradedDays) * 1000) / 10 : 0,
    returnPct: Math.round((pnl / 10_000) * 10000) / 100,
    pnlUsdt: Math.round(pnl * 100) / 100,
  };
}

const profiles = [
  ["daily_sniper (preset default)", {}],
  [
    "full strict",
    {
      intradaySmcIctProfile: "full",
      intradaySmcPickMode: "per_signal",
      intradaySmcOneTradePerDay: false,
      intradayLiqOnePickPerDay: false,
      srIntradayMaxTradesPerDay: 4,
    },
  ],
  [
    "sweep lite",
    {
      intradaySmcIctProfile: "sweep",
      intradaySmcPickMode: "daily_sniper",
      intradaySmcRequireMss: false,
      intradaySmcRequireChoch: false,
      intradaySmcRequireRetrace: false,
    },
  ],
];

const rows = [];
for (const [label, ovr] of profiles) {
  process.stderr.write(`Simulating ${label}...\n`);
  rows.push(await runProfile(label, ovr));
}

console.log(
  JSON.stringify(
    {
      symbol,
      tf,
      from: new Date(fromMs).toISOString().slice(0, 10),
      to: new Date(toMs).toISOString().slice(0, 10),
      note:
        "profitableDayPct = % of days WITH a trade that ended green. Not % of all calendar days.",
      profiles: rows,
    },
    null,
    2,
  ),
);
