#!/usr/bin/env node
/**
 * Keep only the N most recent backtest_runs (by created_at); delete older rows.
 * Cascades: backtest_trades, backtest_equity_points, backtest_strategy_tests (seed_run_id).
 *
 * Usage (from backend/):
 *   node scripts/prune-backtest-runs.mjs
 *   node scripts/prune-backtest-runs.mjs 500
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const keepN = Math.max(1, Number(process.argv[2] ?? 500) || 500);

function dockerVmBytes() {
  try {
    const out = execSync(
      'du -sk "/Users/namanpaliwal/Library/Containers/com.docker.docker/Data/vms" 2>/dev/null | cut -f1',
      { encoding: "utf8" },
    ).trim();
    const kb = Number(out);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return "?";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

async function tableSizes(pool) {
  const r = await pool.query(`
    SELECT relname,
           pg_total_relation_size(c.oid) AS total_bytes
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND relname IN ('backtest_runs', 'backtest_trades', 'backtest_equity_points', 'backtest_strategy_tests')
     ORDER BY total_bytes DESC`);
  const map = {};
  let sum = 0;
  for (const row of r.rows) {
    map[row.relname] = Number(row.total_bytes);
    sum += Number(row.total_bytes);
  }
  map._total = sum;
  return map;
}

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

const dbSizeBefore = Number(
  (await pool.query(`SELECT pg_database_size(current_database()) AS b`)).rows[0].b,
);
const dockerBefore = dockerVmBytes();
const sizesBefore = await tableSizes(pool);

const totalRuns = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM backtest_runs`)).rows[0].n);
const toDelete = Math.max(0, totalRuns - keepN);

console.log(`\n=== Prune backtest runs (keep last ${keepN}) ===`);
console.log(`Total runs: ${totalRuns} → delete ${toDelete}`);
console.log(`DB size before: ${fmtBytes(dbSizeBefore)}`);
console.log(`Backtest tables before: ${fmtBytes(sizesBefore._total)}`);
console.log(`  runs: ${fmtBytes(sizesBefore.backtest_runs)} | trades: ${fmtBytes(sizesBefore.backtest_trades)} | equity: ${fmtBytes(sizesBefore.backtest_equity_points)}`);
if (dockerBefore != null) console.log(`Docker VM before: ${fmtBytes(dockerBefore)}`);

if (toDelete === 0) {
  console.log("\nNothing to delete.");
  await closePool();
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query("BEGIN");

  const keepRes = await client.query(
    `SELECT id FROM backtest_runs ORDER BY created_at DESC LIMIT $1`,
    [keepN],
  );
  const keepIds = keepRes.rows.map((r) => r.id);

  const opt = await client.query(
    `UPDATE backtest_optimizations
        SET best_run_id = NULL
      WHERE best_run_id IS NOT NULL
        AND NOT (best_run_id = ANY($1::uuid[]))`,
    [keepIds],
  );

  const shadow = await client.query(
    `UPDATE backtest_runs
        SET shadow_run_id = NULL
      WHERE shadow_run_id IS NOT NULL
        AND NOT (shadow_run_id = ANY($1::uuid[]))`,
    [keepIds],
  );

  const del = await client.query(
    `DELETE FROM backtest_runs
      WHERE NOT (id = ANY($1::uuid[]))`,
    [keepIds],
  );

  await client.query("COMMIT");

  console.log(`\nDeleted ${del.rowCount} backtest_runs`);
  console.log(`Cleared ${opt.rowCount} optimization best_run_id refs`);
  console.log(`Cleared ${shadow.rowCount} shadow_run_id refs`);
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
}

console.log("\nVacuuming backtest tables (reclaim space)...");
await pool.query("VACUUM (VERBOSE, ANALYZE) backtest_trades");
await pool.query("VACUUM (VERBOSE, ANALYZE) backtest_equity_points");
await pool.query("VACUUM (VERBOSE, ANALYZE) backtest_runs");
await pool.query("VACUUM (VERBOSE, ANALYZE) backtest_strategy_tests");

const dbSizeAfter = Number(
  (await pool.query(`SELECT pg_database_size(current_database()) AS b`)).rows[0].b,
);
const sizesAfter = await tableSizes(pool);
const dockerAfter = dockerVmBytes();
const remaining = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM backtest_runs`)).rows[0].n);

const dbFreed = dbSizeBefore - dbSizeAfter;
const tableFreed = sizesBefore._total - sizesAfter._total;
const dockerFreed = dockerBefore != null && dockerAfter != null ? dockerBefore - dockerAfter : null;

console.log(`\n=== After prune ===`);
console.log(`Runs remaining: ${remaining}`);
console.log(`DB size after: ${fmtBytes(dbSizeAfter)} (Δ ${fmtBytes(dbFreed)} freed)`);
console.log(`Backtest tables after: ${fmtBytes(sizesAfter._total)} (Δ ${fmtBytes(tableFreed)} freed)`);
if (dockerFreed != null) {
  console.log(`Docker VM after: ${fmtBytes(dockerAfter)} (Δ ${fmtBytes(dockerFreed)} freed)`);
} else {
  console.log(`Docker VM: could not measure`);
}

console.log(
  `\nNote: VACUUM reclaims space inside Postgres; Docker VM shrink may be smaller until FULL vacuum or volume trim.`,
);

await closePool();
