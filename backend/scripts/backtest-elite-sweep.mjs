#!/usr/bin/env node
/** Sweep elite configs: BE lock, HTF_RSI, ELITE, combined — target WR + return */
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

const cache = new Map();
async function candles(from, to) {
  const k = `${from}|${to}`;
  if (!cache.has(k)) cache.set(k, await readCandles("BNBUSDT", "15m", new Date(from).getTime(), new Date(to).getTime()));
  return cache.get(k);
}

async function run(label, from, to, strategyKey, cfg) {
  const fromMs = new Date(from).getTime();
  const c = await candles(from, to);
  const full = {
    marketMode: "FUTURES",
    futuresLeverage: 25,
    backtestPositionSizing: "RISK_AT_SL",
    strategyMode: "MANUAL",
    manualStrategy: strategyKey,
    trailingStopLossAuto: false,
    slippagePct: 0.0005,
    tradeHistoryTakerOpenFeeRate: 0.0004,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    riskPerTrade: 7,
    riskPerTradeUnit: "PCT_EQUITY",
    ...cfg,
  };
  const adapters = await buildBacktestAdapters({
    strategyKey,
    cfg: full,
    symbol: "BNBUSDT",
    tf: "15m",
    candles: c,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey,
    candles: c,
    cfg: full,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: "15m",
    adapters,
    symbol: "BNBUSDT",
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: "15m", startingEquity: 100 });
  const sl = sim.trades.filter((t) => t.exitReason === "sl").length;
  const n = m.totalTrades ?? 0;
  return {
    label,
    wr: (m.winRate ?? 0) * 100,
    ret: m.totalReturnPct ?? 0,
    n,
    slPct: n ? (sl / n) * 100 : 0,
  };
}

const windows = [
  ["H2", "2025-06-01", "2025-12-31"],
  ["Jan", "2026-01-01", "2026-05-19"],
  ["1yr", "2025-06-01", "2026-05-19"],
];

const configs = [
  ["user run (20% no regime)", "TREND_HTF_ST", { riskPerTrade: 20, trendHtfStRegimeGate: false }],
  ["prod TREND 7% regime", "TREND_HTF_ST", { trendHtfStRegimeGate: true }],
  ["TREND+BE@1% MFE", "TREND_HTF_ST", { trendHtfStRegimeGate: true, backtestBreakevenAtMfePct: 0.01 }],
  ["TREND+BE@0.8%", "TREND_HTF_ST", { trendHtfStRegimeGate: true, backtestBreakevenAtMfePct: 0.008 }],
  ["HTF_RSI 7%", "HTF_RSI", {}],
  ["HTF_RSI+BE@1%", "HTF_RSI", { backtestBreakevenAtMfePct: 0.01 }],
  ["HTF_RSI+BE@0.8%", "HTF_RSI", { backtestBreakevenAtMfePct: 0.008 }],
  ["HTF_RSI tp1.2 sl0.5", "HTF_RSI", { supertrendFuturesFixedSlPct: 0.005, supertrendFuturesFixedTpPct: 0.012 }],
  ["HTF_RSI tp1.0 sl0.5", "HTF_RSI", { supertrendFuturesFixedSlPct: 0.005, supertrendFuturesFixedTpPct: 0.01 }],
  ["ELITE_HTF", "ELITE_HTF", {}],
  ["ELITE+BE@1%", "ELITE_HTF", { backtestBreakevenAtMfePct: 0.01 }],
];

console.log("── Elite sweep (7% risk unless noted) ──\n");
const results = [];
for (const [name, key, cfg] of configs) {
  const row = { name, key, cfg, parts: [] };
  for (const [w, f, t] of windows) {
    const r = await run(name, f, t, key, cfg);
    row.parts.push({ w, ...r });
  }
  const h2 = row.parts.find((p) => p.w === "H2");
  const jan = row.parts.find((p) => p.w === "Jan");
  const yr = row.parts.find((p) => p.w === "1yr");
  row.score = h2.ret * 0.35 + jan.ret * 0.35 + yr.ret * 0.3;
  row.minWr = Math.min(h2.wr, jan.wr, yr.wr);
  results.push(row);
  console.log(
    `${name.padEnd(24)} H2=${h2.ret.toFixed(0)}%/${h2.wr.toFixed(0)}%/${h2.n} Jan=${jan.ret.toFixed(0)}%/${jan.wr.toFixed(0)}% 1yr=${yr.ret.toFixed(0)}%/${yr.wr.toFixed(0)}%`,
  );
}

results.sort((a, b) => b.minWr - a.minWr);
console.log("\n── Top by minimum WR across windows ──");
for (const r of results.slice(0, 5)) {
  console.log(`  ${r.name} minWR=${r.minWr.toFixed(0)}% score=${r.score.toFixed(0)}`);
}

await closePool?.();
