/**
 * Local parity check for the live-aware trailing simulator.
 *
 * Loads the latest `instance_merged` backtest run, replays its candles +
 * config through the in-process simulator, and prints exit-reason
 * distribution side by side with the persisted trade rows so you can see
 * the delta from the old buffer-based trail vs the new tier ladder.
 *
 * Usage: node backend/scripts/backtest-trail-parity-check.mjs [runId]
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
const { query } = await import("../src/db/query.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

await initPool({ info: () => {}, warn: () => {}, error: console.error });

try {
  const runId = process.argv[2] || (await pickLatestInstanceRun());
  if (!runId) {
    console.error("no run id available");
    process.exit(1);
  }
  await replay(runId);
} finally {
  await closePool();
}

async function pickLatestInstanceRun() {
  const r = await query(
    `SELECT id FROM backtest_runs
       WHERE status = 'done' AND config_source = 'instance_merged'
       ORDER BY created_at DESC LIMIT 1`,
  );
  return r.rows[0]?.id ?? null;
}

async function replay(runId) {
  const r = await query(
    `SELECT br.*, sv.cfg_raw AS strategy_cfg_raw
       FROM backtest_runs br
       JOIN strategy_versions sv ON sv.id = br.strategy_version_id
      WHERE br.id = $1`,
    [runId],
  );
  const run = r.rows[0];
  if (!run) throw new Error(`run ${runId} not found`);

  const symbol = String(run.symbol);
  const tf = String(run.timeframe);
  const fromMs = new Date(run.start_date).getTime();
  const toMs = new Date(run.end_date).getTime();
  const startingUsdt = Number(run.initial_capital);
  const cfg = pickBotCfg(run.config_snapshot, run.strategy_cfg_raw);
  const isFutures = String(cfg?.marketMode || cfg?.market || "").toUpperCase() === "FUTURES";
  const strategyKey = pickStrategyKey(cfg, run.engine_type);
  const gateMode = String(run.gate_mode || "off") === "approx" ? "approx" : "off";

  const candles = await readCandles(symbol, tf, fromMs, toMs);
  if (!candles.length) throw new Error("no candles");
  const fundingRates = isFutures ? await readFundingRates(symbol, fromMs, toMs).catch(() => []) : [];

  const adapters = await buildBacktestAdapters({ strategyKey, cfg, symbol, tf, candles, fromMs });
  const sim = await runSimulation({
    strategyKey,
    candles,
    cfg,
    costModelOverride: run.cost_model && typeof run.cost_model === "object" ? run.cost_model : {},
    gateMode,
    gateFn: null,
    fundingRates,
    onProgress: () => {},
    shouldCancel: () => false,
    startingUsdt,
    timeframe: tf,
    adapters,
  });

  const persistedReasons = await query(
    `SELECT exit_reason, count(*)::int AS n
       FROM backtest_trades
      WHERE backtest_run_id = $1
      GROUP BY exit_reason ORDER BY 2 DESC`,
    [runId],
  );

  const newReasons = countBy(sim.trades, (t) => t.exitReason);
  const newTierLabels = countBy(sim.trades.filter((t) => t.exitReason === "trail"), (t) => t.trailTierLabel || "(none)");

  console.log("\n=== Run", runId, "===");
  console.log("symbol", symbol, "tf", tf, "isFutures", isFutures, "strategyKey", strategyKey, "gateMode", gateMode);
  console.log("candles", candles.length, "trades_persisted_db", persistedReasons.rows.reduce((s, r) => s + r.n, 0));
  console.log("trades_replayed_new_engine", sim.trades.length, "finalEquity", sim.finalEquity.toFixed(2));
  console.log("\nPersisted (old engine) exit reasons:");
  for (const r of persistedReasons.rows) console.log("  ", r.exit_reason.padEnd(14), r.n);
  console.log("\nNew engine exit reasons:");
  for (const [k, v] of newReasons.entries()) console.log("  ", String(k).padEnd(14), v);
  console.log("\nNew engine trail tier-label distribution:");
  for (const [k, v] of newTierLabels.entries()) console.log("  ", String(k).padEnd(14), v);
  console.log("\nFirst 5 new engine trail exits:");
  const firstTrails = sim.trades.filter((t) => t.exitReason === "trail").slice(0, 5);
  for (const t of firstTrails) {
    console.log(
      "  #",
      t.tradeNumber,
      t.direction,
      "step", t.trailStep, "tier", t.trailTierLabel,
      "entry", t.entryPrice.toFixed(2), "exit", t.exitPrice.toFixed(2),
      "net", t.netPnl.toFixed(2),
    );
  }
}

function countBy(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return new Map([...m.entries()].sort((a, b) => b[1] - a[1]));
}

function pickBotCfg(snapshot, fallback) {
  const root =
    snapshot && typeof snapshot === "object"
      ? snapshot
      : fallback && typeof fallback === "object"
        ? fallback
        : {};
  if (root && typeof root.bot === "object" && root.bot) return root.bot;
  return root;
}

function pickStrategyKey(cfg, engineType) {
  const mmUp = String(cfg?.marketMode || cfg?.market || "").toUpperCase();
  const stSpot = Boolean(cfg?.supertrendSpotAuto);
  const stFut = Boolean(cfg?.supertrendFuturesAuto);
  const supertrendAutoOn =
    (mmUp === "SPOT" && stSpot) ||
    (mmUp === "FUTURES" && stFut) ||
    (mmUp === "AUTO" && (stSpot || stFut));
  if (supertrendAutoOn) return "SUPERTREND";
  const stratMode = String(cfg?.strategyMode ?? "").toUpperCase();
  if (stratMode === "MANUAL") {
    const m = String(cfg?.manualStrategy ?? "").toUpperCase();
    if (m && m !== "MANUAL" && m !== "AUTO") return m;
    return "SUPERTREND";
  }
  if (stratMode === "AUTO") return "AUTO";
  const et = String(engineType ?? "").toUpperCase();
  if (et && et !== "AUTO" && et !== "MANUAL") return et;
  return "SUPERTREND";
}
