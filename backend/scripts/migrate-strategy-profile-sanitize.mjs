#!/usr/bin/env node
/**
 * Re-sanitize existing strategy_versions.cfg_raw through profile allowlists.
 * Does NOT rewrite historical backtest_runs.config_snapshot rows.
 *
 * Usage:
 *   node scripts/migrate-strategy-profile-sanitize.mjs           # dry-run
 *   node scripts/migrate-strategy-profile-sanitize.mjs --apply   # write updates
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const apply = process.argv.includes("--apply");

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
const { sanitizeSignalBrainCfgRaw } = await import("../src/lib/strategySignalBrain.js");

await initPool({ info: () => {}, warn: console.warn, error: console.error });
const pool = getPool();
if (!pool) {
  console.error("NO_DB — start Docker Timescale on localhost:54333");
  process.exit(1);
}

function pickBot(raw) {
  if (!raw || typeof raw !== "object") return {};
  return raw.bot && typeof raw.bot === "object" ? raw.bot : raw;
}

function countKeys(obj) {
  return Object.keys(obj ?? {}).length;
}

const { rows } = await pool.query(
  `SELECT sv.id::text AS id, sv.version_number, s.name AS strategy_name,
          sv.cfg_raw
     FROM strategy_versions sv
     JOIN strategies s ON s.id = sv.strategy_id
    ORDER BY s.name, sv.version_number`,
);

let totalRemoved = 0;
let changed = 0;

for (const row of rows) {
  const raw = row.cfg_raw;
  const before = pickBot(raw);
  const sanitized = sanitizeSignalBrainCfgRaw(raw);
  const after = pickBot(sanitized);
  const removed = countKeys(before) - countKeys(after);
  const needsSlices = !raw?.byStrategy || typeof raw.byStrategy !== "object";
  if (removed <= 0 && !needsSlices) continue;
  changed++;
  totalRemoved += Math.max(0, removed);
  const manual = String(before.manualStrategy ?? "—");
  const sliceNote = needsSlices ? " +seed byStrategy" : "";
  console.log(
    `${apply ? "APPLY" : "DRY"}  ${row.strategy_name} v${row.version_number} (${manual})  keys ${countKeys(before)} → ${countKeys(after)}${removed > 0 ? `  (-${removed})` : ""}${sliceNote}`,
  );
  if (apply) {
    await pool.query(`UPDATE strategy_versions SET cfg_raw = $1::jsonb WHERE id = $2::uuid`, [
      JSON.stringify(sanitized),
      row.id,
    ]);
  }
}

console.log(`\n${changed} version(s) updated${totalRemoved > 0 ? `, ${totalRemoved} key(s) stripped` : ""}${apply ? " — applied" : " — dry-run only"}`);
await closePool();
