#!/usr/bin/env node
/** Walk-forward on a completed DB run (replays worker split logic). */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const RUN_ID = process.argv[2] || "b1a59da2-741e-4e79-92be-02ad8addcd1a";
const trainPct = Number(process.argv.find((a) => a.startsWith("--train="))?.split("=")[1] ?? 0.7);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

const run = (await pool.query(`SELECT * FROM backtest_runs WHERE id = $1`, [RUN_ID])).rows[0];
if (!run) throw new Error("run not found");

const tradeRows = (
  await pool.query(`SELECT * FROM backtest_trades WHERE backtest_run_id = $1 ORDER BY trade_number`, [RUN_ID])
).rows;
const eqRows = (
  await pool.query(`SELECT ts, equity, drawdown_pct FROM backtest_equity_points WHERE run_id = $1 ORDER BY ts`, [RUN_ID])
).rows;

const fromMs = new Date(run.start_date).getTime();
const toMs = new Date(run.end_date).getTime();
const starting = Number(run.initial_capital);
const tf = run.timeframe;

const candles = await readCandles("BTCUSDT", tf, fromMs, toMs, { market: "futures" });
const splitTs = Number(candles[Math.floor(candles.length * trainPct)]?.ts);
const splitDate = new Date(splitTs).toISOString().slice(0, 10);

const trades = tradeRows.map((r) => ({
  tradeNumber: Number(r.trade_number),
  symbol: r.symbol,
  direction: r.direction,
  entryTs: new Date(r.entry_time).getTime(),
  exitTs: new Date(r.exit_time).getTime(),
  entryPrice: Number(r.entry_price),
  exitPrice: Number(r.exit_price),
  qty: Number(r.quantity),
  netPnl: Number(r.net_pnl),
  grossPnl: Number(r.gross_pnl ?? 0),
  fees: Number(r.fees_usdt ?? 0),
  exitReason: r.exit_reason,
}));

const curve = eqRows.map((r) => ({
  ts: new Date(r.ts).getTime(),
  equity: Number(r.equity),
  drawdownPct: Number(r.drawdown_pct ?? 0),
}));

const full = computeAllMetrics({ trades, equityCurve: curve, tf, startingEquity: starting });
const trainTrades = trades.filter((t) => t.exitTs <= splitTs);
const testTrades = trades.filter((t) => t.exitTs > splitTs);
const trainCurve = curve.filter((p) => p.ts <= splitTs);
const testCurve = curve.filter((p) => p.ts > splitTs);
const startTest = trainCurve.length ? trainCurve[trainCurve.length - 1].equity : starting;

const train = computeAllMetrics({
  trades: trainTrades,
  equityCurve: trainCurve,
  tf,
  startingEquity: starting,
});
const test = computeAllMetrics({
  trades: testTrades,
  equityCurve: testCurve,
  tf,
  startingEquity: startTest,
});

function fmt(m, label) {
  return {
    label,
    trades: m.totalTrades,
    winRate: `${(m.winRate * 100).toFixed(0)}%`,
    returnPct: `${m.totalReturnPct.toFixed(0)}%`,
    maxDD: `${m.maxDrawdownPct.toFixed(1)}%`,
    sharpe: m.sharpe?.toFixed(1) ?? "—",
    expectancy: m.expectancy != null ? `$${m.expectancy.toFixed(0)}/trade` : "—",
  };
}

console.log(`=== Walk-forward on saved run ${RUN_ID.slice(0, 8)}… ===`);
console.log(`${run.symbol} | ${tf} | ${run.start_date?.toISOString?.().slice(0, 10)} → ${run.end_date?.toISOString?.().slice(0, 10)}`);
console.log(`Train ${(trainPct * 100).toFixed(0)}% — split ${splitDate}`);
console.log(`${trainTrades.length} train trades, ${testTrades.length} test trades (${trades.length} total)\n`);
console.table([fmt(full, "FULL (UI headline)"), fmt(train, "TRAIN"), fmt(test, "TEST")]);
console.log(`\nSharpe train → test: ${train.sharpe?.toFixed(1)} → ${test.sharpe?.toFixed(1)}`);
console.log(`Final equity (FULL): $${full.finalEquity?.toFixed(2)}`);

await closePool?.();
