#!/usr/bin/env node
/** Re-simulate the last two SR_INTRADAY instance runs from frozen snapshots. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

function pickBot(snap) {
  if (!snap) return {};
  return snap.bot && typeof snap.bot === "object" ? snap.bot : snap;
}

const q = await pool.query(
  `SELECT id::text, created_at, symbol, timeframe, start_date, end_date, initial_capital,
          config_snapshot, metrics
     FROM backtest_runs
    WHERE status = 'done' AND symbol = 'BNBUSDT' AND timeframe = '15m'
    ORDER BY created_at DESC
    LIMIT 2`,
);

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { materializeIntradayEngineCfgSync } = await import("../src/strategy/presets/srIntradayOptimized.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { applyInstanceOperationalToBot } = await import("../src/lib/strategyInstanceSplit.js");

for (const run of q.rows.reverse()) {
  const fromMs = new Date(run.start_date).getTime();
  const toMs = new Date(run.end_date).getTime();
  const candles = await readCandles(run.symbol, run.timeframe, fromMs, toMs);
  const funding = await readFundingRates(run.symbol, fromMs, toMs).catch(() => []);
  let cfg = pickBot(run.config_snapshot);
  cfg.symbol = run.symbol;
  cfg.timeframe = run.timeframe;
  if (!cfg._intradayEngineMaterialized) {
    cfg = materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
  }
  const adapters = await buildBacktestAdapters({
    strategyKey: "SR_INTRADAY",
    cfg,
    symbol: run.symbol,
    tf: run.timeframe,
    candles,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: Number(run.initial_capital),
    timeframe: run.timeframe,
    adapters,
    symbol: run.symbol,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: run.timeframe,
    startingEquity: Number(run.initial_capital),
  });
  const stored = run.metrics || {};
  console.log("─".repeat(60));
  console.log(run.id.slice(0, 8), run.created_at);
  console.log("  snapshot tp2:", cfg.intradayLiqTp2Enabled, " reclaim:", cfg.intradayLiqMinReclaimBodyRatio);
  console.log(
    `  stored:  ret=${stored.totalReturnPct?.toFixed?.(2) ?? stored.totalReturnPct}% n=${stored.totalTrades}`,
  );
  console.log(
    `  repro:   ret=${m.totalReturnPct?.toFixed?.(2)}% n=${m.totalTrades} wr=${((m.winRate || 0) * 100).toFixed(1)}%`,
  );
}

await closePool?.();
