#!/usr/bin/env node
/**
 * Fast in-process SMC variant lab — loads candles ONCE, loops curated variants.
 * Edit VARIANTS below. Usage: node scripts/_smc-lab.mjs [from] [to]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const symbol = process.env.TUNE_SYMBOL || "BNBUSDT";
const tf = "15m";
const fromMs = Date.parse(process.argv[2] || "2026-01-01");
const toMs = Date.parse(process.argv[3] || "2026-03-01");
const weeks = (toMs - fromMs) / (7 * 864e5);

const { INTRADAY_PRO_ICT_15M, fillSmcSoloPresetDefaults } = await import("../src/strategy/presets/srIntradayOptimized.js");
const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { buildIntradayBacktestAdapter, mergeAdaptiveCfg } = await import("../src/strategy/intradayPro.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const candles = await readCandles(symbol, tf, fromMs - 5 * 864e5, toMs);
await closePool();
if (!candles.length) { console.error("no candles"); process.exit(1); }

export function metricsFromTrades(trades, from, to, startEq = 10000) {
  const w = (to - from) / (7 * 864e5);
  const filtered = trades.filter((t) => t.entryTs >= from && t.entryTs <= to);
  const byEntry = new Map();
  for (const t of filtered) {
    byEntry.set(t.entryTs, (byEntry.get(t.entryTs) ?? 0) + Number(t.netPnl ?? 0));
  }
  const pnls = [...byEntry.values()];
  const wins = pnls.filter((p) => p > 0);
  const gw = wins.reduce((a, b) => a + b, 0);
  const gl = Math.abs(pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0));
  let eq = startEq;
  let peak = startEq;
  let dd = 0;
  for (const t of filtered.slice().sort((a, b) => a.exitTs - b.exitTs)) {
    eq += Number(t.netPnl ?? 0);
    peak = Math.max(peak, eq);
    dd = Math.max(dd, (peak - eq) / peak);
  }
  const pnl = eq - startEq;
  return {
    n: byEntry.size,
    pw: Math.round((byEntry.size / w) * 10) / 10,
    wr: byEntry.size ? Math.round((wins.length / byEntry.size) * 1000) / 10 : 0,
    returnPct: Math.round((pnl / startEq) * 10000) / 100,
    pnlUsdt: Math.round(pnl * 100) / 100,
    ret: Math.round((pnl / startEq) * 10000) / 100,
    pf: gl > 0 ? Math.round((gw / gl) * 100) / 100 : null,
    dd: Math.round(dd * 1000) / 10,
  };
}

async function sim(ovr) {
  const cfg = fillSmcSoloPresetDefaults({ ...INTRADAY_PRO_ICT_15M, symbol, timeframe: tf, ...ovr });
  const merged = mergeAdaptiveCfg(cfg, candles);
  const out = await runSimulation({
    candles, strategyKey: "SR_INTRADAY",
    cfg: { ...merged, symbol, timeframe: tf, manualStrategy: "SR_INTRADAY", marketMode: "FUTURES", riskPerTrade: 2.5, futuresLeverage: 12 },
    gateMode: "off", fundingRates: [], startingUsdt: 10000, timeframe: tf, symbol,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, merged, tf) },
    costModelOverride: { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
  });
  return metricsFromTrades(out.trades, fromMs, toMs);
}

const VARIANTS = JSON.parse(process.env.SMC_VARIANTS || "[]");
if (!VARIANTS.length) VARIANTS.push({ _label: "baseline" });

process.stderr.write(`SMC lab ${symbol} ${tf} ${new Date(fromMs).toISOString().slice(0,10)}..${new Date(toMs).toISOString().slice(0,10)} (${weeks.toFixed(1)}w)\n`);
const rows = [];
const t0 = Date.now();
for (const v of VARIANTS) {
  const m = await sim(v);
  rows.push({ label: v._label || "?", ...m });
  process.stderr.write(`  ${v._label}: n=${m.n} pw=${m.pw} wr=${m.wr}% ret=${m.ret}% pf=${m.pf} dd=${m.dd}% (${((Date.now()-t0)/1000).toFixed(0)}s)\n`);
}
console.table(rows);
