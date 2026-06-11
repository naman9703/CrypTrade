#!/usr/bin/env node
/**
 * Full audit of the most recent completed backtest run:
 * - Re-simulate from frozen config_snapshot → compare metrics
 * - Sum persisted trades → compare total PnL / trade count
 * - Cross-check run row columns vs metrics JSON
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const RUN_PREFIX = process.argv[2] || "";

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

function pickBot(snap) {
  if (!snap) return {};
  return snap.bot && typeof snap.bot === "object" ? snap.bot : snap;
}

const runQ = RUN_PREFIX
  ? await pool.query(`SELECT * FROM backtest_runs WHERE id::text LIKE $1 LIMIT 1`, [`${RUN_PREFIX}%`])
  : await pool.query(
      `SELECT * FROM backtest_runs WHERE status = 'done' ORDER BY created_at DESC LIMIT 1`,
    );
const run = runQ.rows[0];
if (!run) {
  console.error("No run found");
  process.exit(1);
}
const runId = run.id;

const cfg = pickBot(run.config_snapshot);
cfg.symbol = run.symbol;
cfg.timeframe = run.timeframe;

const fromMs = new Date(run.start_date).getTime();
const toMs = new Date(run.end_date).getTime();

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { materializeIntradayEngineCfgSync } = await import("../src/strategy/presets/srIntradayOptimized.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const candles = await readCandles(run.symbol, run.timeframe, fromMs, toMs);
if (!cfg._intradayEngineMaterialized) {
  Object.assign(cfg, materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg));
}
const funding = await readFundingRates(run.symbol, fromMs, toMs).catch(() => []);
const strategyKey = String(cfg.manualStrategy || run.engine_type || "SR_INTRADAY").toUpperCase();
const adapters = await buildBacktestAdapters({
  strategyKey,
  cfg,
  symbol: run.symbol,
  tf: run.timeframe,
  candles,
  fromMs,
});
const sim = await runSimulation({
  strategyKey,
  candles,
  cfg,
  gateMode: String(run.gate_mode || "off") === "approx" ? "approx" : "off",
  fundingRates: funding,
  startingUsdt: Number(run.initial_capital),
  timeframe: run.timeframe,
  adapters,
  symbol: run.symbol,
});
const repro = computeAllMetrics({
  trades: sim.trades,
  equityCurve: sim.equityCurve,
  tf: run.timeframe,
  startingEquity: Number(run.initial_capital),
});

const stored = run.metrics && typeof run.metrics === "object" ? run.metrics : {};
const startEq = Number(run.initial_capital);
const issues = [];

function cmp(label, a, b, tol = 0.05) {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) {
    issues.push(`${label}: missing (${a} vs ${b})`);
    return false;
  }
  const ok = Math.abs(na - nb) <= tol;
  if (!ok) issues.push(`${label}: stored=${na.toFixed(4)} repro=${nb.toFixed(4)} (Δ${(na - nb).toFixed(4)})`);
  return ok;
}

console.log("\n=== LAST BACKTEST RUN AUDIT ===\n");
console.log("runId:", String(runId));
console.log("status:", run.status, "| engine:", run.engine_type, "| gate:", run.gate_mode);
console.log("symbol/tf:", run.symbol, run.timeframe);
console.log("window:", new Date(run.start_date).toISOString().slice(0, 10), "→", new Date(run.end_date).toISOString().slice(0, 10));
console.log("candles:", candles.length, "| starting $", startEq);
console.log("config:", {
  manualStrategy: cfg.manualStrategy,
  liqGate: cfg.intradayGateLiquidity,
  srGate: cfg.intradayGateInstitutionalSr,
  tp2: cfg.intradayLiqTp2Enabled,
  minRr: cfg.intradayLiqMinRr,
  sweepExt: cfg.intradayLiqMinSweepExtensionPct,
  risk: cfg.riskPerTrade,
  riskUnit: cfg.riskPerTradeUnit,
});

console.log("\n--- Metrics: stored vs re-simulation ---");
cmp("totalReturnPct", stored.totalReturnPct, repro.totalReturnPct, 0.15);
cmp("totalTrades", stored.totalTrades, repro.totalTrades, 0);
cmp("winRate", (stored.winRate ?? 0) * 100, (repro.winRate ?? 0) * 100, 0.2);
cmp("profitFactor", stored.profitFactor, repro.profitFactor, 0.02);
cmp("maxDrawdownPct", stored.maxDrawdownPct, repro.maxDrawdownPct, 0.2);
cmp("finalEquity", stored.finalEquity, repro.finalEquity, 0.02);
cmp("sharpe", stored.sharpe, repro.sharpe, 0.05);

const trQ = await pool.query(
  `SELECT COUNT(*)::int AS n,
          SUM(net_pnl)::float AS sum_net,
          SUM(gross_pnl)::float AS sum_gross,
          SUM(fees_usdt)::float AS sum_fees,
          COUNT(*) FILTER (WHERE net_pnl > 0.01)::int AS wins,
          COUNT(*) FILTER (WHERE net_pnl < -0.01)::int AS losses
     FROM backtest_trades WHERE backtest_run_id = $1`,
  [runId],
);
const tr = trQ.rows[0];
const sumNet = Number(tr.sum_net ?? 0);
const impliedFinal = startEq + sumNet;

console.log("\n--- Persisted trade rows ---");
console.log("rows in backtest_trades:", tr.n);
console.log("wins/losses (row-level):", tr.wins, "/", tr.losses);
console.log("sum net_pnl:", sumNet.toFixed(4), "→ implied final equity:", impliedFinal.toFixed(4));
console.log("run.final_capital:", Number(run.final_capital));
console.log("run.total_trades:", run.total_trades);
console.log("run.total_pnl_usdt:", Number(run.total_pnl_usdt));

if (Math.abs(impliedFinal - Number(run.final_capital)) > 0.05) {
  issues.push(`final_capital: DB=${run.final_capital} vs sum(trades)+start=${impliedFinal.toFixed(4)}`);
}
if (Number(tr.n) !== Number(stored.totalTrades ?? run.total_trades)) {
  issues.push(`trade row count ${tr.n} != metrics.totalTrades ${stored.totalTrades}`);
}
if (Math.abs(sumNet - Number(stored.totalNetPnl ?? run.total_pnl_usdt)) > 0.05) {
  issues.push(`totalNetPnl mismatch: metrics=${stored.totalNetPnl} trades=${sumNet}`);
}

// Sim trades vs DB rows
if (sim.trades.length !== Number(tr.n)) {
  issues.push(`repro trade count ${sim.trades.length} != DB rows ${tr.n}`);
} else {
  let pnlMismatch = 0;
  const dbRows = await pool.query(
    `SELECT trade_number, net_pnl, exit_reason, direction FROM backtest_trades
      WHERE backtest_run_id = $1 ORDER BY trade_number`,
    [runId],
  );
  for (let i = 0; i < sim.trades.length; i++) {
    const s = sim.trades[i];
    const d = dbRows.rows[i];
    if (!d) continue;
    if (Math.abs(Number(s.netPnl) - Number(d.net_pnl)) > 0.02) pnlMismatch++;
  }
  if (pnlMismatch) issues.push(`${pnlMismatch} trades have net_pnl mismatch vs re-sim`);
}

console.log("\n--- Sim trade sample (first 3 / last 3) ---");
for (const t of [...sim.trades.slice(0, 3), ...sim.trades.slice(-3)]) {
  console.log(
    `  #${t.tradeNumber} ${t.direction} ${t.exitReason} net=${Number(t.netPnl).toFixed(2)} roi=${((t.roiPct ?? 0) * 100).toFixed(2)}%`,
  );
}

console.log("\n=== VERDICT ===");
if (!issues.length) {
  console.log("OK — summary metrics, trade rows, and re-simulation all align.");
} else {
  console.log("ISSUES (" + issues.length + "):");
  for (const x of issues) console.log("  •", x);
}

await closePool?.();
