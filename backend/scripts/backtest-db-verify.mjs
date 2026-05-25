#!/usr/bin/env node
/**
 * Verify a real backtest run in Postgres:
 *   - sum(trade net_pnl) vs (final_capital - initial_capital)
 *   - trade count vs backtest_runs.total_trades
 *   - sample entry/exit timestamps exist as OHLC bar opens (data alignment)
 *
 * Usage:
 *   cd backend && node scripts/backtest-db-verify.mjs
 *   node scripts/backtest-db-verify.mjs --run-id <uuid>
 *
 * Requires DATABASE_URL (or DB_*) in .env — same as the API worker.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

function arg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}

async function main() {
  const { initPool, closePool, getPool } = await import("../src/db/pool.js");
  await initPool({ info: () => {}, warn: console.warn, error: console.error });
  const pool = getPool();
  if (!pool) {
    console.error("No database pool — set DATABASE_URL in backend/.env");
    process.exit(2);
  }

  const runIdArg = arg("run-id");

  let run;
  if (runIdArg) {
    const r = await pool.query(
      `SELECT id, symbol, timeframe, start_date, end_date, initial_capital, final_capital,
              total_trades, total_pnl_usdt, status, created_at, metrics, data_coverage_pct
         FROM backtest_runs WHERE id = $1`,
      [runIdArg],
    );
    run = r.rows[0];
    if (!run) {
      console.error(`Run not found: ${runIdArg}`);
      await closePool();
      process.exit(1);
    }
  } else {
    const r = await pool.query(
      `SELECT id, symbol, timeframe, start_date, end_date, initial_capital, final_capital,
              total_trades, total_pnl_usdt, status, created_at, metrics, data_coverage_pct
         FROM backtest_runs
        WHERE status = 'done' AND final_capital IS NOT NULL
        ORDER BY completed_at DESC NULLS LAST, created_at DESC
        LIMIT 1`,
    );
    run = r.rows[0];
    if (!run) {
      console.error("No completed backtest runs in database.");
      await closePool();
      process.exit(2);
    }
  }

  const agg = await pool.query(
    `SELECT COUNT(*)::int AS n,
            COALESCE(SUM(net_pnl), 0)::float8 AS sum_net
       FROM backtest_trades
      WHERE backtest_run_id = $1`,
    [run.id],
  );
  const { n: tradeCount, sum_net: sumNet } = agg.rows[0];

  const initial = Number(run.initial_capital);
  const final = Number(run.final_capital);
  const eqDelta = final - initial;
  const pnlDiff = Math.abs(sumNet - eqDelta);
  const tol = Math.max(1e-4, Math.abs(eqDelta) * 1e-9 + 0.01);
  const pnlOk = pnlDiff < tol;

  const countOk = Number(run.total_trades) === Number(tradeCount);

  console.log("=== Backtest DB verification ===\n");
  console.log(`Run id:        ${run.id}`);
  console.log(`Symbol / TF:   ${run.symbol} · ${run.timeframe}`);
  console.log(`Window:        ${run.start_date?.toISOString?.() ?? run.start_date} → ${run.end_date?.toISOString?.() ?? run.end_date}`);
  console.log(`Coverage:      ${run.data_coverage_pct != null ? `${Number(run.data_coverage_pct).toFixed(2)}%` : "—"}`);
  console.log(`Initial → Final: ${initial} → ${final}  (Δ ${eqDelta.toFixed(6)} USDT)`);
  console.log(`Stored total_pnl_usdt (run row): ${run.total_pnl_usdt}`);
  console.log("");
  console.log(`Trades in DB:     ${tradeCount}`);
  console.log(`total_trades col: ${run.total_trades}`);
  console.log(`Count match:      ${countOk ? "✓" : "✗"}`);
  console.log("");
  console.log(`SUM(net_pnl):     ${sumNet.toFixed(8)}`);
  console.log(`final − initial:  ${eqDelta.toFixed(8)}`);
  console.log(`PnL reconcile:    ${pnlOk ? "✓" : "✗"}  (|diff|=${pnlDiff.toExponential(3)}, tol≈${tol.toExponential(3)})`);

  // OHLC alignment: entry/exit should land on bar open_time for this symbol+timeframe
  const sample = await pool.query(
    `SELECT trade_number, entry_time, exit_time, entry_price, direction
       FROM backtest_trades
      WHERE backtest_run_id = $1
      ORDER BY trade_number
      LIMIT 5`,
    [run.id],
  );
  const sampleLast = await pool.query(
    `SELECT trade_number, entry_time, exit_time
       FROM backtest_trades
      WHERE backtest_run_id = $1
      ORDER BY trade_number DESC
      LIMIT 3`,
    [run.id],
  );
  const checkRows = [...sample.rows];
  for (const row of sampleLast.rows) {
    if (!checkRows.find((r) => r.trade_number === row.trade_number)) checkRows.push(row);
  }

  console.log("\n=== OHLC bar alignment (sample) ===");
  let candleHits = 0;
  let candleChecks = 0;
  for (const t of checkRows) {
    for (const [label, ts] of [
      ["entry", t.entry_time],
      ["exit", t.exit_time],
    ]) {
      if (!ts) continue;
      candleChecks++;
      const c = await pool.query(
        `SELECT 1 FROM ohlcv_candles
          WHERE symbol = $1 AND timeframe = $2 AND open_time = $3::timestamptz
          LIMIT 1`,
        [run.symbol, run.timeframe, ts],
      );
      const ok = (c.rowCount ?? 0) > 0;
      if (ok) candleHits++;
      console.log(
        `  trade #${t.trade_number} ${label} ${ts.toISOString?.() ?? ts}  → candle row: ${ok ? "✓" : "✗"}`,
      );
    }
  }
  if (candleChecks === 0) {
    console.log("  (no trades to check)");
  } else {
    console.log(`  Matched ${candleHits}/${candleChecks} timestamps to ohlcv_candles.open_time`);
  }

  await closePool();

  if (!pnlOk || !countOk) {
    console.error("\nVerification failed — see ✗ above.");
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
