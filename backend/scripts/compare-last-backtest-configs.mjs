#!/usr/bin/env node
/** Compare last N backtest runs: snapshot vs current strategy_version cfg_raw. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const N = Number(process.env.N || 2);
const filter = process.argv[2] || ""; // optional manualStrategy substring

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

function pickBot(raw) {
  if (!raw || typeof raw !== "object") return {};
  if (raw.bot && typeof raw.bot === "object") return raw.bot;
  return raw;
}

const keys = [
  "manualStrategy",
  "intradayGateLiquidity",
  "intradayGateInstitutionalSr",
  "intradayGateSession",
  "intradayLiqMinReclaimBodyRatio",
  "intradayLiqTp2Enabled",
  "intradayLiqTp1Enabled",
  "intradayLiqMinRr",
  "intradayLiqMinSweepExtensionPct",
  "intradaySmcMinRr",
  "supertrendFuturesFixedSlPct",
  "supertrendFuturesFixedTpPct",
  "trailingStopLossAuto",
  "riskPerTrade",
  "srIntradayCooldownBars",
  "srIntradayMaxTradesPerDay",
  "_intradayEngineMaterialized",
];

const q = await pool.query(
  `SELECT br.id::text, br.created_at, br.symbol, br.timeframe, br.status,
          br.config_source, br.bot_instance_id::text,
          br.metrics,
          sv.id::text AS sv_id, sv.version_number, sv.cfg_raw AS current_cfg_raw,
          sv.created_at AS sv_created_at,
          s.name AS strategy_name,
          br.config_snapshot
     FROM backtest_runs br
     JOIN strategy_versions sv ON sv.id = br.strategy_version_id
     JOIN strategies s ON s.id = sv.strategy_id
    WHERE br.status = 'done'
    ORDER BY br.created_at DESC
    LIMIT 30`,
);

const rows = q.rows.filter((r) => {
  const ms = String(pickBot(r.config_snapshot).manualStrategy || "");
  if (!filter) return true;
  return ms.toUpperCase().includes(filter.toUpperCase());
});

console.log(`\n=== Last ${N} comparable runs (filter="${filter || "*"}") ===\n`);

for (const run of rows.slice(0, N)) {
  const snap = pickBot(run.config_snapshot);
  const cur = pickBot(run.current_cfg_raw);
  const m = run.metrics && typeof run.metrics === "object" ? run.metrics : {};
  console.log("─".repeat(72));
  console.log(`run ${run.id.slice(0, 8)}…  ${run.created_at}  ${run.symbol} ${run.timeframe}  ${run.status}`);
  console.log(`strategy: ${run.strategy_name} v${run.version_number}  sv=${run.sv_id.slice(0, 8)}…`);
  console.log(`config_source: ${run.config_source}  instance: ${run.bot_instance_id || "—"}`);
  console.log(
    `result: return=${m.totalReturnPct ?? "?"}%  trades=${m.totalTrades ?? "?"}  WR=${m.winRate != null ? (m.winRate * 100).toFixed(1) : "?"}%`,
  );
  console.log(`sv.created_at: ${run.sv_created_at}`);
  console.log("\n  key                          snapshot          current_cfg_raw   match");
  let mismatches = 0;
  for (const k of keys) {
    const a = snap[k];
    const b = cur[k];
    const same = JSON.stringify(a) === JSON.stringify(b);
    if (!same) mismatches++;
    console.log(
      `  ${k.padEnd(28)} ${String(a ?? "—").slice(0, 16).padEnd(16)} ${String(b ?? "—").slice(0, 16).padEnd(16)} ${same ? "✓" : "DIFF"}`,
    );
  }
  console.log(`\n  mismatches vs live saved version: ${mismatches}`);
}

if (rows.length >= 2) {
  const a = pickBot(rows[0].config_snapshot);
  const b = pickBot(rows[1].config_snapshot);
  console.log("\n=== Snapshot diff between last 2 runs ===\n");
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      console.log(`  ${k}:  run1=${a[k]}  run2=${b[k]}`);
    }
  }
  const m0 = rows[0].metrics || {};
  const m1 = rows[1].metrics || {};
  if (m0.totalReturnPct === m1.totalReturnPct && m0.totalTrades === m1.totalTrades) {
    console.log("\n  ⚠ Identical metrics despite any snapshot diffs above.");
  }
}

await closePool?.();
