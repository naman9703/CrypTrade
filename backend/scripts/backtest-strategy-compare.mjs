#!/usr/bin/env node
/**
 * Compare EVERY registered strategy on the same data, ranked by net return,
 * using the real backtest adapter path (buildBacktestAdapters + runSimulation).
 *
 * Risk is normalized across strategies (same risk% + sizing) so the ranking
 * reflects edge, not leverage. The winner is then deep-validated separately.
 *
 * Usage:
 *   SYMBOLS=BTCUSDT,ETHUSDT,BNBUSDT TF=15m FROM=2025-01-01 node scripts/backtest-strategy-compare.mjs
 *   RISK_PCT=2 LEVERAGE=25 node scripts/backtest-strategy-compare.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT").split(",").map((s) => s.trim()).filter(Boolean);
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-06-01";
const START_USDT = Number(process.env.START_USDT || 1000);
const RISK_PCT = Number(process.env.RISK_PCT || 2);
const LEVERAGE = Number(process.env.LEVERAGE || 25);

const ONLY = (process.env.ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();

// Strategies to compare (skip ones needing external ML/HTTP or BTC-only consensus).
const STRATEGIES = [
  "EMA_CROSS", "RSI_MEAN", "BREAKOUT_VOL", "MOMENTUM_SURGE", "ENSEMBLE", "CONFLUENCE",
  "TREND_PULLBACK", "SMART_REVERSAL", "HTF_RSI", "TREND_HTF_ST", "HTF_LEG_RIDER",
  "APEX_TREND", "ELITE_HTF", "SUPERTREND_ELITE", "SR_INTRADAY", "INTRADAY_PRO",
  "VOLUME_PROFILE", "REGIME_ADAPTIVE",
];
const KEYS = ONLY.length ? ONLY : STRATEGIES;

// Base normalized config. Strategies with their own brackets ignore fixed SL/TP.
function baseCfg(sym) {
  return {
    symbol: sym,
    marketMode: "FUTURES",
    futuresLeverage: LEVERAGE,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: RISK_PCT,
    riskPerTradeUnit: "PCT",
    slippagePct: 0.0005,
    // Fallback fixed brackets (HTF_RSI etc. read these).
    supertrendFuturesFixedSlPct: 0.006,
    supertrendFuturesFixedTpPct: 0.018,
    trailingStopLossAuto: false,
    surfPulseMlGateEnabled: false,
  };
}

const data = {};
for (const sym of SYMBOLS) {
  const candles = await readCandles(sym, TF, fromMs, toMs);
  if (!candles?.length) {
    console.log(`[skip] ${sym} ${TF}: no candles`);
    continue;
  }
  let funding = [];
  try {
    funding = await readFundingRates(sym, fromMs, toMs);
  } catch {
    funding = [];
  }
  data[sym] = { candles, funding };
}

console.log(`\n=== STRATEGY COMPARISON — ${Object.keys(data).join(", ")} ${TF} ${FROM}->${TO} ===`);
console.log(`normalized: risk%=${RISK_PCT} lev=${LEVERAGE}x RISK_AT_SL · ${KEYS.length} strategies\n`);

const rows = [];
for (const sym of Object.keys(data)) {
  const { candles, funding } = data[sym];
  for (const key of KEYS) {
    let m;
    try {
      const cfg = baseCfg(sym);
      const adapters = await buildBacktestAdapters({ strategyKey: key, cfg, symbol: sym, tf: TF, candles, fromMs });
      const sim = await runSimulation({
        strategyKey: key,
        candles,
        cfg,
        gateMode: "off",
        fundingRates: funding,
        startingUsdt: START_USDT,
        timeframe: TF,
        adapters,
        symbol: sym,
      });
      m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: START_USDT });
    } catch (e) {
      rows.push({ sym, key, err: e?.message || "error" });
      continue;
    }
    rows.push({
      sym, key,
      net: m.totalReturnPct, trades: m.totalTrades, wr: (m.winRate || 0) * 100,
      pf: m.profitFactor || 0, dd: m.maxDrawdownPct, calmar: m.calmar ?? 0,
      sharpe: m.sharpe || 0, expR: m.expectancyR || 0,
    });
  }
  process.stdout.write(`  ${sym} done\n`);
}

const fmt = (n, d = 1) => (Number.isFinite(n) ? Number(n).toFixed(d) : "—");
function printTable(title, list) {
  console.log(`\n${title}`);
  console.log(
    `${"strategy".padEnd(16)}${"symbol".padEnd(9)}${"net%".padStart(9)}${"trades".padStart(8)}${"wr%".padStart(6)}${"PF".padStart(7)}${"maxDD%".padStart(8)}${"Calmar".padStart(8)}${"Sharpe".padStart(8)}`,
  );
  for (const r of list) {
    if (r.err) {
      console.log(`${r.key.padEnd(16)}${r.sym.padEnd(9)}  ERROR: ${r.err}`);
      continue;
    }
    console.log(
      `${r.key.padEnd(16)}${r.sym.padEnd(9)}${fmt(r.net).padStart(9)}${String(r.trades).padStart(8)}${fmt(r.wr, 0).padStart(6)}${fmt(r.pf, 2).padStart(7)}${fmt(r.dd).padStart(8)}${fmt(r.calmar, 2).padStart(8)}${fmt(r.sharpe, 2).padStart(8)}`,
    );
  }
}

const valid = rows.filter((r) => !r.err);
valid.sort((a, b) => b.net - a.net);
printTable(`========== ALL RESULTS (ranked by net return) ==========`, valid);

// Aggregate by strategy across symbols (mean net, min, robustness).
const byStrat = {};
for (const r of valid) {
  byStrat[r.key] = byStrat[r.key] || { nets: [], trades: 0 };
  byStrat[r.key].nets.push(r.net);
  byStrat[r.key].trades += r.trades;
}
const agg = Object.entries(byStrat).map(([key, v]) => ({
  key,
  mean: v.nets.reduce((a, b) => a + b, 0) / v.nets.length,
  min: Math.min(...v.nets),
  max: Math.max(...v.nets),
  posCount: v.nets.filter((x) => x > 0).length,
  n: v.nets.length,
  trades: v.trades,
}));
agg.sort((a, b) => b.mean - a.mean);
console.log(`\n========== BY STRATEGY (mean across ${SYMBOLS.length} symbols — robustness) ==========`);
console.log(`${"strategy".padEnd(16)}${"meanNet%".padStart(10)}${"minNet%".padStart(10)}${"maxNet%".padStart(10)}${"pos/sym".padStart(9)}${"trades".padStart(8)}`);
for (const a of agg) {
  console.log(`${a.key.padEnd(16)}${fmt(a.mean).padStart(10)}${fmt(a.min).padStart(10)}${fmt(a.max).padStart(10)}${`${a.posCount}/${a.n}`.padStart(9)}${String(a.trades).padStart(8)}`);
}

console.log(`\nTop single result: ${valid[0] ? `${valid[0].key} on ${valid[0].sym} = ${fmt(valid[0].net)}% (PF ${fmt(valid[0].pf, 2)}, maxDD ${fmt(valid[0].dd)}%, ${valid[0].trades} trades)` : "none"}`);
console.log(`Most robust (highest mean, all-symbol-positive): ${agg.find((a) => a.posCount === a.n)?.key ?? "none all-positive"}`);

await closePool?.();
