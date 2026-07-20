#!/usr/bin/env node
/**
 * Delete audit_log rows older than N days, then VACUUM to reclaim space.
 *
 * Usage (from backend/):
 *   node scripts/prune-audit-log.mjs
 *   node scripts/prune-audit-log.mjs 30
 *   node scripts/prune-audit-log.mjs 30 --full   # VACUUM FULL (more reclaim, needs spare disk)
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const daysArg = process.argv.find((a) => /^\d+$/.test(a));
const keepDays = Math.max(1, Number(daysArg ?? 30) || 30);
const useFull = process.argv.includes("--full");
const batchSize = 50_000;

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

async function auditStats(pool) {
  const sizeQ = await pool.query(`
    SELECT pg_total_relation_size('audit_log'::regclass) AS bytes`);
  const countQ = await pool.query(`SELECT COUNT(*)::bigint AS n FROM audit_log`);
  const oldQ = await pool.query(
    `SELECT COUNT(*)::bigint AS n FROM audit_log WHERE created_at < NOW() - ($1::text || ' days')::interval`,
    [String(keepDays)],
  );
  const byTable = await pool.query(`
    SELECT table_name, COUNT(*)::bigint AS n
      FROM audit_log
     WHERE created_at < NOW() - ($1::text || ' days')::interval
     GROUP BY table_name
     ORDER BY n DESC
     LIMIT 12`,
    [String(keepDays)],
  );
  const rangeQ = await pool.query(`
    SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest FROM audit_log`);
  return {
    bytes: Number(sizeQ.rows[0].bytes),
    total: Number(countQ.rows[0].n),
    toDelete: Number(oldQ.rows[0].n),
    byTable: byTable.rows,
    oldest: rangeQ.rows[0].oldest,
    newest: rangeQ.rows[0].newest,
  };
}

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

const dbSizeBefore = Number(
  (await pool.query(`SELECT pg_database_size(current_database()) AS b`)).rows[0].b,
);
const dockerBefore = dockerVmBytes();
const before = await auditStats(pool);

console.log(`\n=== Prune audit_log (keep last ${keepDays} days) ===`);
console.log(`audit_log size before: ${fmtBytes(before.bytes)}`);
console.log(`Rows: ${before.total.toLocaleString()} | delete: ${before.toDelete.toLocaleString()}`);
console.log(`Range: ${before.oldest} → ${before.newest}`);
console.log(`DB size before: ${fmtBytes(dbSizeBefore)}`);
if (dockerBefore != null) console.log(`Docker VM before: ${fmtBytes(dockerBefore)}`);
if (before.byTable.length) {
  console.log(`\nTop tables in rows to delete:`);
  for (const r of before.byTable) {
    console.log(`  ${String(r.table_name).padEnd(28)} ${Number(r.n).toLocaleString()}`);
  }
}

if (before.toDelete === 0) {
  console.log("\nNothing older than retention window.");
  await closePool();
  process.exit(0);
}

const cutoff = new Date();
cutoff.setDate(cutoff.getDate() - keepDays);
console.log(`\nDeleting rows with created_at < ${cutoff.toISOString()} (batch ${batchSize})...`);

let deleted = 0;
let batch = 0;
for (;;) {
  const res = await pool.query(
    `DELETE FROM audit_log
      WHERE id IN (
        SELECT id FROM audit_log
         WHERE created_at < NOW() - ($1::text || ' days')::interval
         LIMIT $2
      )`,
    [String(keepDays), batchSize],
  );
  const n = res.rowCount ?? 0;
  deleted += n;
  batch += 1;
  if (batch % 10 === 0 || n === 0) {
    process.stdout.write(`  batch ${batch}: deleted ${deleted.toLocaleString()} total\r`);
  }
  if (n < batchSize) break;
}
console.log(`\nDeleted ${deleted.toLocaleString()} audit_log rows`);

console.log(`\nVacuuming audit_log (${useFull ? "FULL" : "standard"})...`);
try {
  if (useFull) {
    execSync(
      `echo "SET maintenance_work_mem = '32MB'; VACUUM FULL audit_log; ANALYZE audit_log;" | docker exec -i trading-timescale-1 psql -U postgres -d trading`,
      { stdio: "inherit", encoding: "utf8" },
    );
  } else {
    execSync(
      `echo "SET maintenance_work_mem = '32MB'; VACUUM audit_log; ANALYZE audit_log;" | docker exec -i trading-timescale-1 psql -U postgres -d trading`,
      { stdio: "inherit", encoding: "utf8" },
    );
  }
} catch (e) {
  console.warn(`\nVACUUM failed (${e?.message ?? e}). Rows deleted; run manually when Docker has headroom:`);
  console.warn(`  echo "SET maintenance_work_mem = '32MB'; VACUUM audit_log;" | docker exec -i trading-timescale-1 psql -U postgres -d trading`);
}

const dbSizeAfter = Number(
  (await pool.query(`SELECT pg_database_size(current_database()) AS b`)).rows[0].b,
);
const after = await auditStats(pool);
const dockerAfter = dockerVmBytes();

console.log(`\n=== After prune ===`);
console.log(`audit_log size after: ${fmtBytes(after.bytes)} (Δ ${fmtBytes(before.bytes - after.bytes)} freed)`);
console.log(`Rows remaining: ${after.total.toLocaleString()}`);
console.log(`Range: ${after.oldest} → ${after.newest}`);
console.log(`DB size after: ${fmtBytes(dbSizeAfter)} (Δ ${fmtBytes(dbSizeBefore - dbSizeAfter)} freed)`);
if (dockerBefore != null && dockerAfter != null) {
  console.log(`Docker VM after: ${fmtBytes(dockerAfter)} (Δ ${fmtBytes(dockerBefore - dockerAfter)} freed)`);
}
if (!useFull && before.bytes - after.bytes < 1024 ** 2) {
  console.log(`\nTip: little space reclaimed — re-run with --full when ≥5 GB host disk free.`);
}

await closePool();
