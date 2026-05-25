#!/usr/bin/env node
/**
 * Supertrend Elite — timeframe + ST-param diagnostic sweep.
 *
 * Tests different primary timeframes (15m, 1h) and Supertrend multipliers
 * to find what combination yields 80%+ WR with ~100 trades.
 *
 * Usage:
 *   node scripts/backtest-st-elite-tf-sweep.mjs [--symbol BNBUSDT]
 */

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

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let SYMBOL = "BNBUSDT";
let RISK   = 7;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--symbol" && args[i+1]) { SYMBOL = args[i+1]; i++; }
  if (args[i] === "--risk"   && args[i+1]) { RISK   = Number(args[i+1]); i++; }
}

const SK = "SUPERTREND_ELITE";

// ── Candle cache ──────────────────────────────────────────────────────────────
const cache = new Map();
async function candles(tf, from, to) {
  const k = `${tf}|${from}|${to}`;
  if (!cache.has(k))
    cache.set(k, await readCandles(SYMBOL, tf, new Date(from).getTime(), new Date(to).getTime()));
  return cache.get(k);
}

// ── Run helper ────────────────────────────────────────────────────────────────
async function run(tf, from, to, extraCfg = {}) {
  const fromMs = new Date(from).getTime();
  const c = await candles(tf, from, to);
  const cfg = {
    marketMode: "FUTURES",
    futuresLeverage: 25,
    backtestPositionSizing: "RISK_AT_SL",
    strategyMode: "MANUAL",
    manualStrategy: SK,
    trailingStopLossAuto: false,
    slippagePct: 0.0005,
    tradeHistoryTakerOpenFeeRate: 0.0004,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    riskPerTrade: RISK,
    riskPerTradeUnit: "PCT_EQUITY",
    supertrendWilderAtr: true,
    ...extraCfg,
  };
  const adapters = await buildBacktestAdapters({ strategyKey: SK, cfg, symbol: SYMBOL, tf, candles: c, fromMs });
  const sim = await runSimulation({
    strategyKey: SK, candles: c, cfg, gateMode: "off",
    fundingRates: [], startingUsdt: 100, timeframe: tf, adapters, symbol: SYMBOL,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf, startingEquity: 100 });
  return {
    wr:  (m.winRate ?? 0) * 100,
    ret: m.totalReturnPct ?? 0,
    pf:  m.profitFactor ?? 0,
    dd:  m.maxDrawdownPct ?? 0,
    n:   m.totalTrades ?? 0,
  };
}

// ── Windows ───────────────────────────────────────────────────────────────────
const W = [
  ["H2",    "2025-06-01", "2025-12-31"],
  ["JanMay","2026-01-01", "2026-05-19"],
];

// ── Configs ───────────────────────────────────────────────────────────────────
// [label, tf, extraCfg]
const configs = [
  // 15m baselines ─────────────────────────────────────────────────────────────
  ["15m ST p10 m3 (baseline)",      "15m", { supertrendPeriod:10, supertrendMultiplier:3,   eliteStMinAdx:0, eliteStRequireAdxRising:false, eliteStMinVolumeVsAvg:0, eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:false, eliteStRequireAtrExpansion:false }],
  ["15m ST p10 m3.5",               "15m", { supertrendPeriod:10, supertrendMultiplier:3.5, eliteStMinAdx:0, eliteStRequireAdxRising:false, eliteStMinVolumeVsAvg:0, eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:false, eliteStRequireAtrExpansion:false }],
  ["15m ST p10 m4.5",               "15m", { supertrendPeriod:10, supertrendMultiplier:4.5, eliteStMinAdx:0, eliteStRequireAdxRising:false, eliteStMinVolumeVsAvg:0, eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:false, eliteStRequireAtrExpansion:false }],
  ["15m ST p14 m3",                 "15m", { supertrendPeriod:14, supertrendMultiplier:3,   eliteStMinAdx:0, eliteStRequireAdxRising:false, eliteStMinVolumeVsAvg:0, eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:false, eliteStRequireAtrExpansion:false }],
  ["15m ST p14 m4",                 "15m", { supertrendPeriod:14, supertrendMultiplier:4,   eliteStMinAdx:0, eliteStRequireAdxRising:false, eliteStMinVolumeVsAvg:0, eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:false, eliteStRequireAtrExpansion:false }],
  ["15m ST p20 m3",                 "15m", { supertrendPeriod:20, supertrendMultiplier:3,   eliteStMinAdx:0, eliteStRequireAdxRising:false, eliteStMinVolumeVsAvg:0, eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:false, eliteStRequireAtrExpansion:false }],
  ["15m ST p20 m4",                 "15m", { supertrendPeriod:20, supertrendMultiplier:4,   eliteStMinAdx:0, eliteStRequireAdxRising:false, eliteStMinVolumeVsAvg:0, eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:false, eliteStRequireAtrExpansion:false }],

  // 15m + 4H/1H alignment (best combo from previous sweep) ───────────────────
  ["15m p10m3 + 4H+1H",             "15m", { supertrendPeriod:10, supertrendMultiplier:3,   eliteStMinAdx:0, eliteStRequireAdxRising:false, eliteStMinVolumeVsAvg:0, eliteStRequireHtf1hEmaAlign:true,  eliteStRequireHtf4hAlign:true,  eliteStRequireAtrExpansion:false }],
  ["15m p14m3 + 4H+1H",             "15m", { supertrendPeriod:14, supertrendMultiplier:3,   eliteStMinAdx:0, eliteStRequireAdxRising:false, eliteStMinVolumeVsAvg:0, eliteStRequireHtf1hEmaAlign:true,  eliteStRequireHtf4hAlign:true,  eliteStRequireAtrExpansion:false }],
  ["15m p20m4 + 4H+1H",             "15m", { supertrendPeriod:20, supertrendMultiplier:4,   eliteStMinAdx:0, eliteStRequireAdxRising:false, eliteStMinVolumeVsAvg:0, eliteStRequireHtf1hEmaAlign:true,  eliteStRequireHtf4hAlign:true,  eliteStRequireAtrExpansion:false }],

  // 1H baselines ──────────────────────────────────────────────────────────────
  ["1h ST p10 m3 (baseline)",       "1h",  { supertrendPeriod:10, supertrendMultiplier:3,   eliteStMinAdx:0, eliteStRequireAdxRising:false, eliteStMinVolumeVsAvg:0, eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:false, eliteStRequireAtrExpansion:false }],
  ["1h ST p10 m3.5",                "1h",  { supertrendPeriod:10, supertrendMultiplier:3.5, eliteStMinAdx:0, eliteStRequireAdxRising:false, eliteStMinVolumeVsAvg:0, eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:false, eliteStRequireAtrExpansion:false }],
  ["1h ST p10 m4",                  "1h",  { supertrendPeriod:10, supertrendMultiplier:4,   eliteStMinAdx:0, eliteStRequireAdxRising:false, eliteStMinVolumeVsAvg:0, eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:false, eliteStRequireAtrExpansion:false }],
  ["1h ST p14 m3",                  "1h",  { supertrendPeriod:14, supertrendMultiplier:3,   eliteStMinAdx:0, eliteStRequireAdxRising:false, eliteStMinVolumeVsAvg:0, eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:false, eliteStRequireAtrExpansion:false }],

  // 1H + gates ────────────────────────────────────────────────────────────────
  ["1h p10m3 + ADX25",              "1h",  { supertrendPeriod:10, supertrendMultiplier:3,   eliteStMinAdx:25, eliteStRequireAdxRising:true,  eliteStMinVolumeVsAvg:0, eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:false, eliteStRequireAtrExpansion:false }],
  ["1h p10m3 + 4H align",           "1h",  { supertrendPeriod:10, supertrendMultiplier:3,   eliteStMinAdx:0,  eliteStRequireAdxRising:false, eliteStMinVolumeVsAvg:0, eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:true,  eliteStRequireAtrExpansion:false }],
  ["1h p10m3 + ADX+4H",             "1h",  { supertrendPeriod:10, supertrendMultiplier:3,   eliteStMinAdx:20, eliteStRequireAdxRising:true,  eliteStMinVolumeVsAvg:0, eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:true,  eliteStRequireAtrExpansion:false }],
  ["1h p10m3 + ADX+Vol",            "1h",  { supertrendPeriod:10, supertrendMultiplier:3,   eliteStMinAdx:20, eliteStRequireAdxRising:true,  eliteStMinVolumeVsAvg:1.3, eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:false, eliteStRequireAtrExpansion:false }],
  ["1h p10m3 + Vol+4H",             "1h",  { supertrendPeriod:10, supertrendMultiplier:3,   eliteStMinAdx:0,  eliteStRequireAdxRising:false, eliteStMinVolumeVsAvg:1.3, eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:true,  eliteStRequireAtrExpansion:false }],
  ["1h p10m3 + ADX+Vol+4H",         "1h",  { supertrendPeriod:10, supertrendMultiplier:3,   eliteStMinAdx:20, eliteStRequireAdxRising:true,  eliteStMinVolumeVsAvg:1.3, eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:true,  eliteStRequireAtrExpansion:false }],
  ["1h p10m3 + 4H+1HEMA",           "1h",  { supertrendPeriod:10, supertrendMultiplier:3,   eliteStMinAdx:0,  eliteStRequireAdxRising:false, eliteStMinVolumeVsAvg:0,   eliteStRequireHtf1hEmaAlign:true,  eliteStRequireHtf4hAlign:true,  eliteStRequireAtrExpansion:false }],
  ["1h p10m3 + ADX+4H+1HEMA",       "1h",  { supertrendPeriod:10, supertrendMultiplier:3,   eliteStMinAdx:20, eliteStRequireAdxRising:true,  eliteStMinVolumeVsAvg:0,   eliteStRequireHtf1hEmaAlign:true,  eliteStRequireHtf4hAlign:true,  eliteStRequireAtrExpansion:false }],
  ["1h p14m3 + ADX+4H",             "1h",  { supertrendPeriod:14, supertrendMultiplier:3,   eliteStMinAdx:20, eliteStRequireAdxRising:true,  eliteStMinVolumeVsAvg:0,   eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:true,  eliteStRequireAtrExpansion:false }],
  ["1h p14m3 + ADX+Vol+4H",         "1h",  { supertrendPeriod:14, supertrendMultiplier:3,   eliteStMinAdx:20, eliteStRequireAdxRising:true,  eliteStMinVolumeVsAvg:1.3, eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:true,  eliteStRequireAtrExpansion:false }],
  ["1h p14m3 + ADX+4H+1HEMA",       "1h",  { supertrendPeriod:14, supertrendMultiplier:3,   eliteStMinAdx:20, eliteStRequireAdxRising:true,  eliteStMinVolumeVsAvg:0,   eliteStRequireHtf1hEmaAlign:true,  eliteStRequireHtf4hAlign:true,  eliteStRequireAtrExpansion:false }],
  ["1h p14m3 + ALL-5",              "1h",  { supertrendPeriod:14, supertrendMultiplier:3,   eliteStMinAdx:20, eliteStRequireAdxRising:true,  eliteStMinVolumeVsAvg:1.3, eliteStRequireHtf1hEmaAlign:true,  eliteStRequireHtf4hAlign:true,  eliteStRequireAtrExpansion:true, eliteStMinAtrExpansion:1.1 }],

  // 1H with trailing ──────────────────────────────────────────────────────────
  ["1h p10m3 baseline + trail",     "1h",  { supertrendPeriod:10, supertrendMultiplier:3,   eliteStMinAdx:0, eliteStRequireAdxRising:false, eliteStMinVolumeVsAvg:0, eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:false, eliteStRequireAtrExpansion:false, trailingStopLossAuto:true, futuresTrailingStopMode:"SUPERTREND" }],
  ["1h p10m3 + 4H + trail",        "1h",  { supertrendPeriod:10, supertrendMultiplier:3,   eliteStMinAdx:0, eliteStRequireAdxRising:false, eliteStMinVolumeVsAvg:0, eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:true,  eliteStRequireAtrExpansion:false, trailingStopLossAuto:true, futuresTrailingStopMode:"SUPERTREND" }],
  ["1h p10m3 + ADX+4H + trail",    "1h",  { supertrendPeriod:10, supertrendMultiplier:3,   eliteStMinAdx:20, eliteStRequireAdxRising:true,  eliteStMinVolumeVsAvg:0, eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:true,  eliteStRequireAtrExpansion:false, trailingStopLossAuto:true, futuresTrailingStopMode:"SUPERTREND" }],
  ["1h p14m3 + ADX+4H + trail",    "1h",  { supertrendPeriod:14, supertrendMultiplier:3,   eliteStMinAdx:20, eliteStRequireAdxRising:true,  eliteStMinVolumeVsAvg:0, eliteStRequireHtf1hEmaAlign:false, eliteStRequireHtf4hAlign:true,  eliteStRequireAtrExpansion:false, trailingStopLossAuto:true, futuresTrailingStopMode:"SUPERTREND" }],
];

// ── Main ──────────────────────────────────────────────────────────────────────
console.log(`\nSupertrend Elite — TF + param sweep — ${SYMBOL}  risk=${RISK}%/trade`);
console.log("=".repeat(90));
const header = "Config".padEnd(36) + W.map(w => `  ${w[0].padEnd(5)}WR  ${w[0].padEnd(4)}n  ${w[0].padEnd(3)}ret%`).join("") + "  BestWR";
console.log(header);
console.log("-".repeat(90));

const results = [];
for (const [label, tf, extraCfg] of configs) {
  const wrs = [];
  for (const [, from, to] of W) {
    const r = await run(tf, from, to, extraCfg);
    wrs.push(r);
  }
  const bestWr = Math.max(...wrs.map(r => r.wr));
  results.push({ label, tf, wrs, bestWr });
  let row = label.substring(0, 34).padEnd(36);
  for (const r of wrs) {
    row += `  ${r.wr.toFixed(1).padStart(5)}%  ${String(r.n).padStart(4)}  ${r.ret.toFixed(0).padStart(5)}%`;
  }
  row += `  ${bestWr.toFixed(1).padStart(5)}%`;
  const flag = wrs.some(r => r.wr >= 80 && r.n >= 30) ? " 🏆" : (wrs.some(r => r.wr >= 60 && r.n >= 20) ? " 🔶" : (wrs.some(r => r.wr >= 50 && r.n >= 20) ? " →" : ""));
  console.log(row + flag);
}

// Summary
console.log("\n" + "=".repeat(90));
console.log("TOP PERFORMERS by max WR:");
const sorted = [...results].sort((a, b) => b.bestWr - a.bestWr).slice(0, 10);
for (const r of sorted) {
  const j = r.wrs[1]; // JanMay
  console.log(`  [${r.tf}] ${r.label.substring(0, 38).padEnd(40)} JanMay: WR ${j.wr.toFixed(1)}%  n=${j.n}  ret=${j.ret.toFixed(0)}%  PF=${j.pf.toFixed(2)}`);
}

await closePool?.();
