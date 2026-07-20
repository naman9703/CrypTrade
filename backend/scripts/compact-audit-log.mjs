#!/usr/bin/env node
/**
 * Rebuild audit_log: batched copy → drop bloated heap → rename.
 * Usage: node scripts/compact-audit-log.mjs
 */
import { execSync } from "child_process";

const BATCH = 25_000;

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

function dockerVmBytes() {
  try {
    const kb = Number(
      execSync(
        'du -sk "/Users/namanpaliwal/Library/Containers/com.docker.docker/Data/vms" 2>/dev/null | cut -f1',
        { encoding: "utf8" },
      ).trim(),
    );
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

function psqlScalar(sql) {
  const out = execSync(
    `docker exec trading-timescale-1 psql -U postgres -d trading -t -A -c "${sql.replace(/"/g, '\\"')}"`,
    { encoding: "utf8", stdio: "pipe" },
  ).trim();
  return out.split("\n").filter(Boolean)[0];
}

function psql(sql) {
  execSync(`docker exec trading-timescale-1 psql -U postgres -d trading -v ON_ERROR_STOP=1 -c "${sql.replace(/"/g, '\\"')}"`, {
    stdio: "inherit",
    encoding: "utf8",
  });
}

async function waitDb(maxSec = 120) {
  for (let i = 0; i < maxSec; i += 3) {
    try {
      psqlScalar("SELECT 1");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error("Timescale not ready");
}

await waitDb();

const beforeAudit = Number(psqlScalar("SELECT pg_total_relation_size('audit_log');"));
const beforeDb = Number(psqlScalar("SELECT pg_database_size('trading');"));
const beforeRows = Number(psqlScalar("SELECT COUNT(*) FROM audit_log;"));
const dockerBefore = dockerVmBytes();

console.log(`\n=== Compact audit_log (batched) ===`);
console.log(`Before: ${fmtBytes(beforeAudit)} | ${beforeRows.toLocaleString()} rows | DB ${fmtBytes(beforeDb)}`);
if (dockerBefore != null) console.log(`Docker VM before: ${fmtBytes(dockerBefore)}`);

const compactExists = psqlScalar("SELECT to_regclass('public.audit_log_compact') IS NOT NULL;");
if (compactExists === "t") {
  const compactRows = Number(psqlScalar("SELECT COUNT(*) FROM audit_log_compact;"));
  console.log(`Resuming: audit_log_compact already has ${compactRows.toLocaleString()} rows`);
} else {
  psql("DROP TABLE IF EXISTS audit_log_compact;");
  psql("CREATE TABLE audit_log_compact (LIKE audit_log INCLUDING DEFAULTS INCLUDING CONSTRAINTS);");
}

const maxCopied = Number(psqlScalar("SELECT COALESCE(MAX(id), 0) FROM audit_log_compact;") || 0);
const maxId = Number(psqlScalar("SELECT COALESCE(MAX(id), 0) FROM audit_log;"));

console.log(`Copying ids ${maxCopied + 1} → ${maxId} in batches of ${BATCH}...`);

let cursor = maxCopied;
while (cursor < maxId) {
  const hi = Math.min(cursor + BATCH, maxId);
  psql(
    `INSERT INTO audit_log_compact SELECT * FROM audit_log WHERE id > ${cursor} AND id <= ${hi} ORDER BY id;`,
  );
  cursor = hi;
  const total = Number(psqlScalar("SELECT COUNT(*) FROM audit_log_compact;"));
  process.stdout.write(`  copied through id ${cursor} (${total.toLocaleString()} rows)\n`);
}

const compactTotal = Number(psqlScalar("SELECT COUNT(*) FROM audit_log_compact;"));
const origTotal = Number(psqlScalar("SELECT COUNT(*) FROM audit_log;"));
if (compactTotal !== origTotal) {
  console.warn(`WARN: row count mismatch compact=${compactTotal} orig=${origTotal}`);
}

console.log("\nDropping bloated audit_log and swapping...");
psql("ALTER SEQUENCE audit_log_id_seq OWNED BY audit_log_compact.id;");
psql("DROP TABLE audit_log;");
psql("ALTER TABLE audit_log_compact RENAME TO audit_log;");
psql("CREATE INDEX IF NOT EXISTS idx_audit_table_row ON audit_log (table_name, row_id, created_at DESC);");
psql("CREATE INDEX IF NOT EXISTS idx_audit_user_time ON audit_log (user_id, created_at DESC);");
psql("SELECT setval(pg_get_serial_sequence('audit_log', 'id'), COALESCE((SELECT MAX(id) FROM audit_log), 1));");
psql("ANALYZE audit_log;");

const afterAudit = Number(psqlScalar("SELECT pg_total_relation_size('audit_log');"));
const afterDb = Number(psqlScalar("SELECT pg_database_size('trading');"));
const afterRows = Number(psqlScalar("SELECT COUNT(*) FROM audit_log;"));
const dockerAfter = dockerVmBytes();

console.log(`\nAfter: ${fmtBytes(afterAudit)} | ${afterRows.toLocaleString()} rows | DB ${fmtBytes(afterDb)}`);
console.log(`audit_log freed: ${fmtBytes(beforeAudit - afterAudit)}`);
console.log(`DB freed: ${fmtBytes(beforeDb - afterDb)}`);
if (dockerBefore != null && dockerAfter != null) {
  console.log(`Docker VM after: ${fmtBytes(dockerAfter)} (Δ ${fmtBytes(dockerBefore - dockerAfter)} freed)`);
}
