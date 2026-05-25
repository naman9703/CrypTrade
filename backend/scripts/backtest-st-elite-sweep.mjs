#!/usr/bin/env node
/**
 * Supertrend Elite — gate threshold sweep.
 *
 * Tests combinations of ADX / volume / 1H-EMA / 4H-ST / ATR gates on
 * BNBUSDT 15m across three time windows:
 *   H2-2025  (Jun–Dec 2025)  — historical stress test
 *   Jan-May  (Jan–May 2026)  — recent performance
 *   1yr      (Jun 2025 – May 2026) — full year
 *
 * Ranks by minimum WR across windows + total return.
 * Target: ~100 trades total on Jan-May window, 80%+ WR, high return.
 *
 * Usage:
 *   node scripts/backtest-st-elite-sweep.mjs [--symbol BNBUSDT] [--risk 7]
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

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let SYMBOL = "BNBUSDT";
let RISK   = 7;
let TF     = "15m";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--symbol" && args[i+1]) { SYMBOL = args[i+1]; i++; }
  if (args[i] === "--risk"   && args[i+1]) { RISK   = Number(args[i+1]); i++; }
  if (args[i] === "--tf"     && args[i+1]) { TF     = args[i+1]; i++; }
}

const SK = "SUPERTREND_ELITE";

// ── Candle cache ──────────────────────────────────────────────────────────────
const cache = new Map();
async function candles(from, to) {
  const k = `${from}|${to}`;
  if (!cache.has(k))
    cache.set(k, await readCandles(SYMBOL, TF, new Date(from).getTime(), new Date(to).getTime()));
  return cache.get(k);
}

// ── Run helper ────────────────────────────────────────────────────────────────
async function run(label, from, to, extraCfg = {}) {
  const fromMs = new Date(from).getTime();
  const c = await candles(from, to);
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
    supertrendPeriod: 10,
    supertrendMultiplier: 3,
    supertrendWilderAtr: true,
    ...extraCfg,
  };
  const adapters = await buildBacktestAdapters({ strategyKey: SK, cfg, symbol: SYMBOL, tf: TF, candles: c, fromMs });
  const sim = await runSimulation({
    strategyKey: SK, candles: c, cfg, gateMode: "off",
    fundingRates: [], startingUsdt: 100, timeframe: TF, adapters, symbol: SYMBOL,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: 100 });
  return {
    label,
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
  ["1yr",   "2025-06-01", "2026-05-19"],
];

// ── Config sweep ──────────────────────────────────────────────────────────────
// Format: [label, extraCfg]
const configs = [
  // Baseline — plain SUPERTREND (no gates) for reference
  // (uses SUPERTREND_ELITE with all gates off)
  ["ST baseline (no gates)", {
    eliteStMinAdx: 0, eliteStRequireAdxRising: false,
    eliteStMinVolumeVsAvg: 0,
    eliteStRequireHtf1hEmaAlign: false,
    eliteStRequireHtf4hAlign: false,
    eliteStRequireAtrExpansion: false,
  }],

  // Gate-by-gate additions ──────────────────────────────────────────────────
  ["ADX≥20 only", { eliteStMinAdx: 20, eliteStRequireAdxRising: false, eliteStMinVolumeVsAvg: 0, eliteStRequireHtf1hEmaAlign: false, eliteStRequireHtf4hAlign: false, eliteStRequireAtrExpansion: false }],
  ["ADX≥25 only", { eliteStMinAdx: 25, eliteStRequireAdxRising: false, eliteStMinVolumeVsAvg: 0, eliteStRequireHtf1hEmaAlign: false, eliteStRequireHtf4hAlign: false, eliteStRequireAtrExpansion: false }],
  ["ADX≥25↑ only", { eliteStMinAdx: 25, eliteStRequireAdxRising: true,  eliteStMinVolumeVsAvg: 0, eliteStRequireHtf1hEmaAlign: false, eliteStRequireHtf4hAlign: false, eliteStRequireAtrExpansion: false }],
  ["Vol≥1.5 only", { eliteStMinAdx: 0, eliteStRequireAdxRising: false, eliteStMinVolumeVsAvg: 1.5, eliteStRequireHtf1hEmaAlign: false, eliteStRequireHtf4hAlign: false, eliteStRequireAtrExpansion: false }],
  ["4H-ST only",   { eliteStMinAdx: 0, eliteStRequireAdxRising: false, eliteStMinVolumeVsAvg: 0, eliteStRequireHtf1hEmaAlign: false, eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: false }],
  ["1H-EMA only",  { eliteStMinAdx: 0, eliteStRequireAdxRising: false, eliteStMinVolumeVsAvg: 0, eliteStRequireHtf1hEmaAlign: true,  eliteStRequireHtf4hAlign: false, eliteStRequireAtrExpansion: false }],
  ["ATR-exp only", { eliteStMinAdx: 0, eliteStRequireAdxRising: false, eliteStMinVolumeVsAvg: 0, eliteStRequireHtf1hEmaAlign: false, eliteStRequireHtf4hAlign: false, eliteStRequireAtrExpansion: true  }],

  // Two-gate combos ─────────────────────────────────────────────────────────
  ["ADX+4H",  { eliteStMinAdx: 25, eliteStRequireAdxRising: true,  eliteStMinVolumeVsAvg: 0,   eliteStRequireHtf1hEmaAlign: false, eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: false }],
  ["4H+1H",   { eliteStMinAdx: 0,  eliteStRequireAdxRising: false, eliteStMinVolumeVsAvg: 0,   eliteStRequireHtf1hEmaAlign: true,  eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: false }],
  ["Vol+4H",  { eliteStMinAdx: 0,  eliteStRequireAdxRising: false, eliteStMinVolumeVsAvg: 1.5, eliteStRequireHtf1hEmaAlign: false, eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: false }],
  ["ADX+1H",  { eliteStMinAdx: 25, eliteStRequireAdxRising: true,  eliteStMinVolumeVsAvg: 0,   eliteStRequireHtf1hEmaAlign: true,  eliteStRequireHtf4hAlign: false, eliteStRequireAtrExpansion: false }],

  // Three-gate combos ───────────────────────────────────────────────────────
  ["ADX+4H+1H",    { eliteStMinAdx: 25, eliteStRequireAdxRising: true,  eliteStMinVolumeVsAvg: 0,   eliteStRequireHtf1hEmaAlign: true,  eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: false }],
  ["ADX+Vol+4H",   { eliteStMinAdx: 25, eliteStRequireAdxRising: true,  eliteStMinVolumeVsAvg: 1.5, eliteStRequireHtf1hEmaAlign: false, eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: false }],
  ["Vol+4H+1H",    { eliteStMinAdx: 0,  eliteStRequireAdxRising: false, eliteStMinVolumeVsAvg: 1.5, eliteStRequireHtf1hEmaAlign: true,  eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: false }],
  ["ADX+4H+ATR",   { eliteStMinAdx: 25, eliteStRequireAdxRising: true,  eliteStMinVolumeVsAvg: 0,   eliteStRequireHtf1hEmaAlign: false, eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: true  }],
  ["4H+1H+ATR",    { eliteStMinAdx: 0,  eliteStRequireAdxRising: false, eliteStMinVolumeVsAvg: 0,   eliteStRequireHtf1hEmaAlign: true,  eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: true  }],

  // Four-gate combos ────────────────────────────────────────────────────────
  ["ADX+Vol+4H+1H",  { eliteStMinAdx: 25, eliteStRequireAdxRising: true,  eliteStMinVolumeVsAvg: 1.5, eliteStRequireHtf1hEmaAlign: true,  eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: false }],
  ["ADX+4H+1H+ATR",  { eliteStMinAdx: 25, eliteStRequireAdxRising: true,  eliteStMinVolumeVsAvg: 0,   eliteStRequireHtf1hEmaAlign: true,  eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: true  }],
  ["Vol+4H+1H+ATR",  { eliteStMinAdx: 0,  eliteStRequireAdxRising: false, eliteStMinVolumeVsAvg: 1.5, eliteStRequireHtf1hEmaAlign: true,  eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: true  }],

  // All 5 gates — default thresholds ────────────────────────────────────────
  ["ALL-5 (default)", { eliteStMinAdx: 25, eliteStRequireAdxRising: true, eliteStMinVolumeVsAvg: 1.5, eliteStRequireHtf1hEmaAlign: true, eliteStRequireHtf4hAlign: true, eliteStRequireAtrExpansion: true }],

  // Threshold fine-tuning ───────────────────────────────────────────────────
  ["ADX20+Vol1.2+4H+1H", { eliteStMinAdx: 20, eliteStRequireAdxRising: true, eliteStMinVolumeVsAvg: 1.2, eliteStRequireHtf1hEmaAlign: true, eliteStRequireHtf4hAlign: true, eliteStRequireAtrExpansion: false }],
  ["ADX25+Vol1.2+4H+1H", { eliteStMinAdx: 25, eliteStRequireAdxRising: true, eliteStMinVolumeVsAvg: 1.2, eliteStRequireHtf1hEmaAlign: true, eliteStRequireHtf4hAlign: true, eliteStRequireAtrExpansion: false }],
  ["ADX25+Vol1.5+4H+1H", { eliteStMinAdx: 25, eliteStRequireAdxRising: true, eliteStMinVolumeVsAvg: 1.5, eliteStRequireHtf1hEmaAlign: true, eliteStRequireHtf4hAlign: true, eliteStRequireAtrExpansion: false }],
  ["ADX28+Vol1.5+4H+1H", { eliteStMinAdx: 28, eliteStRequireAdxRising: true, eliteStMinVolumeVsAvg: 1.5, eliteStRequireHtf1hEmaAlign: true, eliteStRequireHtf4hAlign: true, eliteStRequireAtrExpansion: false }],
  ["ADX30+Vol1.5+4H+1H", { eliteStMinAdx: 30, eliteStRequireAdxRising: true, eliteStMinVolumeVsAvg: 1.5, eliteStRequireHtf1hEmaAlign: true, eliteStRequireHtf4hAlign: true, eliteStRequireAtrExpansion: false }],
  ["ADX25+Vol1.5+4H+1H+ATR1.1", { eliteStMinAdx: 25, eliteStRequireAdxRising: true, eliteStMinVolumeVsAvg: 1.5, eliteStRequireHtf1hEmaAlign: true, eliteStRequireHtf4hAlign: true, eliteStRequireAtrExpansion: true, eliteStMinAtrExpansion: 1.1 }],
  ["ADX25+Vol1.5+4H+1H+ATR1.2", { eliteStMinAdx: 25, eliteStRequireAdxRising: true, eliteStMinVolumeVsAvg: 1.5, eliteStRequireHtf1hEmaAlign: true, eliteStRequireHtf4hAlign: true, eliteStRequireAtrExpansion: true, eliteStMinAtrExpansion: 1.2 }],
  ["ADX25+Vol1.5+4H+1H+ATR1.3", { eliteStMinAdx: 25, eliteStRequireAdxRising: true, eliteStMinVolumeVsAvg: 1.5, eliteStRequireHtf1hEmaAlign: true, eliteStRequireHtf4hAlign: true, eliteStRequireAtrExpansion: true, eliteStMinAtrExpansion: 1.3 }],

  // With trailing stop (SUPERTREND mode) ─────────────────────────────────────
  ["ADX25+Vol1.5+4H+1H+trail", { eliteStMinAdx: 25, eliteStRequireAdxRising: true, eliteStMinVolumeVsAvg: 1.5, eliteStRequireHtf1hEmaAlign: true, eliteStRequireHtf4hAlign: true, eliteStRequireAtrExpansion: false, trailingStopLossAuto: true, futuresTrailingStopMode: "SUPERTREND" }],
  ["ALL-5+trail", { eliteStMinAdx: 25, eliteStRequireAdxRising: true, eliteStMinVolumeVsAvg: 1.5, eliteStRequireHtf1hEmaAlign: true, eliteStRequireHtf4hAlign: true, eliteStRequireAtrExpansion: true, trailingStopLossAuto: true, futuresTrailingStopMode: "SUPERTREND" }],

  // Liq sweep bonus ─────────────────────────────────────────────────────────
  ["ADX25+Vol1.5+4H+1H+liq", { eliteStMinAdx: 25, eliteStRequireAdxRising: true, eliteStMinVolumeVsAvg: 1.5, eliteStRequireHtf1hEmaAlign: true, eliteStRequireHtf4hAlign: true, eliteStRequireAtrExpansion: false, eliteStLiqSweepEnabled: true }],
];

// ── Main sweep ────────────────────────────────────────────────────────────────
console.log(`\nSupertrend Elite gate sweep — ${SYMBOL} ${TF}  risk=${RISK}%/trade`);
console.log("=".repeat(100));
const header =
  "Config".padEnd(36) +
  W.map((w) => `  ${w[0].padEnd(6)}WR  ${w[0].padEnd(4)}n`).join("") +
  "  minWR  score";
console.log(header);
console.log("-".repeat(100));

const results = [];
for (const [label, extraCfg] of configs) {
  const windowResults = [];
  for (const [wname, from, to] of W) {
    const r = await run(label, from, to, extraCfg);
    windowResults.push(r);
  }
  const minWr  = Math.min(...windowResults.map((r) => r.wr));
  const janRes = windowResults[1]; // Jan-May window is index 1
  const score  = 0.35 * windowResults[0].ret + 0.4 * windowResults[1].ret + 0.25 * windowResults[2].ret;
  results.push({ label, windowResults, minWr, janRes, score });

  let row = label.substring(0, 34).padEnd(36);
  for (const wr of windowResults) {
    row += `  ${wr.wr.toFixed(1).padStart(5)}%  ${String(wr.n).padStart(4)}`;
  }
  row += `  ${minWr.toFixed(1).padStart(5)}%  ${score.toFixed(1)}`;
  const flag = janRes.wr >= 80 && janRes.n <= 130 && janRes.n >= 60 ? " ✅" : (janRes.wr >= 75 ? " 🔶" : "");
  console.log(row + flag);
}

// ── Best results ──────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(100));
console.log("TOP 5 by score (weighted return across windows):");
const sorted = [...results].sort((a, b) => b.score - a.score).slice(0, 5);
for (const r of sorted) {
  const j = r.janRes;
  console.log(`  ${r.label.substring(0, 38).padEnd(40)} JanMay: WR ${j.wr.toFixed(1)}%  n=${j.n}  ret=${j.ret.toFixed(1)}%  PF=${j.pf.toFixed(2)}  score=${r.score.toFixed(1)}`);
}

console.log("\nTOP 5 by Jan-May win rate (target: 80%+ WR, 60-130 trades):");
const sortedWr = [...results]
  .filter((r) => r.janRes.n >= 20)
  .sort((a, b) => b.janRes.wr - a.janRes.wr)
  .slice(0, 5);
for (const r of sortedWr) {
  const j = r.janRes;
  console.log(`  ${r.label.substring(0, 38).padEnd(40)} JanMay: WR ${j.wr.toFixed(1)}%  n=${j.n}  ret=${j.ret.toFixed(1)}%  PF=${j.pf.toFixed(2)}  minWR=${r.minWr.toFixed(1)}%`);
}

const best80 = results
  .filter((r) => r.janRes.wr >= 80 && r.janRes.n >= 40 && r.janRes.n <= 160)
  .sort((a, b) => b.score - a.score);

if (best80.length) {
  console.log("\n🏆 CONFIGS MEETING 80%+ WR + TRADE COUNT TARGET:");
  for (const r of best80.slice(0, 5)) {
    const j = r.janRes;
    console.log(`  ${r.label.substring(0, 38).padEnd(40)} WR ${j.wr.toFixed(1)}%  n=${j.n}  ret=${j.ret.toFixed(1)}%  PF=${j.pf.toFixed(2)}  DD=${j.dd.toFixed(1)}%`);
  }
} else {
  console.log("\n⚠ No config met 80%+ WR + 40-160 trades. Best WR config:");
  const bestWr = sortedWr[0];
  if (bestWr) {
    const j = bestWr.janRes;
    console.log(`  ${bestWr.label}: WR ${j.wr.toFixed(1)}%  n=${j.n}  ret=${j.ret.toFixed(1)}%`);
    console.log("  → Try raising ADX threshold or enabling ATR expansion gate.");
  }
}

await closePool?.();
