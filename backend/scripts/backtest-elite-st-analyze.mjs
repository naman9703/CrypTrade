#!/usr/bin/env node
/**
 * Phase A — Gate Impact Analysis on ST-only historical trades.
 *
 * For every trade taken by the plain SUPERTREND strategy (Jan 1 – May 19 2026),
 * this script reconstructs the 5-gate values AT signal time and shows:
 *   - How many loss trades each gate would have blocked
 *   - How many win trades each gate would have also blocked (cost)
 *   - Gate combinations that maximise loss-block while keeping winners
 *
 * Usage: node scripts/backtest-elite-st-analyze.mjs [--symbol BNBUSDT] [--from 2026-01-01] [--to 2026-05-19]
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles }                  = await import("../src/backtest/data/klineIngest.js");
const { runSimulation }                = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics }            = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters }        = await import("../src/backtest/engine/signals/baselines.js");
const { buildEliteStSignalSeries, ELITE_ST_DEFAULTS } = await import("../src/strategy/supertrendElite.js");
const { ema, adx: computeAdx, atr: computeAtr } = await import("../src/strategy/indicators.js");
const { computeSupertrendSeries }      = await import("../src/strategy/supertrend.js");

// ── CLI args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const get  = (flag, def) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : def; };
const SYMBOL = get("--symbol", "BNBUSDT");
const FROM   = get("--from",   "2026-01-01");
const TO     = get("--to",     "2026-05-19");

// ── Base ST config ────────────────────────────────────────────────────────────
const BASE_CFG = {
  marketMode: "FUTURES",
  futuresLeverage: 25,
  backtestPositionSizing: "RISK_AT_SL",
  strategyMode: "MANUAL",
  manualStrategy: "SUPERTREND",
  trailingStopLossAuto: false,
  slippagePct: 0.0005,
  tradeHistoryTakerOpenFeeRate: 0.0004,
  tradeHistoryTakerCloseFeeRate: 0.0004,
  riskPerTrade: 7,
  riskPerTradeUnit: "PCT_EQUITY",
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
};

console.log(`\n═══ Supertrend Elite — Gate Impact Analysis ═══`);
console.log(`Symbol: ${SYMBOL}  |  ${FROM} → ${TO}\n`);

// ── Load candles ──────────────────────────────────────────────────────────────
const fromMs = new Date(FROM).getTime();
const toMs   = new Date(TO).getTime();
const candles = await readCandles(SYMBOL, "15m", fromMs, toMs);
console.log(`Candles loaded: ${candles.length}`);

// ── Run plain ST baseline ─────────────────────────────────────────────────────
console.log("\n► Running plain Supertrend baseline...");
const adapters = await buildBacktestAdapters({ strategyKey: "SUPERTREND", cfg: BASE_CFG, symbol: SYMBOL, tf: "15m", candles, fromMs });
const base = await runSimulation({ strategyKey: "SUPERTREND", candles, cfg: BASE_CFG, gateMode: "off", fundingRates: [], startingUsdt: 100, timeframe: "15m", adapters, symbol: SYMBOL });
const bm   = computeAllMetrics({ trades: base.trades, equityCurve: base.equityCurve, tf: "15m", startingEquity: 100 });

const wins   = base.trades.filter((t) => (t.netPnl ?? 0) > 0);
const losses = base.trades.filter((t) => (t.netPnl ?? 0) <= 0);
console.log(`  Total trades: ${base.trades.length}  |  Wins: ${wins.length}  |  Losses: ${losses.length}`);
console.log(`  Win rate: ${((bm.winRate ?? 0) * 100).toFixed(1)}%  |  Return: ${(bm.totalReturnPct ?? 0).toFixed(1)}%`);

// ── Pre-compute ALL gate series in one pass ───────────────────────────────────
console.log("\n► Pre-computing gate series...");

// Reuse the elite signal series at various gate thresholds
function countGateImpact(tradesToCheck, series, candles) {
  let blocked = 0;
  for (const t of tradesToCheck) {
    // Find candle index for this trade's open timestamp
    const idx = candles.findIndex((c) => c.ts >= t.entryTs);
    if (idx < 0) continue;
    // The signal was on the bar BEFORE entry (entry = next bar open)
    const sigIdx = Math.max(0, idx - 1);
    if (!series[sigIdx]) blocked++;
  }
  return blocked;
}

// Test a variety of threshold combinations
const gateTests = [
  // label, opts
  ["ADX≥20+rising",       { minAdx: 20, requireAdxRising: true,  minVolumeVsAvg: 0,   requireHtf1hEmaAlign: false, requireHtf4hAlign: false, requireAtrExpansion: false }],
  ["ADX≥25+rising",       { minAdx: 25, requireAdxRising: true,  minVolumeVsAvg: 0,   requireHtf1hEmaAlign: false, requireHtf4hAlign: false, requireAtrExpansion: false }],
  ["ADX≥30+rising",       { minAdx: 30, requireAdxRising: true,  minVolumeVsAvg: 0,   requireHtf1hEmaAlign: false, requireHtf4hAlign: false, requireAtrExpansion: false }],
  ["Vol≥1.3x",            { minAdx: 0,  requireAdxRising: false, minVolumeVsAvg: 1.3, requireHtf1hEmaAlign: false, requireHtf4hAlign: false, requireAtrExpansion: false }],
  ["Vol≥1.5x",            { minAdx: 0,  requireAdxRising: false, minVolumeVsAvg: 1.5, requireHtf1hEmaAlign: false, requireHtf4hAlign: false, requireAtrExpansion: false }],
  ["Vol≥2.0x",            { minAdx: 0,  requireAdxRising: false, minVolumeVsAvg: 2.0, requireHtf1hEmaAlign: false, requireHtf4hAlign: false, requireAtrExpansion: false }],
  ["1H EMA align",        { minAdx: 0,  requireAdxRising: false, minVolumeVsAvg: 0,   requireHtf1hEmaAlign: true,  requireHtf4hAlign: false, requireAtrExpansion: false }],
  ["4H ST align",         { minAdx: 0,  requireAdxRising: false, minVolumeVsAvg: 0,   requireHtf1hEmaAlign: false, requireHtf4hAlign: true,  requireAtrExpansion: false }],
  ["ATR exp≥1.1x",        { minAdx: 0,  requireAdxRising: false, minVolumeVsAvg: 0,   requireHtf1hEmaAlign: false, requireHtf4hAlign: false, requireAtrExpansion: true,  minAtrExpansion: 1.1 }],
  ["ATR exp≥1.2x",        { minAdx: 0,  requireAdxRising: false, minVolumeVsAvg: 0,   requireHtf1hEmaAlign: false, requireHtf4hAlign: false, requireAtrExpansion: true,  minAtrExpansion: 1.2 }],
  ["4H+1H",               { minAdx: 0,  requireAdxRising: false, minVolumeVsAvg: 0,   requireHtf1hEmaAlign: true,  requireHtf4hAlign: true,  requireAtrExpansion: false }],
  ["ADX20+4H+1H",         { minAdx: 20, requireAdxRising: true,  minVolumeVsAvg: 0,   requireHtf1hEmaAlign: true,  requireHtf4hAlign: true,  requireAtrExpansion: false }],
  ["ADX25+4H+1H",         { minAdx: 25, requireAdxRising: true,  minVolumeVsAvg: 0,   requireHtf1hEmaAlign: true,  requireHtf4hAlign: true,  requireAtrExpansion: false }],
  ["ADX25+Vol+4H+1H",     { minAdx: 25, requireAdxRising: true,  minVolumeVsAvg: 1.3, requireHtf1hEmaAlign: true,  requireHtf4hAlign: true,  requireAtrExpansion: false }],
  ["ADX25+Vol+4H+1H+ATR", { minAdx: 25, requireAdxRising: true,  minVolumeVsAvg: 1.3, requireHtf1hEmaAlign: true,  requireHtf4hAlign: true,  requireAtrExpansion: true,  minAtrExpansion: 1.1 }],
  ["ADX20+Vol1.3+4H+ATR", { minAdx: 20, requireAdxRising: true,  minVolumeVsAvg: 1.3, requireHtf1hEmaAlign: false, requireHtf4hAlign: true,  requireAtrExpansion: true,  minAtrExpansion: 1.1 }],
  ["ALL gates (defaults)", { ...ELITE_ST_DEFAULTS }],
];

console.log(`\n${"Gate combo".padEnd(28)} | ${"Trades".padStart(6)} | ${"WinBlk".padStart(7)} | ${"LossBlk".padStart(8)} | ${"WinBlk%".padStart(8)} | ${"LossBlk%".padStart(9)} | Est.WR`);
console.log("─".repeat(90));

for (const [label, opts] of gateTests) {
  const series = buildEliteStSignalSeries(candles, opts);
  const passedWins   = wins.filter((t) => {
    const idx = candles.findIndex((c) => c.ts >= t.entryTs);
    if (idx < 0) return false;
    return series[Math.max(0, idx - 1)] != null;
  });
  const passedLosses = losses.filter((t) => {
    const idx = candles.findIndex((c) => c.ts >= t.entryTs);
    if (idx < 0) return false;
    return series[Math.max(0, idx - 1)] != null;
  });
  const total       = passedWins.length + passedLosses.length;
  const winBlocked  = wins.length - passedWins.length;
  const lossBlocked = losses.length - passedLosses.length;
  const estWR       = total > 0 ? (passedWins.length / total * 100) : 0;

  console.log(
    `${label.padEnd(28)} | ${String(total).padStart(6)} | ${String(winBlocked).padStart(7)} | ${String(lossBlocked).padStart(8)} | ` +
    `${(winBlocked / wins.length * 100).toFixed(1).padStart(7)}% | ${(lossBlocked / losses.length * 100).toFixed(1).padStart(8)}% | ${estWR.toFixed(1)}%`
  );
}

console.log(`\nBaseline: ${wins.length} wins / ${losses.length} losses / ${((wins.length / base.trades.length) * 100).toFixed(1)}% WR`);
console.log(`\nNote: 'Est.WR' = win rate assuming filtered trades have same outcome distribution.`);
console.log(`      'WinBlk%' = % of winners blocked (lower = better).`);
console.log(`      'LossBlk%' = % of losers blocked (higher = better).\n`);

await closePool?.();
