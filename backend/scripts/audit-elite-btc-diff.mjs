#!/usr/bin/env node
/** Deep diff of BTCUSDT 1h SUPERTREND_ELITE backtest runs. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();
if (!pool) {
  console.error("NO_DB");
  process.exit(1);
}

function pickBot(snap) {
  if (!snap) return {};
  return snap.bot && typeof snap.bot === "object" ? snap.bot : snap;
}

function deepDiff(a, b, prefix = "") {
  const diffs = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of [...keys].sort()) {
    const pa = prefix ? `${prefix}.${k}` : k;
    const va = a?.[k];
    const vb = b?.[k];
    if (
      va &&
      typeof va === "object" &&
      !Array.isArray(va) &&
      vb &&
      typeof vb === "object" &&
      !Array.isArray(vb)
    ) {
      diffs.push(...deepDiff(va, vb, pa));
    } else if (JSON.stringify(va) !== JSON.stringify(vb)) {
      diffs.push({ key: pa, a: va, b: vb });
    }
  }
  return diffs;
}

const all = await pool.query(`
  SELECT br.id::text, br.created_at, br.total_trades, br.metrics, br.gate_mode,
         br.strategy_version_id::text AS vid, br.config_source,
         br.start_date, br.end_date, br.initial_capital, br.engine_type,
         br.cost_model, br.instance_operational_snapshot
  FROM backtest_runs br
  JOIN strategy_versions sv ON sv.id = br.strategy_version_id
  JOIN strategies s ON s.id = sv.strategy_id
  WHERE br.status = 'done'
    AND br.symbol = 'BTCUSDT'
    AND br.timeframe = '1h'
    AND br.is_portfolio IS NOT TRUE
    AND COALESCE(br.config_snapshot->'bot'->>'manualStrategy', br.config_snapshot->>'manualStrategy', '') IN ('SUPERTREND_ELITE', 'UNIFIED_ELITE')
  ORDER BY br.created_at DESC
  LIMIT 25`);

console.log(`\n=== ${all.rows.length} BTCUSDT 1h Elite runs ===\n`);
for (const r of all.rows) {
  const m = r.metrics || {};
  const from = new Date(r.start_date).toISOString().slice(0, 10);
  const to = new Date(r.end_date).toISOString().slice(0, 10);
  console.log(
    `${r.id.slice(0, 8)}  ${from}→${to}  trades=${r.total_trades ?? m.totalTrades}  ret=${Number(m.totalReturnPct || 0).toFixed(1)}%  dd=${Number(m.maxDrawdownPct || 0).toFixed(1)}%  gate=${r.gate_mode}  vid=${r.vid?.slice(0, 8)}`,
  );
}

const low =
  all.rows.find((r) => String(process.env.LOW_ID || "").startsWith(r.id.slice(0, 8))) ||
  all.rows.find((r) => (r.total_trades ?? r.metrics?.totalTrades) === 33 && Number(r.metrics?.totalReturnPct || 0).toFixed(1) === "58.1") ||
  all.rows.find((r) => (r.total_trades ?? r.metrics?.totalTrades) <= 40);
const high =
  all.rows.find((r) => String(process.env.HIGH_ID || "f954edd7").startsWith(r.id.slice(0, 8))) ||
  all.rows.find((r) => (r.total_trades ?? r.metrics?.totalTrades) >= 150);
if (!low || !high) {
  console.log("\nNeed both low- and high-trade runs to diff.");
  await closePool();
  process.exit(0);
}

const ids = [low.id, high.id];
const snaps = await pool.query(
  `SELECT id::text, created_at, config_snapshot, gate_mode, metrics, total_trades,
          start_date, end_date, initial_capital, cost_model, instance_operational_snapshot
     FROM backtest_runs WHERE id = ANY($1::uuid[])`,
  [ids],
);
const runs = snaps.rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
const [newRun, oldRun] = runs;

console.log(`\n=== Compare low-trade ${low.id.slice(0, 8)} (${low.total_trades}t) vs high-trade ${high.id.slice(0, 8)} (${high.total_trades}t) ===`);

const botNew = pickBot(newRun.config_snapshot);
const botOld = pickBot(oldRun.config_snapshot);
const diffs = deepDiff(botNew, botOld);
console.log(`\nconfig_snapshot.bot diffs: ${diffs.length}`);
for (const d of diffs) {
  console.log(`  ${d.key}: ${JSON.stringify(d.b)} → ${JSON.stringify(d.a)}`);
}

const ELITE = [
  "eliteStRequireHtf4hAlign",
  "eliteStRequireHtf1hEmaAlign",
  "eliteStMinAdx",
  "eliteStRequireAdxRising",
  "eliteStMinVolumeVsAvg",
  "eliteStRequireAtrExpansion",
  "eliteStLiqSweepEnabled",
  "eliteStAutoCalibrate",
  "eliteStHtf1hSepMode",
  "eliteStHtf1hMinSep",
  "trailingStopLossAuto",
  "futuresTrailingStopMode",
  "supertrendFuturesExitOnFlip",
  "supertrendFuturesUseFixedSl",
  "supertrendFuturesUseFixedTp",
  "supertrendFuturesFixedSlPct",
  "supertrendFuturesFixedTpPct",
  "supertrendPeriod",
  "supertrendMultiplier",
  "intelligenceGateEnabled",
  "signalStrengthGatesTrades",
  "supertrendMoveQualityGate",
  "marketDecision",
  "_engineVersion",
  "backtestPositionSizing",
];
console.log("\nElite knob table:");
for (const k of ELITE) {
  const vn = botNew[k];
  const vo = botOld[k];
  const mark = JSON.stringify(vn) === JSON.stringify(vo) ? " " : "*";
  console.log(` ${mark} ${k}: low=${JSON.stringify(vn)}  high=${JSON.stringify(vo)}`);
}

console.log("  gate_mode:", oldRun.gate_mode, "→", newRun.gate_mode);
console.log("  end_date:", new Date(oldRun.end_date).toISOString().slice(0, 10), "→", new Date(newRun.end_date).toISOString().slice(0, 10));
console.log("  initial_capital:", oldRun.initial_capital, "→", newRun.initial_capital);
console.log("  cost_model:", JSON.stringify(oldRun.cost_model), "→", JSON.stringify(newRun.cost_model));
console.log("  instance_ops:", JSON.stringify(oldRun.instance_operational_snapshot), "→", JSON.stringify(newRun.instance_operational_snapshot));

for (const [label, id] of [
  ["low", low.id],
  ["high", high.id],
]) {
  const ex = await pool.query(
    `SELECT exit_reason, COUNT(*)::int n FROM backtest_trades WHERE backtest_run_id=$1 GROUP BY exit_reason ORDER BY n DESC`,
    [id],
  );
  console.log(`  ${label} exits: ${ex.rows.map((r) => `${r.exit_reason}:${r.n}`).join(" ")}`);
}

// Re-simulate prepareEliteRunCfg on stored snapshots
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { prepareEliteRunCfg } = await import("../src/strategy/supertrendElite.js");
const fromMs = new Date(low.start_date).getTime();
const toMs = new Date(low.end_date).getTime();
const candles = await readCandles("BTCUSDT", "1h", fromMs, toMs, { market: "futures" });
console.log(`\nCandles loaded: ${candles.length}`);
for (const [label, bot] of [
  ["low-snap", botNew],
  ["high-snap", botOld],
]) {
  const prep = prepareEliteRunCfg({ ...bot, symbol: "BTCUSDT" }, "BTCUSDT", candles);
  console.log(`\nprepareEliteRunCfg(${label}):`);
  for (const k of ELITE) {
    if (JSON.stringify(prep[k]) !== JSON.stringify(bot[k])) {
      console.log(`  mutated ${k}: ${JSON.stringify(bot[k])} → ${JSON.stringify(prep[k])}`);
    }
  }
}

const sv = await pool.query(
  `SELECT id::text, created_at, cfg_raw FROM strategy_versions WHERE id::text LIKE '7e3b7938%'`,
);
const svBot = sv.rows[0]?.cfg_raw?.bot ?? sv.rows[0]?.cfg_raw ?? {};
console.log(`\n=== Current saved strategy_version 7e3b7938 (created ${sv.rows[0]?.created_at}) ===`);
console.log(`cfg_raw bot keys: ${Object.keys(svBot).length}, feed=${!!svBot.feed}, account=${!!svBot.account}`);
for (const k of ELITE) {
  console.log(`  ${k}: ${JSON.stringify(svBot[k])}`);
}

await closePool();
