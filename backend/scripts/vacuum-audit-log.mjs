#!/usr/bin/env node
/** Reclaim audit_log disk after large deletes. Uses low work_mem for Docker shm_size 256mb. */
import { execSync } from "child_process";

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

function query(sql) {
  return execSync(`docker exec trading-timescale-1 psql -U postgres -d trading -t -A -c "${sql.replace(/"/g, '\\"')}"`, {
    encoding: "utf8",
  }).trim();
}

const beforeAudit = Number(query("SELECT pg_total_relation_size('audit_log');"));
const beforeDb = Number(query("SELECT pg_database_size('trading');"));
const beforeRows = Number(query("SELECT COUNT(*) FROM audit_log;"));
const dockerBefore = dockerVmBytes();

console.log(`audit_log before: ${fmtBytes(beforeAudit)} | ${beforeRows.toLocaleString()} rows`);
console.log(`DB before: ${fmtBytes(beforeDb)}`);
if (dockerBefore != null) console.log(`Docker VM before: ${fmtBytes(dockerBefore)}`);

console.log("\nVACUUM audit_log (maintenance_work_mem=32MB)...");
execSync(
  `echo "SET maintenance_work_mem = '32MB'; VACUUM audit_log; ANALYZE audit_log;" | docker exec -i trading-timescale-1 psql -U postgres -d trading`,
  { stdio: "inherit" },
);

const afterAudit = Number(query("SELECT pg_total_relation_size('audit_log');"));
const afterDb = Number(query("SELECT pg_database_size('trading');"));
const afterRows = Number(query("SELECT COUNT(*) FROM audit_log;"));
const dockerAfter = dockerVmBytes();

console.log(`\naudit_log after: ${fmtBytes(afterAudit)} (Δ ${fmtBytes(beforeAudit - afterAudit)} freed)`);
console.log(`Rows: ${afterRows.toLocaleString()}`);
console.log(`DB after: ${fmtBytes(afterDb)} (Δ ${fmtBytes(beforeDb - afterDb)} freed)`);
if (dockerBefore != null && dockerAfter != null) {
  console.log(`Docker VM after: ${fmtBytes(dockerAfter)} (Δ ${fmtBytes(dockerBefore - dockerAfter)} freed)`);
}
