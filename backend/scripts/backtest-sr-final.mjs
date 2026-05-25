#!/usr/bin/env node
/** Quick SR_INTRADAY validation — session S/R preset. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const symbol = process.argv[2] || "BNBUSDT";
const tf = process.argv[3] || "15m";
const fromMs = new Date("2026-01-01").getTime();
const toMs = new Date("2026-05-18").getTime();
const days = (toMs - fromMs) / 86_400_000;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { selectDailyTopPicks } = await import("../src/strategy/srIntraday.js");
const { SR_INTRADAY_SNIPER_BASE, SR_INTRADAY_TRAIL_15M } = await import(
  "../src/strategy/presets/srIntradayOptimized.js"
);

await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
const candles = await readCandles(symbol, tf, fromMs, toMs);

async function run(label, base) {
  const cfg = {
    ...base,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    slippagePct: 0.0005,
  };
  const pick = selectDailyTopPicks(candles, {
    maxTradesPerDay: cfg.srIntradayMaxTradesPerDay ?? 3,
    minScore: cfg.srIntradayMinScore ?? 5,
    minBarGap: cfg.srIntradayMinBarGap ?? 2,
    sweepPct: cfg.srIntradaySweepPct ?? 0.0008,
    requireSessionLevel: cfg.srIntradayRequireSessionLevel !== false,
    sessionNearPct: cfg.srIntradaySessionNearPct ?? 0.0018,
  });
  const adapters = await buildBacktestAdapters({
    strategyKey: "SR_INTRADAY",
    cfg,
    symbol,
    tf,
    candles,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: tf,
    adapters,
    symbol,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf,
    startingEquity: 100,
  });
  console.log({
    label,
    symbol,
    tf,
    cands: pick.candidateCount,
    picks: pick.pickedCount,
    pickPerDay: +(pick.pickedCount / days).toFixed(2),
    n: m.totalTrades,
    tpd: +((m.totalTrades ?? 0) / days).toFixed(2),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    ret: +(m.totalReturnPct ?? 0).toFixed(1),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(1),
  });
}

await run("scalp", SR_INTRADAY_SNIPER_BASE);
await run("trail", SR_INTRADAY_TRAIL_15M);
await closePool?.();
