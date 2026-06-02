#!/usr/bin/env node
/**
 * Diff two backtest runs — config snapshot + metrics + exit reasons.
 * Usage: node scripts/backtest-diff-runs.mjs [runIdA] [runIdB]
 * Omit IDs to compare the two most recent completed runs.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();
if (!pool) {
  console.error("No DB — set DATABASE_URL in backend/.env");
  process.exit(2);
}

const ids = process.argv.slice(2).filter(Boolean);
let runA;
let runB;
if (ids.length >= 2) {
  const rows = await pool.query(`SELECT * FROM backtest_runs WHERE id = ANY($1::uuid[])`, [ids.slice(0, 2)]);
  runA = rows.rows.find((r) => r.id === ids[0]);
  runB = rows.rows.find((r) => r.id === ids[1]);
} else {
  const rows = await pool.query(
    `SELECT * FROM backtest_runs WHERE status = 'done' ORDER BY created_at DESC LIMIT 2`,
  );
  runB = rows.rows[0];
  runA = rows.rows[1];
}

if (!runA || !runB) {
  console.error("Need two completed runs");
  process.exit(1);
}

function bot(cfg) {
  return cfg?.bot && typeof cfg.bot === "object" ? cfg.bot : cfg ?? {};
}

const KEYS = [
  "symbol",
  "timeframe",
  "manualStrategy",
  "marketMode",
  "config_source",
  "gate_mode",
  "engine_type",
  "data_coverage_pct",
  "supertrendFuturesUseFixedSl",
  "supertrendFuturesUseFixedTp",
  "supertrendFuturesFixedSlPct",
  "supertrendFuturesFixedTpPct",
  "intradayGateSmcIct",
  "intradayGateLiquidity",
  "intradayGateFib",
  "intradaySmcIctProfile",
  "intradaySmcRequireMss",
  "intradaySmcRequireRetrace",
  "intradaySmcRequireChoch",
  "_livePanelOverlayAt",
  "srIntradaySweepPct",
  "intradayAdaptiveBrackets",
];

function summarize(run) {
  const b = bot(run.config_snapshot);
  const out = {
    id: run.id,
    created_at: run.created_at,
    trades: run.total_trades,
    final: Number(run.final_capital),
    returnPct: run.metrics?.returnPct,
    wr: run.metrics?.winRatePct,
    coverage: run.data_coverage_pct,
  };
  for (const k of KEYS) {
    out[k] = k.startsWith("config_") || k === "gate_mode" || k === "engine_type" || k === "data_coverage_pct"
      ? run[k]
      : b[k];
  }
  return out;
}

async function exitBreakdown(runId) {
  const r = await pool.query(
    `SELECT exit_reason, count(*)::int c FROM backtest_trades WHERE backtest_run_id = $1 GROUP BY exit_reason ORDER BY c DESC`,
    [runId],
  );
  return Object.fromEntries(r.rows.map((x) => [x.exit_reason, x.c]));
}

const sa = summarize(runA);
const sb = summarize(runB);
const ea = await exitBreakdown(runA.id);
const eb = await exitBreakdown(runB.id);

const diffs = [];
for (const k of [...KEYS, "trades", "final", "returnPct", "wr", "coverage"]) {
  const va = sa[k];
  const vb = sb[k];
  if (JSON.stringify(va) !== JSON.stringify(vb)) {
    diffs.push({ key: k, a: va, b: vb });
  }
}

console.log(
  JSON.stringify(
    {
      runA: sa,
      runB: sb,
      configDiffs: diffs,
      exitReasonsA: ea,
      exitReasonsB: eb,
      note:
        diffs.length === 0
          ? "Snapshots match on tracked keys — diff likely from code changes between runs, candle sync, or worker re-materialization."
          : "Config snapshot differed at run creation (live panel overlay or saved strategy changed).",
    },
    null,
    2,
  ),
);

await closePool();
