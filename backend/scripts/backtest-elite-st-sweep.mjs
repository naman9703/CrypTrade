#!/usr/bin/env node
/**
 * SUPERTREND_ELITE gate sweep — find the config that achieves ~100 trades
 * with 80%+ WR across Jan 2026 – May 2026.
 *
 * Tests dozens of gate-threshold combinations on BNBUSDT 15m.
 * Scores each config, ranks by: WR first, then trade count near target, then return.
 *
 * Usage: node scripts/backtest-elite-st-sweep.mjs [--symbol BNBUSDT] [--quick]
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles }       = await import("../src/backtest/data/klineIngest.js");
const { runSimulation }     = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

const argv   = process.argv.slice(2);
const get    = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const SYMBOL = get("--symbol", "BNBUSDT");
const QUICK  = argv.includes("--quick");

// ── Windows ───────────────────────────────────────────────────────────────────
const WINDOWS = QUICK
  ? [["Main", "2026-01-01", "2026-05-19"]]
  : [
      ["Main",   "2026-01-01", "2026-05-19"],
      ["H2-25",  "2025-06-01", "2025-12-31"],
      ["1yr",    "2025-06-01", "2026-05-19"],
    ];

// ── Candle cache ──────────────────────────────────────────────────────────────
const cache = new Map();
async function getCandles(from, to) {
  const k = `${from}|${to}`;
  if (!cache.has(k)) cache.set(k, await readCandles(SYMBOL, "15m", new Date(from).getTime(), new Date(to).getTime()));
  return cache.get(k);
}

// ── Run one simulation ────────────────────────────────────────────────────────
async function run(label, from, to, cfg) {
  const c   = await getCandles(from, to);
  const full = {
    marketMode: "FUTURES",
    futuresLeverage: 25,
    backtestPositionSizing: "RISK_AT_SL",
    strategyMode: "MANUAL",
    manualStrategy: "SUPERTREND_ELITE",
    trailingStopLossAuto: true,
    futuresTrailingStopMode: "SUPERTREND",
    slippagePct: 0.0005,
    tradeHistoryTakerOpenFeeRate: 0.0004,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    riskPerTrade: 7,
    riskPerTradeUnit: "PCT_EQUITY",
    supertrendPeriod: 10,
    supertrendMultiplier: 3,
    supertrendFuturesExitOnFlip: true,
    ...cfg,
  };
  const fromMs  = new Date(from).getTime();
  const adapters = await buildBacktestAdapters({ strategyKey: "SUPERTREND_ELITE", cfg: full, symbol: SYMBOL, tf: "15m", candles: c, fromMs });
  const sim     = await runSimulation({ strategyKey: "SUPERTREND_ELITE", candles: c, cfg: full, gateMode: "off", fundingRates: [], startingUsdt: 100, timeframe: "15m", adapters, symbol: SYMBOL });
  const m       = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: "15m", startingEquity: 100 });
  return {
    label,
    wr:  (m.winRate ?? 0) * 100,
    ret: m.totalReturnPct ?? 0,
    n:   m.totalTrades ?? 0,
    pf:  m.profitFactor ?? 0,
    dd:  m.maxDrawdownPct ?? 0,
  };
}

// ── Gate configs to sweep ─────────────────────────────────────────────────────
// Format: [label, overrides]
const CONFIGS = [
  // ── Baseline reference
  ["ST plain (baseline)", {
    manualStrategy: "SUPERTREND",
    trailingStopLossAuto: false,
    eliteStMinAdx: 0, eliteStRequireAdxRising: false,
    eliteStMinVolumeVsAvg: 0, eliteStRequireHtf1hEmaAlign: false,
    eliteStRequireHtf4hAlign: false, eliteStRequireAtrExpansion: false,
  }],

  // ── Individual gates
  ["ADX≥20 only",          { eliteStMinAdx: 20, eliteStRequireAdxRising: true,  eliteStMinVolumeVsAvg: 0,   eliteStRequireHtf1hEmaAlign: false, eliteStRequireHtf4hAlign: false, eliteStRequireAtrExpansion: false }],
  ["ADX≥25 only",          { eliteStMinAdx: 25, eliteStRequireAdxRising: true,  eliteStMinVolumeVsAvg: 0,   eliteStRequireHtf1hEmaAlign: false, eliteStRequireHtf4hAlign: false, eliteStRequireAtrExpansion: false }],
  ["4H align only",        { eliteStMinAdx: 0,  eliteStRequireAdxRising: false, eliteStMinVolumeVsAvg: 0,   eliteStRequireHtf1hEmaAlign: false, eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: false }],
  ["1H align only",        { eliteStMinAdx: 0,  eliteStRequireAdxRising: false, eliteStMinVolumeVsAvg: 0,   eliteStRequireHtf1hEmaAlign: true,  eliteStRequireHtf4hAlign: false, eliteStRequireAtrExpansion: false }],
  ["Vol≥1.5x only",        { eliteStMinAdx: 0,  eliteStRequireAdxRising: false, eliteStMinVolumeVsAvg: 1.5, eliteStRequireHtf1hEmaAlign: false, eliteStRequireHtf4hAlign: false, eliteStRequireAtrExpansion: false }],
  ["ATR≥1.15x only",       { eliteStMinAdx: 0,  eliteStRequireAdxRising: false, eliteStMinVolumeVsAvg: 0,   eliteStRequireHtf1hEmaAlign: false, eliteStRequireHtf4hAlign: false, eliteStRequireAtrExpansion: true, eliteStMinAtrExpansion: 1.15 }],

  // ── Key combos
  ["4H+1H",                { eliteStMinAdx: 0,  eliteStRequireAdxRising: false, eliteStMinVolumeVsAvg: 0,   eliteStRequireHtf1hEmaAlign: true,  eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: false }],
  ["ADX20+4H",             { eliteStMinAdx: 20, eliteStRequireAdxRising: true,  eliteStMinVolumeVsAvg: 0,   eliteStRequireHtf1hEmaAlign: false, eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: false }],
  ["ADX25+4H",             { eliteStMinAdx: 25, eliteStRequireAdxRising: true,  eliteStMinVolumeVsAvg: 0,   eliteStRequireHtf1hEmaAlign: false, eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: false }],
  ["ADX25+4H+1H",          { eliteStMinAdx: 25, eliteStRequireAdxRising: true,  eliteStMinVolumeVsAvg: 0,   eliteStRequireHtf1hEmaAlign: true,  eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: false }],
  ["ADX20+4H+1H",          { eliteStMinAdx: 20, eliteStRequireAdxRising: true,  eliteStMinVolumeVsAvg: 0,   eliteStRequireHtf1hEmaAlign: true,  eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: false }],
  ["ADX20+4H+ATR",         { eliteStMinAdx: 20, eliteStRequireAdxRising: true,  eliteStMinVolumeVsAvg: 0,   eliteStRequireHtf1hEmaAlign: false, eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: true, eliteStMinAtrExpansion: 1.1 }],
  ["ADX25+4H+ATR",         { eliteStMinAdx: 25, eliteStRequireAdxRising: true,  eliteStMinVolumeVsAvg: 0,   eliteStRequireHtf1hEmaAlign: false, eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: true, eliteStMinAtrExpansion: 1.1 }],
  ["ADX25+4H+1H+ATR1.1",   { eliteStMinAdx: 25, eliteStRequireAdxRising: true,  eliteStMinVolumeVsAvg: 0,   eliteStRequireHtf1hEmaAlign: true,  eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: true, eliteStMinAtrExpansion: 1.1 }],
  ["ADX25+4H+1H+ATR1.2",   { eliteStMinAdx: 25, eliteStRequireAdxRising: true,  eliteStMinVolumeVsAvg: 0,   eliteStRequireHtf1hEmaAlign: true,  eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: true, eliteStMinAtrExpansion: 1.2 }],

  // ── Volume added
  ["ADX20+Vol1.3+4H",      { eliteStMinAdx: 20, eliteStRequireAdxRising: true,  eliteStMinVolumeVsAvg: 1.3, eliteStRequireHtf1hEmaAlign: false, eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: false }],
  ["ADX25+Vol1.3+4H",      { eliteStMinAdx: 25, eliteStRequireAdxRising: true,  eliteStMinVolumeVsAvg: 1.3, eliteStRequireHtf1hEmaAlign: false, eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: false }],
  ["ADX20+Vol1.3+4H+1H",   { eliteStMinAdx: 20, eliteStRequireAdxRising: true,  eliteStMinVolumeVsAvg: 1.3, eliteStRequireHtf1hEmaAlign: true,  eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: false }],
  ["ADX25+Vol1.5+4H+1H",   { eliteStMinAdx: 25, eliteStRequireAdxRising: true,  eliteStMinVolumeVsAvg: 1.5, eliteStRequireHtf1hEmaAlign: true,  eliteStRequireHtf4hAlign: true,  eliteStRequireAtrExpansion: false }],

  // ── All 5 gates, varied thresholds
  ["ALL: ADX20 Vol1.2 ATR1.1", { eliteStMinAdx: 20, eliteStRequireAdxRising: true, eliteStMinVolumeVsAvg: 1.2, eliteStRequireHtf1hEmaAlign: true, eliteStRequireHtf4hAlign: true, eliteStRequireAtrExpansion: true, eliteStMinAtrExpansion: 1.1 }],
  ["ALL: ADX22 Vol1.3 ATR1.1", { eliteStMinAdx: 22, eliteStRequireAdxRising: true, eliteStMinVolumeVsAvg: 1.3, eliteStRequireHtf1hEmaAlign: true, eliteStRequireHtf4hAlign: true, eliteStRequireAtrExpansion: true, eliteStMinAtrExpansion: 1.1 }],
  ["ALL: ADX25 Vol1.3 ATR1.1", { eliteStMinAdx: 25, eliteStRequireAdxRising: true, eliteStMinVolumeVsAvg: 1.3, eliteStRequireHtf1hEmaAlign: true, eliteStRequireHtf4hAlign: true, eliteStRequireAtrExpansion: true, eliteStMinAtrExpansion: 1.1 }],
  ["ALL: ADX25 Vol1.5 ATR1.15",{ eliteStMinAdx: 25, eliteStRequireAdxRising: true, eliteStMinVolumeVsAvg: 1.5, eliteStRequireHtf1hEmaAlign: true, eliteStRequireHtf4hAlign: true, eliteStRequireAtrExpansion: true, eliteStMinAtrExpansion: 1.15 }],
  ["ALL: ADX30 Vol1.3 ATR1.2", { eliteStMinAdx: 30, eliteStRequireAdxRising: true, eliteStMinVolumeVsAvg: 1.3, eliteStRequireHtf1hEmaAlign: true, eliteStRequireHtf4hAlign: true, eliteStRequireAtrExpansion: true, eliteStMinAtrExpansion: 1.2 }],

  // ── Looser 1H sep threshold
  ["ADX25+4H+1H(loose)+ATR", { eliteStMinAdx: 25, eliteStRequireAdxRising: true, eliteStMinVolumeVsAvg: 0, eliteStRequireHtf1hEmaAlign: true, eliteStHtf1hMinSep: 0.0001, eliteStRequireHtf4hAlign: true, eliteStRequireAtrExpansion: true, eliteStMinAtrExpansion: 1.1 }],

  // ── With ST trailing vs no trailing
  ["ADX25+4H noTrail",     { eliteStMinAdx: 25, eliteStRequireAdxRising: true, eliteStMinVolumeVsAvg: 0, eliteStRequireHtf1hEmaAlign: false, eliteStRequireHtf4hAlign: true, eliteStRequireAtrExpansion: false, trailingStopLossAuto: false }],
  ["4H+1H noTrail",        { eliteStMinAdx: 0,  eliteStRequireAdxRising: false, eliteStMinVolumeVsAvg: 0, eliteStRequireHtf1hEmaAlign: true, eliteStRequireHtf4hAlign: true, eliteStRequireAtrExpansion: false, trailingStopLossAuto: false }],
];

// ── Header ────────────────────────────────────────────────────────────────────
console.log(`\n═══ Supertrend Elite Gate Sweep ═══  [${SYMBOL} 15m] [windows: ${WINDOWS.map(w=>w[0]).join(", ")}]\n`);

const headerCols = ["Config".padEnd(28), ...WINDOWS.map(([l]) => `${l}_WR`.padStart(8)), ...WINDOWS.map(([l]) => `${l}_n`.padStart(6)), ...WINDOWS.map(([l]) => `${l}_ret`.padStart(8))];
console.log(headerCols.join(" | "));
console.log("─".repeat(headerCols.reduce((s, h) => s + h.length, 0) + headerCols.length * 3));

const results = [];

for (const [label, cfgOverride] of CONFIGS) {
  const winResults = await Promise.all(WINDOWS.map(([wl, from, to]) => {
    const stratKey = cfgOverride.manualStrategy === "SUPERTREND" ? "SUPERTREND" : "SUPERTREND_ELITE";
    return run(wl, from, to, { manualStrategy: stratKey, ...cfgOverride });
  }));

  const row = { label, windows: winResults };
  results.push(row);

  const cols = [
    label.padEnd(28),
    ...winResults.map((r) => `${r.wr.toFixed(1)}%`.padStart(8)),
    ...winResults.map((r) => String(r.n).padStart(6)),
    ...winResults.map((r) => `${r.ret.toFixed(0)}%`.padStart(8)),
  ];
  console.log(cols.join(" | "));
}

// ── Find top candidates ───────────────────────────────────────────────────────
console.log("\n\n═══ Top configs ranked by Main WR (min 40 trades, Main WR ≥ 60%) ═══\n");
const mainWin = results
  .filter((r) => {
    const m = r.windows.find((w) => w.label === "Main");
    return m && m.wr >= 60 && m.n >= 40;
  })
  .sort((a, b) => {
    const am = a.windows.find((w) => w.label === "Main");
    const bm = b.windows.find((w) => w.label === "Main");
    return bm.wr - am.wr;
  })
  .slice(0, 10);

if (mainWin.length === 0) {
  console.log("No config met WR≥60% + n≥40. Top 5 by WR:");
  results
    .map((r) => ({ ...r, mainWr: r.windows.find((w) => w.label === "Main")?.wr ?? 0 }))
    .sort((a, b) => b.mainWr - a.mainWr)
    .slice(0, 5)
    .forEach((r) => {
      const m = r.windows.find((w) => w.label === "Main");
      console.log(`  ${r.label.padEnd(28)} WR=${m?.wr?.toFixed(1)}% n=${m?.n} ret=${m?.ret?.toFixed(0)}%`);
    });
} else {
  mainWin.forEach((r, rank) => {
    const m = r.windows.find((w) => w.label === "Main");
    const others = r.windows.filter((w) => w.label !== "Main").map((w) => `${w.label}: ${w.wr.toFixed(1)}%/${w.n}`).join("  ");
    console.log(`#${rank + 1}: ${r.label.padEnd(28)} Main WR=${m?.wr?.toFixed(1)}% n=${m?.n} ret=${m?.ret?.toFixed(0)}%  ${others}`);
  });
}

console.log("\nDone.\n");
await closePool?.();
