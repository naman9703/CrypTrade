#!/usr/bin/env node
/**
 * Tuning sweep for LIQ + S/R (institutional A+) — find params for higher, robust returns.
 * Ranks by a robustness-weighted score: mean net across coins, penalised if any coin is negative.
 *
 *   SYMBOLS=BTCUSDT,ETHUSDT,BNBUSDT FROM=2025-01-01 TO=2026-06-01 node scripts/backtest-liqsr-tune.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT").split(",").map((s) => s.trim()).filter(Boolean);
const TF = "15m";
const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-06-01";
const START = Number(process.env.START_USDT || 1000);
const RISK = Number(process.env.RISK_PCT || 1.5);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { INTRADAY_PRO_SR_APLUS_15M } = await import("../src/strategy/presets/srIntradayOptimized.js");

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();

const BASE = {
  ...INTRADAY_PRO_SR_APLUS_15M,
  marketMode: "FUTURES",
  slippagePct: 0.0005,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: RISK,
  riskPerTradeUnit: "PCT",
};

/** One-knob + combined variations on the A+ stack. */
const TUNINGS = [
  { label: "base (ext.4 rr2.0 vol1.15 bos+cf)", cfg: {} },
  { label: "ext.3 (looser sweep)", cfg: { intradayLiqMinSweepExtensionPct: 0.003 } },
  { label: "ext.6 (deeper sweep)", cfg: { intradayLiqMinSweepExtensionPct: 0.006 } },
  { label: "rr1.5 (more trades)", cfg: { intradayLiqMinRr: 1.5 } },
  { label: "rr2.5 (fewer, bigger)", cfg: { intradayLiqMinRr: 2.5 } },
  { label: "rr3 + maxTpRr3", cfg: { intradayLiqMinRr: 3.0, intradayLiqMaxTpRr: 3 } },
  { label: "vol1.3 (stronger thrust)", cfg: { intradaySrMinVolRatio: 1.3 } },
  { label: "no-BOS (sweep+confirm+vol)", cfg: { intradaySrRequireBos: false } },
  { label: "no-confirm", cfg: { intradaySrRequireConfirm: false } },
  { label: "zone.004 (wider S/R)", cfg: { intradaySrZoneWidthPct: 0.004 } },
  { label: "htfTrend ON (4h regime)", cfg: { intradaySrRequireHtfTrend: true, supertrendHtf4hEnabled: true } },
  { label: "3/day + bargap2", cfg: { srIntradayMaxTradesPerDay: 4, intradayLiqMaxTradesPerSidePerDay: 2, srIntradayMinBarGap: 2, intradayLiqOnePickPerDay: false } },
  { label: "wick.35 reclaim body.4", cfg: { intradayLiqMinWickRatio: 0.35, intradayLiqMinReclaimBodyRatio: 0.4 } },
  { label: "AGGR: ext.3 rr1.5 3/day vol1.0", cfg: { intradayLiqMinSweepExtensionPct: 0.003, intradayLiqMinRr: 1.5, srIntradayMaxTradesPerDay: 4, intradayLiqMaxTradesPerSidePerDay: 2, intradayLiqOnePickPerDay: false, intradaySrMinVolRatio: 1.0, srIntradayMinBarGap: 2 } },
  { label: "SELECT: ext.6 rr2.5 vol1.3 1/day", cfg: { intradayLiqMinSweepExtensionPct: 0.006, intradayLiqMinRr: 2.5, intradaySrMinVolRatio: 1.3, intradayLiqOnePickPerDay: true } },
];

const cache = new Map();
async function loadData(symbol) {
  if (cache.has(symbol)) return cache.get(symbol);
  const candles = await readCandles(symbol, TF, fromMs, toMs);
  let funding = [];
  try { funding = await readFundingRates(symbol, fromMs, toMs); } catch { funding = []; }
  const v = candles?.length ? { candles, funding } : null;
  cache.set(symbol, v);
  return v;
}

async function runOne(symbol, tuning) {
  const data = await loadData(symbol);
  if (!data) return null;
  const cfg = { ...BASE, ...tuning.cfg, symbol, timeframe: TF };
  const adapters = await buildBacktestAdapters({ strategyKey: "SR_INTRADAY", cfg, symbol, tf: TF, candles: data.candles, fromMs });
  const sim = await runSimulation({ strategyKey: "SR_INTRADAY", candles: data.candles, cfg, gateMode: "off", fundingRates: data.funding, startingUsdt: START, timeframe: TF, adapters, symbol });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: START });
  return { net: m.totalReturnPct, trades: m.totalTrades, wr: (m.winRate || 0) * 100, pf: m.profitFactor || 0, dd: m.maxDrawdownPct, calmar: m.calmar ?? 0 };
}

const fmt = (n, d = 1) => (Number.isFinite(n) ? Number(n).toFixed(d) : "—");
console.log(`\n=== LIQ + S/R (A+) TUNING SWEEP ===`);
console.log(`symbols=${SYMBOLS.join(",")} ${FROM}->${TO} risk=${RISK}% (realistic costs)\n`);

const results = [];
for (const t of TUNINGS) {
  const per = {};
  for (const sym of SYMBOLS) per[sym] = await runOne(sym, t);
  const nets = SYMBOLS.map((s) => per[s]?.net ?? 0);
  const mean = nets.reduce((a, b) => a + b, 0) / nets.length;
  const min = Math.min(...nets);
  const pos = nets.filter((n) => n > 0).length;
  const trades = SYMBOLS.reduce((a, s) => a + (per[s]?.trades ?? 0), 0);
  // robustness score: mean, halved if any coin negative; bonus for 3/3 positive
  const score = mean * (pos === SYMBOLS.length ? 1.0 : pos === SYMBOLS.length - 1 ? 0.6 : 0.3) + (min > 0 ? 3 : 0);
  results.push({ label: t.label, mean, min, pos, trades, score, per });
  process.stdout.write(`  ${t.label.padEnd(38)} mean=${fmt(mean).padStart(7)}% min=${fmt(min).padStart(7)}% pos=${pos}/${SYMBOLS.length} n=${trades}\n`);
}

results.sort((a, b) => b.score - a.score);
console.log(`\n=== RANKED (robustness-weighted) ===`);
console.log(`${"#".padEnd(3)}${"tuning".padEnd(40)}${"mean%".padStart(8)}${"min%".padStart(8)}${"pos".padStart(5)}${"trades".padStart(8)}${"score".padStart(8)}`);
results.forEach((r, i) => {
  console.log(`${String(i + 1).padEnd(3)}${r.label.padEnd(40)}${fmt(r.mean).padStart(8)}${fmt(r.min).padStart(8)}${`${r.pos}/${SYMBOLS.length}`.padStart(5)}${String(r.trades).padStart(8)}${fmt(r.score, 2).padStart(8)}`);
});

const best = results[0];
console.log(`\n=== BEST: ${best.label} — per coin ===`);
console.log(`${"symbol".padEnd(9)}${"net%".padStart(8)}${"trades".padStart(8)}${"wr%".padStart(6)}${"PF".padStart(7)}${"maxDD%".padStart(8)}${"Calmar".padStart(8)}`);
for (const sym of SYMBOLS) {
  const r = best.per[sym];
  if (!r) { console.log(`${sym.padEnd(9)}   no data`); continue; }
  console.log(`${sym.padEnd(9)}${fmt(r.net).padStart(8)}${String(r.trades).padStart(8)}${fmt(r.wr, 0).padStart(6)}${fmt(r.pf, 2).padStart(7)}${fmt(r.dd).padStart(8)}${fmt(r.calmar, 2).padStart(8)}`);
}

await closePool?.();
