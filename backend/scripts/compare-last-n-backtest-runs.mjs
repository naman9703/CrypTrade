#!/usr/bin/env node
/** Compare last N completed backtest runs — trades, returns, config diffs. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const N = Number(process.env.N || process.argv[2] || 4);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

function pickBot(snap) {
  if (!snap) return {};
  return snap.bot && typeof snap.bot === "object" ? snap.bot : snap;
}

const KEYS = [
  "manualStrategy",
  "intradayGateLiquidity",
  "intradayGateInstitutionalSr",
  "intradayGateSmcIct",
  "intradayLiqTp1Enabled",
  "intradayLiqTp2Enabled",
  "intradayLiqMinRr",
  "intradayLiqMaxHoldBars",
  "intradayLiqMinSweepExtensionPct",
  "intradayLiqMinReclaimBodyRatio",
  "intradayLiqOnePickPerDay",
  "intradayLiqMaxTradesPerSidePerDay",
  "srIntradayMaxTradesPerDay",
  "srIntradayMinBarGap",
  "supertrendFuturesUseFixedSl",
  "supertrendFuturesFixedSlPct",
  "riskPerTrade",
  "timeframe",
];

const q = await pool.query(
  `SELECT br.id::text, br.created_at, br.symbol, br.timeframe,
          br.start_date, br.end_date, br.initial_capital,
          br.config_source, br.bot_instance_id::text AS instance_id,
          br.metrics, br.total_trades,
          s.name AS strategy_name,
          br.config_snapshot
     FROM backtest_runs br
     JOIN strategy_versions sv ON sv.id = br.strategy_version_id
     JOIN strategies s ON s.id = sv.strategy_id
    WHERE br.status = 'done'
    ORDER BY br.created_at DESC
    LIMIT $1`,
  [N],
);

const runs = q.rows;
console.log(`\n=== Last ${runs.length} completed backtest runs ===\n`);

for (const run of runs) {
  const m = run.metrics || {};
  const b = pickBot(run.config_snapshot);
  const from = new Date(run.start_date).toISOString().slice(0, 10);
  const to = new Date(run.end_date).toISOString().slice(0, 10);
  const days = (new Date(run.end_date) - new Date(run.start_date)) / 86400000;
  console.log(`${run.id.slice(0, 8)}  ${from}→${to} (${days.toFixed(0)}d)  ${run.symbol} ${run.timeframe}`);
  console.log(
    `  trades=${run.total_trades ?? m.totalTrades}  ret=${Number(m.totalReturnPct ?? 0).toFixed(2)}%  WR=${((m.winRate ?? 0) * 100).toFixed(1)}%  src=${run.config_source}`,
  );
  console.log(
    `  gates: liq=${b.intradayGateLiquidity} sr=${b.intradayGateInstitutionalSr} smc=${b.intradayGateSmcIct}  tp2=${b.intradayLiqTp2Enabled}  hold=${b.intradayLiqMaxHoldBars ?? b.intradaySmcMaxHoldBars}`,
  );
  const ex = await pool.query(
    `SELECT exit_reason, COUNT(*)::int n FROM backtest_trades WHERE backtest_run_id = $1 GROUP BY exit_reason ORDER BY n DESC`,
    [run.id],
  );
  console.log(`  exits: ${ex.rows.map((r) => `${r.exit_reason}:${r.n}`).join(" ")}`);
}

if (runs.length >= 2) {
  const ref = pickBot(runs[0].config_snapshot);
  console.log(`\n=== Config diff vs newest run (${runs[0].id.slice(0, 8)}) ===\n`);
  for (let i = 1; i < runs.length; i++) {
    const b = pickBot(runs[i].config_snapshot);
    const diffs = [];
    if (runs[i].symbol !== runs[0].symbol) diffs.push(`symbol ${runs[i].symbol}≠${runs[0].symbol}`);
    if (runs[i].timeframe !== runs[0].timeframe) diffs.push(`tf ${runs[i].timeframe}≠${runs[0].timeframe}`);
    const d0 = (new Date(runs[0].end_date) - new Date(runs[0].start_date)) / 86400000;
    const d1 = (new Date(runs[i].end_date) - new Date(runs[i].start_date)) / 86400000;
    if (Math.abs(d0 - d1) > 1) diffs.push(`window ${d1.toFixed(0)}d≠${d0.toFixed(0)}d`);
    for (const k of KEYS) {
      if (JSON.stringify(ref[k]) !== JSON.stringify(b[k])) {
        diffs.push(`${k}: ${JSON.stringify(b[k])} → ${JSON.stringify(ref[k])}`);
      }
    }
    console.log(`vs ${runs[i].id.slice(0, 8)} (${runs[i].total_trades} trades):`);
    console.log(diffs.length ? diffs.map((x) => `  • ${x}`).join("\n") : "  • (same symbol/tf/window + all keys match)");
  }
}

await closePool?.();
