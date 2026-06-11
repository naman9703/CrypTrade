#!/usr/bin/env node
/**
 * Backtest the LIQUIDITY SWEEP combined with S/R and other valid strategies (confluence),
 * vs. liquidity-solo and the validated SUPERTREND_ELITE benchmark.
 *
 *   SYMBOLS=BTCUSDT,ETHUSDT,BNBUSDT FROM=2025-01-01 TO=2026-06-01 node scripts/backtest-liq-confluence.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT").split(",").map((s) => s.trim()).filter(Boolean);
const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-06-01";
const START = Number(process.env.START_USDT || 1000);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const {
  INTRADAY_PRO_LIQ_15M,
  INTRADAY_PRO_SR_APLUS_15M,
  INTRADAY_PRO_15M,
  INTRADAY_PRO_ICT_15M,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { SUPERTREND_ELITE_1H_PRESET } = await import("../src/strategy/presets/supertrendEliteOptimized.js");

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();
const COMMON = { marketMode: "FUTURES", slippagePct: 0.0005, backtestPositionSizing: "RISK_AT_SL", riskPerTradeUnit: "PCT" };

/** Each variant: a strategy key + cfg preset. Liquidity is core to the intraday ones. */
const VARIANTS = [
  { label: "LIQ solo (sweep only)", key: "SR_INTRADAY", tf: "15m", cfg: INTRADAY_PRO_LIQ_15M },
  { label: "LIQ + S/R (instit. A+)", key: "SR_INTRADAY", tf: "15m", cfg: INTRADAY_PRO_SR_APLUS_15M },
  { label: "LIQ + full gate stack", key: "SR_INTRADAY", tf: "15m", cfg: INTRADAY_PRO_15M },
  { label: "LIQ + SMC/ICT structure", key: "SR_INTRADAY", tf: "15m", cfg: INTRADAY_PRO_ICT_15M },
  { label: "SUPERTREND_ELITE (1H bench)", key: "SUPERTREND_ELITE", tf: "1h", cfg: SUPERTREND_ELITE_1H_PRESET },
];

const dataCache = new Map();
async function loadData(symbol, tf) {
  const k = `${symbol}:${tf}`;
  if (dataCache.has(k)) return dataCache.get(k);
  const candles = await readCandles(symbol, tf, fromMs, toMs);
  let funding = [];
  try {
    funding = await readFundingRates(symbol, fromMs, toMs);
  } catch {
    funding = [];
  }
  const v = candles?.length ? { candles, funding } : null;
  dataCache.set(k, v);
  return v;
}

async function runOne(symbol, variant) {
  const data = await loadData(symbol, variant.tf);
  if (!data) return null;
  const cfg = { ...COMMON, ...variant.cfg, symbol, timeframe: variant.tf };
  const adapters = await buildBacktestAdapters({ strategyKey: variant.key, cfg, symbol, tf: variant.tf, candles: data.candles, fromMs });
  const sim = await runSimulation({
    strategyKey: variant.key,
    candles: data.candles,
    cfg,
    gateMode: "off",
    fundingRates: data.funding,
    startingUsdt: START,
    timeframe: variant.tf,
    adapters,
    symbol,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: variant.tf, startingEquity: START });
  return {
    symbol,
    label: variant.label,
    net: m.totalReturnPct,
    trades: m.totalTrades,
    wr: (m.winRate || 0) * 100,
    pf: m.profitFactor || 0,
    dd: m.maxDrawdownPct,
    calmar: m.calmar ?? 0,
  };
}

console.log(`\n=== LIQUIDITY + CONFLUENCE backtest ===`);
console.log(`symbols=${SYMBOLS.join(",")} ${FROM}->${TO} (realistic costs: 0.05% slip + fees + funding)\n`);

const fmt = (n, d = 1) => (Number.isFinite(n) ? Number(n).toFixed(d) : "—");
const rows = [];
for (const sym of SYMBOLS) {
  for (const v of VARIANTS) {
    const r = await runOne(sym, v);
    if (r) rows.push(r);
  }
  process.stdout.write(`  ${sym} done\n`);
}

console.log(`\n${"symbol".padEnd(9)}${"variant".padEnd(30)}${"net%".padStart(8)}${"trades".padStart(8)}${"wr%".padStart(6)}${"PF".padStart(7)}${"maxDD%".padStart(8)}${"Calmar".padStart(8)}`);
for (const r of rows) {
  console.log(
    `${r.symbol.padEnd(9)}${r.label.padEnd(30)}${fmt(r.net).padStart(8)}${String(r.trades).padStart(8)}${fmt(r.wr, 0).padStart(6)}${fmt(r.pf, 2).padStart(7)}${fmt(r.dd).padStart(8)}${fmt(r.calmar, 2).padStart(8)}`,
  );
}

console.log(`\n=== BY VARIANT (across symbols) ===`);
const byV = {};
for (const r of rows) {
  byV[r.label] = byV[r.label] || { nets: [], trades: 0, pos: 0 };
  byV[r.label].nets.push(r.net);
  byV[r.label].trades += r.trades;
  byV[r.label].pos += r.net > 0 ? 1 : 0;
}
const agg = Object.entries(byV).map(([label, v]) => ({
  label,
  mean: v.nets.reduce((a, b) => a + b, 0) / v.nets.length,
  min: Math.min(...v.nets),
  pos: v.pos,
  n: v.nets.length,
  trades: v.trades,
}));
agg.sort((a, b) => b.mean - a.mean);
console.log(`${"variant".padEnd(30)}${"meanNet%".padStart(10)}${"minNet%".padStart(10)}${"pos/sym".padStart(9)}${"trades".padStart(8)}`);
for (const a of agg) {
  console.log(`${a.label.padEnd(30)}${fmt(a.mean).padStart(10)}${fmt(a.min).padStart(10)}${`${a.pos}/${a.n}`.padStart(9)}${String(a.trades).padStart(8)}`);
}

await closePool?.();
