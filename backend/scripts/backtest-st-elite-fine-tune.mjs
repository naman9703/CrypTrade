#!/usr/bin/env node
/**
 * Supertrend Elite — 1H fine-tuning sweep toward 80%+ WR.
 *
 * Starts from the best-found config: BTCUSDT 1H + trailing ST + 4H/ADX.
 * Tests stricter thresholds and additional constraints to push WR from
 * ~60% toward 80%+.
 *
 * Usage:
 *   node scripts/backtest-st-elite-fine-tune.mjs [--symbol BTCUSDT]
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
let SYMBOL = "BTCUSDT";
let RISK   = 5;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--symbol" && args[i+1]) { SYMBOL = args[i+1]; i++; }
  if (args[i] === "--risk"   && args[i+1]) { RISK   = Number(args[i+1]); i++; }
}

const SK = "SUPERTREND_ELITE";
const TF = "1h";

const BASE = {
  marketMode: "FUTURES",
  futuresLeverage: 25,
  backtestPositionSizing: "RISK_AT_SL",
  strategyMode: "MANUAL",
  manualStrategy: SK,
  slippagePct: 0.0005,
  tradeHistoryTakerOpenFeeRate: 0.0004,
  tradeHistoryTakerCloseFeeRate: 0.0004,
  riskPerTrade: RISK,
  riskPerTradeUnit: "PCT_EQUITY",
  supertrendWilderAtr: true,
  trailingStopLossAuto: true,
  futuresTrailingStopMode: "SUPERTREND",
};

// ── Candle cache ──────────────────────────────────────────────────────────────
const cache = new Map();
async function getCandles(from, to) {
  const k = `${from}|${to}`;
  if (!cache.has(k))
    cache.set(k, await readCandles(SYMBOL, TF, new Date(from).getTime(), new Date(to).getTime()));
  return cache.get(k);
}

// ── Run helper ────────────────────────────────────────────────────────────────
async function run(from, to, extraCfg = {}) {
  const c = await getCandles(from, to);
  const cfg = { ...BASE, ...extraCfg };
  const adapters = await buildBacktestAdapters({ strategyKey: SK, cfg, symbol: SYMBOL, tf: TF, candles: c, fromMs: new Date(from).getTime() });
  const sim = await runSimulation({
    strategyKey: SK, candles: c, cfg, gateMode: "off",
    fundingRates: [], startingUsdt: 100, timeframe: TF, adapters, symbol: SYMBOL,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: 100 });
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
  ["H2-25",  "2025-06-01", "2025-12-31"],
  ["JanMay", "2026-01-01", "2026-05-19"],
  ["1yr",    "2025-06-01", "2026-05-19"],
];

// ── Configs ───────────────────────────────────────────────────────────────────
const p = (period, mult) => ({ supertrendPeriod: period, supertrendMultiplier: mult });
const gate = (adx, adxRise, vol, h4, htf1h, atr) => ({
  eliteStMinAdx: adx,
  eliteStRequireAdxRising: adxRise,
  eliteStMinVolumeVsAvg: vol,
  eliteStRequireHtf4hAlign: h4,
  eliteStRequireHtf1hEmaAlign: htf1h,
  eliteStRequireAtrExpansion: atr,
});

const configs = [
  // Anchors ───────────────────────────────────────────────────────────────────
  ["ANCHOR: 4H-trail",        { ...p(10,3), ...gate(0,false,0,true,false,false) }],
  ["ANCHOR: ADX20+4H-trail",  { ...p(10,3), ...gate(20,true,0,true,false,false) }],
  ["ANCHOR: ADX25+4H-trail",  { ...p(10,3), ...gate(25,true,0,true,false,false) }],
  ["ANCHOR: ADX30+4H-trail",  { ...p(10,3), ...gate(30,true,0,true,false,false) }],
  ["ANCHOR: ADX35+4H-trail",  { ...p(10,3), ...gate(35,true,0,true,false,false) }],
  ["ANCHOR: ADX20+4H-trail (norise)", { ...p(10,3), ...gate(20,false,0,true,false,false) }],

  // Period / mult variants of the best config ──────────────────────────────────
  ["p10m3 ADX20+4H",   { ...p(10,3),   ...gate(20,true,0,true,false,false) }],
  ["p10m3.5 ADX20+4H", { ...p(10,3.5), ...gate(20,true,0,true,false,false) }],
  ["p14m3 ADX20+4H",   { ...p(14,3),   ...gate(20,true,0,true,false,false) }],
  ["p14m3.5 ADX20+4H", { ...p(14,3.5), ...gate(20,true,0,true,false,false) }],
  ["p14m4 ADX20+4H",   { ...p(14,4),   ...gate(20,true,0,true,false,false) }],
  ["p20m3 ADX20+4H",   { ...p(20,3),   ...gate(20,true,0,true,false,false) }],

  // Add volume to best config ──────────────────────────────────────────────────
  ["ADX20+4H+Vol1.2",  { ...p(10,3), ...gate(20,true,1.2,true,false,false) }],
  ["ADX20+4H+Vol1.5",  { ...p(10,3), ...gate(20,true,1.5,true,false,false) }],
  ["ADX20+4H+Vol2.0",  { ...p(10,3), ...gate(20,true,2.0,true,false,false) }],

  // Add 1H EMA to best config ──────────────────────────────────────────────────
  ["ADX20+4H+1H-EMA",        { ...p(10,3), ...gate(20,true,0,true,true,false) }],
  ["ADX20+4H+1H-EMA+Vol1.3", { ...p(10,3), ...gate(20,true,1.3,true,true,false) }],
  ["4H+1H-EMA",              { ...p(10,3), ...gate(0,false,0,true,true,false) }],
  ["4H+1H-EMA+Vol1.3",       { ...p(10,3), ...gate(0,false,1.3,true,true,false) }],

  // Add ATR expansion ──────────────────────────────────────────────────────────
  ["ADX20+4H+ATR1.1",        { ...p(10,3), ...gate(20,true,0,true,false,true), eliteStMinAtrExpansion:1.1 }],
  ["ADX20+4H+ATR1.15",       { ...p(10,3), ...gate(20,true,0,true,false,true), eliteStMinAtrExpansion:1.15 }],
  ["ADX20+4H+ATR1.2",        { ...p(10,3), ...gate(20,true,0,true,false,true), eliteStMinAtrExpansion:1.2 }],
  ["ADX20+4H+1H+ATR1.1",     { ...p(10,3), ...gate(20,true,0,true,true, true), eliteStMinAtrExpansion:1.1 }],

  // Liq sweep bonus ────────────────────────────────────────────────────────────
  ["ADX20+4H+liq",            { ...p(10,3), ...gate(20,true,0,true,false,false), eliteStLiqSweepEnabled:true }],
  ["4H-trail+liq",            { ...p(10,3), ...gate(0,false,0,true,false,false), eliteStLiqSweepEnabled:true }],

  // Without trailing stop (for comparison) ─────────────────────────────────────
  ["ADX20+4H (no-trail)",     { ...p(10,3), ...gate(20,true,0,true,false,false), trailingStopLossAuto:false }],
  ["4H-only (no-trail)",      { ...p(10,3), ...gate(0,false,0,true,false,false), trailingStopLossAuto:false }],

  // BTCUSDT-specific: wider ST to catch only big flips ─────────────────────────
  ["p7m3 ADX20+4H",    { ...p(7,3),   ...gate(20,true,0,true,false,false) }],
  ["p10m4 ADX20+4H",   { ...p(10,4),  ...gate(20,true,0,true,false,false) }],
  ["p10m5 ADX20+4H",   { ...p(10,5),  ...gate(20,true,0,true,false,false) }],
  ["p7m4 ADX20+4H",    { ...p(7,4),   ...gate(20,true,0,true,false,false) }],

  // All-window best ─────────────────────────────────────────────────────────────
  ["ADX25+Vol1.3+4H",         { ...p(10,3), ...gate(25,true,1.3,true,false,false) }],
  ["ADX25+Vol1.3+4H+1H",      { ...p(10,3), ...gate(25,true,1.3,true,true,false) }],
  ["ADX25+Vol1.3+4H+1H+ATR",  { ...p(10,3), ...gate(25,true,1.3,true,true,true), eliteStMinAtrExpansion:1.1 }],
];

// ── Main ──────────────────────────────────────────────────────────────────────
console.log(`\nSupertrend Elite 1H fine-tune sweep — ${SYMBOL}  risk=${RISK}%  (all with trailing ST stop unless noted)`);
console.log("=".repeat(106));
const header = "Config".padEnd(34) + W.map(w => ` ${w[0].padEnd(8)}WR  n  ret%`).join("") + "  minWR  score";
console.log(header);
console.log("-".repeat(106));

const results = [];
for (const [label, extraCfg] of configs) {
  const wrs = [];
  for (const [, from, to] of W) {
    const r = await run(from, to, extraCfg);
    wrs.push(r);
  }
  const minWr  = Math.min(...wrs.map(r => r.wr));
  const score  = 0.35 * wrs[0].ret + 0.4 * wrs[1].ret + 0.25 * wrs[2].ret;
  results.push({ label, wrs, minWr, score });
  let row = label.substring(0, 32).padEnd(34);
  for (const r of wrs) {
    row += ` ${r.wr.toFixed(0).padStart(4)}%  ${String(r.n).padStart(3)}  ${r.ret.toFixed(0).padStart(4)}%`;
  }
  row += `  ${minWr.toFixed(0).padStart(4)}%  ${score.toFixed(0).padStart(5)}`;
  const j = wrs[1];
  const flag = (j.wr >= 80 && j.n >= 10) ? " 🏆" : (j.wr >= 70 && j.n >= 8) ? " ✅" : (j.wr >= 60 && j.n >= 8) ? " 🔶" : "";
  console.log(row + flag);
}

// Summary
console.log("\n" + "=".repeat(106));
const sorted = [...results].sort((a, b) => b.score - a.score).slice(0, 8);
console.log("TOP 8 by composite score (0.35×H2 + 0.4×JanMay + 0.25×1yr returns):");
for (const r of sorted) {
  const j = r.wrs[1];
  console.log(`  ${r.label.substring(0,32).padEnd(34)} JanMay: WR ${j.wr.toFixed(1).padStart(5)}%  n=${String(j.n).padStart(3)}  ret=${j.ret.toFixed(0).padStart(5)}%  PF=${j.pf.toFixed(2).padStart(5)}  DD=${j.dd.toFixed(1).padStart(5)}%  minWR=${r.minWr.toFixed(1)}%`);
}

const hit80 = results.filter(r => r.wrs[1].wr >= 80 && r.wrs[1].n >= 10);
if (hit80.length) {
  console.log("\n🏆 CONFIGS WITH 80%+ WR (JanMay) + 10+ TRADES:");
  for (const r of hit80.sort((a,b) => b.score-a.score)) {
    const j = r.wrs[1]; const h = r.wrs[0];
    console.log(`  ${r.label}: JanMay WR ${j.wr.toFixed(1)}% n=${j.n} ret=${j.ret.toFixed(0)}%  H2 WR ${h.wr.toFixed(1)}% n=${h.n} ret=${h.ret.toFixed(0)}%  score=${r.score.toFixed(0)}`);
  }
}

await closePool?.();
