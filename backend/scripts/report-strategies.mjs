#!/usr/bin/env node
/**
 * Report strategy / strategy_versions counts and mode_id gaps (run after db:migrate).
 * Usage: node scripts/report-strategies.mjs
 */
import "dotenv/config";
import { initPool, getPool } from "../src/db/pool.js";
import { query } from "../src/db/query.js";

async function main() {
  await initPool();
  if (!getPool()) {
    console.error("DATABASE_URL not set or pool failed — cannot query.");
    process.exit(1);
  }
  const summary = await query(`
    SELECT
      COUNT(*)::int AS strategies,
      COUNT(*) FILTER (WHERE mode_id IS NULL)::int AS strategies_null_mode,
      (SELECT COUNT(*)::int FROM strategy_versions) AS versions
    FROM strategies
  `);
  console.log("strategies table:", summary.rows[0]);

  const byMode = await query(`
    SELECT tm.slug,
           COUNT(s.id)::int AS strategies,
           (SELECT COUNT(*)::int
            FROM strategy_versions sv
            JOIN strategies s2 ON s2.id = sv.strategy_id
            WHERE s2.mode_id = tm.id AND s2.is_archived = false) AS versions
    FROM trading_modes tm
    LEFT JOIN strategies s ON s.mode_id = tm.id AND s.is_archived = false
    GROUP BY tm.id, tm.slug
    ORDER BY tm.id
  `);
  console.log("by mode (non-archived strategies + version rows for those strategies):");
  for (const r of byMode.rows) console.log(" ", r.slug, r);

  const orphans = await query(`
    SELECT s.id, s.name, s.mode_id, s.tags
    FROM strategies s
    WHERE s.is_archived = false
      AND NOT EXISTS (SELECT 1 FROM strategy_versions sv WHERE sv.strategy_id = s.id)
    LIMIT 20
  `);
  if (orphans.rows.length) {
    console.log("strategies with NO versions (max 20):", orphans.rows.length);
    for (const r of orphans.rows) console.log(" ", r.id, r.name, "tags=", r.tags);
  } else {
    console.log("strategies with NO versions: 0");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
