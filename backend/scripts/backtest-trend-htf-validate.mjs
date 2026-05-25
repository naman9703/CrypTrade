#!/usr/bin/env node
/**
 * Production acceptance tests for TREND_HTF_ST (must pass before deploy).
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
const { TREND_HTF_ST_BNB_MAX_PRESET } = await import("../src/strategy/presets/trendHtfStOptimized.js");

/** MAX RETURN preset: strong Jan + 1yr; H2 may be slightly negative without regime. */
const TARGETS = {
  H2: { minRet: -25, minWr: 30 },
  Jan26: { minRet: 200, minWr: 48 },
  "1yr": { minRet: 140, minWr: 35 },
};

const WINDOWS = [
  ["H2", "2025-06-01", "2025-12-31"],
  ["Jan26", "2026-01-01", "2026-05-19"],
  ["1yr", "2025-06-01", "2026-05-19"],
];

async function runWindow(from, to, cfg) {
  const fromMs = new Date(from).getTime();
  const candles = await readCandles("BNBUSDT", "15m", fromMs, new Date(to).getTime());
  const full = {
    marketMode: "FUTURES",
    futuresLeverage: 25,
    backtestPositionSizing: "RISK_AT_SL",
    strategyMode: "MANUAL",
    manualStrategy: "TREND_HTF_ST",
    trailingStopLossAuto: false,
    slippagePct: 0.0005,
    tradeHistoryTakerOpenFeeRate: 0.0004,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    ...cfg,
  };
  const adapters = await buildBacktestAdapters({
    strategyKey: "TREND_HTF_ST",
    cfg: full,
    symbol: "BNBUSDT",
    tf: "15m",
    candles,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "TREND_HTF_ST",
    candles,
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
  const sl = sim.trades.filter((t) => t.exitReason === "sl").length;
  const n = m.totalTrades ?? 0;
  const chopLosses = sim.trades.filter(
    (t) => t.netPnl <= 0 && t.entryQuality?.structuralRisk === "CHOP_ZONE",
  ).length;
  const totalLosses = sim.trades.filter((t) => t.netPnl <= 0).length;
  return {
    n,
    wr: (m.winRate ?? 0) * 100,
    ret: m.totalReturnPct ?? 0,
    slPct: n ? (sl / n) * 100 : 0,
    chopLosses,
    totalLosses,
  };
}

console.log("── TREND_HTF_ST production acceptance ──\n");

const { TREND_HTF_ST_BNB_CHOP_SAFE_PRESET } = await import("../src/strategy/presets/trendHtfStOptimized.js");

const variants = [
  { name: "MAX RETURN (default)", cfg: TREND_HTF_ST_BNB_MAX_PRESET },
  { name: "CHOP SAFE (regime ON)", cfg: TREND_HTF_ST_BNB_CHOP_SAFE_PRESET },
];

let failed = false;
for (const v of variants) {
  console.log(`▸ ${v.name}`);
  for (const [wname, from, to] of WINDOWS) {
    const r = await runWindow(from, to, v.cfg);
    const t = TARGETS[wname];
    const ok = r.ret >= t.minRet && r.wr >= t.minWr;
    if (v.name.includes("MAX RETURN") && !ok) failed = true;
    console.log(
      `  ${wname.padEnd(6)} n=${String(r.n).padStart(2)} WR=${r.wr.toFixed(1).padStart(5)}% ret=${r.ret.toFixed(0).padStart(5)}% SL%=${r.slPct.toFixed(0).padStart(2)}% chopL=${r.chopLosses}/${r.totalLosses} ${ok ? "✓" : "✗"}`,
    );
  }
  console.log("");
}

if (failed) {
  console.error("PRODUCTION ACCEPTANCE FAILED");
  process.exit(1);
}
console.log("PRODUCTION ACCEPTANCE PASSED");
await closePool?.();
