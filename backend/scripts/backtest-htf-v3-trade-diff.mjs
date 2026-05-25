#!/usr/bin/env node
/** Which of the 29 baseline trades change under v3 filters? */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });
const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();
const runId = (await pool.query(`SELECT id FROM backtest_runs WHERE status='done' ORDER BY completed_at DESC NULLS LAST LIMIT 2`)).rows[1].id;
const trades = (await pool.query(`SELECT trade_number, direction, net_pnl, entry_time FROM backtest_trades WHERE backtest_run_id=$1 ORDER BY trade_number`, [runId])).rows;
const { signal } = await import("../src/strategy/htfRsi.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const run = (await pool.query(`SELECT symbol, timeframe, start_date, end_date FROM backtest_runs WHERE id=$1`, [runId])).rows[0];
const candles = await readCandles(run.symbol, run.timeframe, new Date(run.start_date).getTime(), new Date(run.end_date).getTime());

for (const t of trades) {
  const i = candles.findIndex((c) => c.ts >= new Date(t.entry_time).getTime()) - 1;
  const s = signal({ candles: candles.slice(0, i + 1), timeframe: run.timeframe });
  const win = Number(t.net_pnl) > 0;
  const blocked = s.action === "HOLD" || (t.direction === "BUY" && s.action !== "BUY") || (t.direction === "SELL" && s.action !== "SELL");
  if (blocked) {
    console.log(`BLOCKED #${t.trade_number} ${win ? "WIN" : "LOSS"} ${t.direction} → ${s.reason}`);
  }
}
await closePool();
