/**
 * Cross-verification harness for the strategy-testing battery.
 * Seeds a backtest_strategy_tests row from a completed run and executes the
 * orchestrator in-process, printing the phase trail and final report summary.
 *
 * Usage: node scripts/verify-strategy-test.mjs [seedRunId]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const { initPool, closePool } = await import("../src/db/pool.js");
const { query } = await import("../src/db/query.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });

const seedArg = process.argv[2];
let seedRun;
if (seedArg) {
  const r = await query(`SELECT id, user_id, symbol, timeframe, engine_type FROM backtest_runs WHERE id = $1`, [seedArg]);
  seedRun = r.rows[0];
} else {
  const r = await query(
    `SELECT id, user_id, symbol, timeframe, engine_type
       FROM backtest_runs
      WHERE status = 'done' AND is_portfolio = false AND engine_type = 'SUPERTREND_ELITE'
      ORDER BY created_at DESC LIMIT 1`,
  );
  seedRun = r.rows[0];
}
if (!seedRun) {
  console.error("no completed seed run found");
  process.exit(1);
}
console.log(`Seed run: ${seedRun.id} ${seedRun.symbol} ${seedRun.timeframe} ${seedRun.engine_type}`);

const ins = await query(
  `INSERT INTO backtest_strategy_tests (user_id, seed_run_id, status) VALUES ($1, $2, 'queued') RETURNING id`,
  [seedRun.user_id, seedRun.id],
);
const testId = String(ins.rows[0].id);
console.log(`Test id: ${testId}`);

const { executeStrategyTest } = await import("../src/backtest/engine/strategyTest.js");
const t0 = Date.now();
let lastPhase = "";
await executeStrategyTest({
  testId,
  onProgress: (pct, phase) => {
    if (phase !== lastPhase) {
      console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] phase=${phase} pct=${pct.toFixed(1)}`);
      lastPhase = phase;
    }
  },
});

const res = await query(`SELECT * FROM backtest_strategy_tests WHERE id = $1`, [testId]);
const row = res.rows[0];
const report = typeof row.report === "object" ? row.report : JSON.parse(row.report);
const suggestion = row.suggestion && (typeof row.suggestion === "object" ? row.suggestion : JSON.parse(row.suggestion));

console.log("\n══════════ RESULT ══════════");
console.log("status:", row.status, "| grade:", row.grade, "| fidelity:", row.live_fidelity_score);
console.log("\nbaseline:", JSON.stringify(report.baseline.metrics));
console.log("reproducibility:", JSON.stringify(report.baseline.reproducibility));
console.log("\nwalk-forward: degradation", report.walkForward.degradationPct?.toFixed(1), "% | OOS sum", report.walkForward.oosSumReturnPct?.toFixed(2), "%");
for (const f of report.walkForward.folds) {
  console.log(`  fold ${f.fold}: train ${f.train.trades}tr exp $${f.train.expectancy.toFixed(2)} | test ${f.test.trades}tr ret ${f.test.returnPct.toFixed(2)}%`);
}
console.log("\nmonte carlo:", JSON.stringify(report.monteCarlo));
console.log("\ngates:", JSON.stringify(report.gates));
console.log("\nsensitivity: breakRate", report.sensitivity.breakRatePct?.toFixed(0), "% over", report.sensitivity.variantCount, "variants");
for (const p of report.sensitivity.params) {
  console.log(`  ${p.key} (base ${p.base}):`, p.variants.map((v) => `${v.delta}=${v.returnPct?.toFixed(1)}%${v.breaks ? " BREAKS" : ""}`).join(" "));
}
console.log("\ncost stress:");
for (const c of report.costStress) console.log(`  ${c.label}: ${c.returnPct?.toFixed(2)}% (Δ ${c.deltaVsBasePct?.toFixed(2)}%)`);
console.log("\nblack swan:");
for (const s of report.stress) {
  console.log(
    s.skipped
      ? `  ${s.label}: SKIPPED (${s.reason})`
      : `  ${s.label}: ret ${s.returnPct?.toFixed(2)}% dd ${s.maxDrawdownPct?.toFixed(1)}% survived=${s.survived}`,
  );
}
console.log("\nfidelity factors:");
for (const f of report.fidelity.factors) console.log(`  ${f.label}: ${f.score}/${f.max} — ${f.note}`);
console.log("\ngrade reasons:", report.grade.reasons);
if (suggestion) {
  console.log("\nsuggestion best:", JSON.stringify(suggestion.best));
  console.log("candidates:", suggestion.candidates.map((c) => `${c.label}: ${c.totalReturnPct.toFixed(1)}% dd${c.maxDrawdownPct.toFixed(1)} p5=${c.mcP5ReturnPct.toFixed(1)} safe=${c.withinLimits}`));
}
console.log(`\nTotal time: ${((Date.now() - t0) / 1000).toFixed(0)}s`);

await closePool();
process.exit(0);
