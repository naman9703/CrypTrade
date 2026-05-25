#!/usr/bin/env node
/** Quick compare: max return vs surgical vs regime (user 10%/30x profile). */
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
const {
  TREND_HTF_ST_BNB_MAX_PRESET,
  TREND_HTF_ST_BNB_SURGICAL_PRESET,
  TREND_HTF_ST_BNB_CHOP_SAFE_PRESET,
  TREND_HTF_ST_BNB_WHIPSAW_GUARD_PRESET,
} = await import("../src/strategy/presets/trendHtfStOptimized.js");

const cache = new Map();
async function candles(from, to) {
  const k = `${from}|${to}`;
  if (!cache.has(k)) {
    cache.set(
      k,
      await readCandles("BNBUSDT", "15m", new Date(from).getTime(), new Date(to).getTime()),
    );
  }
  return cache.get(k);
}

async function run(name, cfg, from, to) {
  const fromMs = new Date(from).getTime();
  const c = await candles(from, to);
  const full = { ...cfg, strategyMode: "MANUAL", manualStrategy: "TREND_HTF_ST" };
  const adapters = await buildBacktestAdapters({
    strategyKey: "TREND_HTF_ST",
    cfg: full,
    symbol: "BNBUSDT",
    tf: "15m",
    candles: c,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "TREND_HTF_ST",
    candles: c,
    cfg: full,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: "15m",
    adapters,
    symbol: "BNBUSDT",
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: "15m",
    startingEquity: 100,
  });
  const losses = sim.trades.filter((t) => t.netPnl <= 0);
  const whipsaw = losses.filter((t) => t.lossPattern === "WHIPSAW_GAVE_BACK").length;
  return {
    name,
    wr: ((m.winRate ?? 0) * 100).toFixed(1),
    ret: (m.totalReturnPct ?? 0).toFixed(0),
    n: m.totalTrades,
    losses: losses.length,
    whipsaw,
  };
}

const windows = [
  ["Jan26", "2026-01-01", "2026-05-19"],
  ["H2", "2025-06-01", "2025-12-31"],
];

const presets = [
  ["MAX (regime OFF)", TREND_HTF_ST_BNB_MAX_PRESET],
  ["WHIPSAW guard (BE@1% MFE)", TREND_HTF_ST_BNB_WHIPSAW_GUARD_PRESET],
  ["SURGICAL (chop loss filter)", TREND_HTF_ST_BNB_SURGICAL_PRESET],
  ["REGIME ON (cuts ~50% trades)", TREND_HTF_ST_BNB_CHOP_SAFE_PRESET],
];

console.log("── Preset compare (10% risk, 30x, TP 3%) ──\n");
for (const [w, f, t] of windows) {
  console.log(`=== ${w} ===`);
  for (const [label, cfg] of presets) {
    const r = await run(label, cfg, f, t);
    console.log(
      `  ${r.name.padEnd(32)} WR ${r.wr}%  ret ${r.ret}%  trades ${r.n}  losses ${r.losses}  whipsaw ${r.whipsaw}`,
    );
  }
  console.log("");
}

await closePool?.();
