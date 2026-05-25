#!/usr/bin/env node
/** Calibrate filter thresholds: wins vs losses RSI + HTF sep. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();
const runs = await pool.query(
  `SELECT id FROM backtest_runs WHERE status='done' ORDER BY completed_at DESC NULLS LAST LIMIT 2`,
);
const runId = runs.rows[1].id;
const trades = (
  await pool.query(`SELECT trade_number, direction, net_pnl, entry_time FROM backtest_trades WHERE backtest_run_id=$1`, [runId])
).rows;

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const run = (await pool.query(`SELECT start_date, end_date, symbol, timeframe FROM backtest_runs WHERE id=$1`, [runId])).rows[0];
const candles = await readCandles(run.symbol, run.timeframe, new Date(run.start_date).getTime(), new Date(run.end_date).getTime());
const ind = await import("../src/strategy/indicators.js");
const { ema, rsi: computeRsi } = ind;
const hourly = [];
for (let i = 0; i + 3 < candles.length; i += 4) hourly.push({ close: candles[i + 3].close });
const hEma21 = ema(hourly.map((c) => c.close), 21);
const hEma50 = ema(hourly.map((c) => c.close), 50);
const rsiSeries = computeRsi(candles.map((c) => c.close), 14);

function ctx(entryTime) {
  const t = new Date(entryTime).getTime();
  let i = candles.findIndex((c) => c.ts >= t) - 1;
  if (i < 80) return null;
  const hi = Math.floor(i / 4);
  const bar = candles[i];
  const prev = candles[i - 1];
  return {
    rsi: rsiSeries[i],
    rsiPrev: rsiSeries[i - 1],
    sep: (Math.abs(hEma21[hi] - hEma50[hi]) / hEma50[hi]) * 100,
    barOk: bar.close >= bar.open,
    prevBarOk: prev.close >= prev.open,
    dir: trades.find((x) => x.entry_time === entryTime)?.direction,
  };
}

const wins = trades.filter((t) => Number(t.net_pnl) > 0);
const losses = trades.filter((t) => Number(t.net_pnl) < 0);
for (const label of ["WINS", "LOSSES"]) {
  const set = label === "WINS" ? wins : losses;
  console.log(`\n${label} (${set.length}):`);
  for (const t of set) {
    const c = ctx(t.entry_time);
    if (!c) continue;
    console.log(`  #${t.trade_number} ${t.direction} RSI=${c.rsi.toFixed(1)} sep=${c.sep.toFixed(3)}%`);
  }
  const rsis = set.map((t) => ctx(t.entry_time)?.rsi).filter(Boolean);
  const seps = set.map((t) => ctx(t.entry_time)?.sep).filter(Boolean);
  console.log(`  RSI range: ${Math.min(...rsis).toFixed(1)} - ${Math.max(...rsis).toFixed(1)}`);
  console.log(`  HTF sep range: ${Math.min(...seps).toFixed(3)}% - ${Math.max(...seps).toFixed(3)}%`);
}

await closePool();
