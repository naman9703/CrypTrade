/**
 * Run trailing tick audit for a backtest run (CLI).
 * Usage: node scripts/run-trail-tick-audit.mjs <runId> [mode]
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const runId = process.argv[2];
const mode = process.argv[3] ?? "mark_1m_ohlc";

if (!runId) {
  console.error("Usage: node scripts/run-trail-tick-audit.mjs <runId> [mode]");
  process.exit(1);
}

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool(console);
const { query } = await import("../src/db/query.js");
const { runTrailTickAudit } = await import("../src/backtest/engine/trailTickAudit.js");

const { rows } = await query(`SELECT user_id FROM backtest_runs WHERE id = $1`, [runId]);
if (!rows[0]) {
  console.error("run not found:", runId);
  process.exit(1);
}

const userId = rows[0].user_id;
console.log(`Running trail tick audit run=${runId} mode=${mode} user=${userId}`);

const result = await runTrailTickAudit({ runId, userId, mode, force: true });
console.log(JSON.stringify({ verdict: result.verdict, sample: result.perTrade?.slice(0, 3) }, null, 2));
await closePool();
