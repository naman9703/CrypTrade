#!/usr/bin/env node
/** Audit one backtest run + replay from frozen config_snapshot (worker parity). */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const RUN_ID = process.argv[2];
if (!RUN_ID) {
  console.error("Usage: node scripts/audit-run-replay.mjs <run-id-prefix>");
  process.exit(1);
}

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

function pickBot(snap) {
  if (!snap) return {};
  return snap.bot && typeof snap.bot === "object" ? snap.bot : snap;
}

const runQ = await pool.query(
  `SELECT br.*, sv.cfg_raw AS strategy_cfg_raw
     FROM backtest_runs br
     JOIN strategy_versions sv ON sv.id = br.strategy_version_id
    WHERE br.id::text LIKE $1 LIMIT 1`,
  [`${RUN_ID}%`],
);
const run = runQ.rows[0];
if (!run) {
  console.error("Run not found");
  process.exit(1);
}

async function materializeCfg(runRow) {
  let cfg = pickBot(runRow.config_snapshot);
  try {
    const { stripRuntimePollutionFromBot, mergeMissingSignalBrainBot, sanitizeSignalBrainCfgRaw } =
      await import("../src/lib/strategySignalBrain.js");
    stripRuntimePollutionFromBot(cfg);
    if (runRow.strategy_cfg_raw && typeof runRow.strategy_cfg_raw === "object") {
      const versionBrain = sanitizeSignalBrainCfgRaw(runRow.strategy_cfg_raw).bot ?? {};
      mergeMissingSignalBrainBot(cfg, versionBrain);
    }
  } catch {
    /* optional */
  }
  try {
    const { materializeIntradayEngineCfgSync } = await import("../src/strategy/presets/srIntradayOptimized.js");
    const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
    const { ensureBacktestMarketMode, applyInstanceOperationalToBot } = await import("../src/lib/strategyInstanceSplit.js");
    const { normalizeEliteStRunCfg } = await import("../strategy/supertrendElite.js");
    const stratEarly = String(cfg.manualStrategy ?? "").toUpperCase();
    if (stratEarly === "SITUATION_INTRADAY") {
      const { resolveSituationRouterCfg } = await import("../strategy/situationIntraday.js");
      cfg = resolveSituationRouterCfg(cfg);
      cfg._intradayEngineMaterialized = true;
    } else if (stratEarly === "CRT_TBS") {
      const { resolveCrtTbsCfg } = await import("../strategy/crtTbsIntraday.js");
      cfg = resolveCrtTbsCfg(cfg);
      cfg._intradayEngineMaterialized = true;
    } else if (stratEarly === "TOKYO_SESSION") {
      const { resolveTokyoSessionCfg } = await import("../strategy/tokyoSessionIntraday.js");
      cfg = resolveTokyoSessionCfg(cfg);
      cfg._intradayEngineMaterialized = true;
    } else if (stratEarly === "SUPERTREND_ELITE" || stratEarly === "UNIFIED_ELITE") {
      cfg._intradayEngineMaterialized = true;
    } else if (!cfg._intradayEngineMaterialized) {
      cfg = materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
    }
    if (runRow.instance_operational_snapshot) {
      applyInstanceOperationalToBot(cfg, runRow.instance_operational_snapshot);
    }
    cfg = ensureBacktestMarketMode(cfg);
    if (stratEarly === "SUPERTREND_ELITE") {
      Object.assign(cfg, normalizeEliteStRunCfg(cfg));
    }
  } catch (e) {
    console.warn("materialize warn:", e?.message);
  }
  cfg.symbol = runRow.symbol;
  cfg.timeframe = runRow.timeframe;
  if (runRow.cost_model?.slippagePct != null) cfg.slippagePct = runRow.cost_model.slippagePct;
  return cfg;
}

const cfg = await materializeCfg(run);
const rawCfg = { ...pickBot(run.config_snapshot), symbol: run.symbol, timeframe: run.timeframe };
if (run.cost_model?.slippagePct != null) rawCfg.slippagePct = run.cost_model.slippagePct;
const fromMs = new Date(run.start_date).getTime();
const toMs = new Date(run.end_date).getTime();
const startEq = Number(run.initial_capital);
const stored = run.metrics && typeof run.metrics === "object" ? run.metrics : {};
const strategyKey = String(cfg.manualStrategy || run.engine_type || "HTF_RSI").toUpperCase();
const gateMode = String(run.gate_mode || "off") === "approx" ? "approx" : "off";
const market = String(cfg.marketMode ?? "FUTURES").toUpperCase() === "SPOT" ? "spot" : "futures";
const isFutures = market === "futures";

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

async function applyBacktestBracketCap(cfg, symbol) {
  if (String(process.env.BACKTEST_SIMULATE_BRACKET_CAP ?? "0") !== "1") return cfg;
  const lev = Math.max(1, Number(cfg?.futuresLeverage ?? cfg?.leverage ?? 10));
  const { fetchLeverageBracketNotionalCap } = await import("../lib/binanceUsdMBracketFetch.js");
  const cap = await fetchLeverageBracketNotionalCap(symbol, lev, process.env.BACKTEST_BRACKET_TRADING_MODE || "BINANCE_DEMO_API");
  if (cap != null && cap > 0) return { ...cfg, backtestBracketNotionalCap: cap };
  return cfg;
}

const candles = await readCandles(run.symbol, run.timeframe, fromMs, toMs, { market });
const funding = isFutures ? await readFundingRates(run.symbol, fromMs, toMs).catch(() => []) : [];

let simCfg = { ...cfg };
if (isFutures) simCfg = await applyBacktestBracketCap(simCfg, run.symbol);

async function runReplay(label, baseCfg) {
  let c = { ...baseCfg };
  if (isFutures) c = await applyBacktestBracketCap(c, run.symbol);
  const ad = await buildBacktestAdapters({
    strategyKey,
    cfg: c,
    symbol: run.symbol,
    tf: run.timeframe,
    candles,
    fromMs,
  });
  const s = await runSimulation({
    strategyKey,
    candles,
    cfg: c,
    gateMode,
    fundingRates: funding,
    startingUsdt: startEq,
    timeframe: run.timeframe,
    adapters: ad,
    symbol: run.symbol,
  });
  const m = computeAllMetrics({
    trades: s.trades,
    equityCurve: s.equityCurve,
    tf: run.timeframe,
    startingEquity: startEq,
  });
  return { label, cfg: c, sim: s, metrics: m };
}

const replays = [
  await runReplay("materialized (worker parity)", simCfg),
  await runReplay("raw frozen snapshot only", rawCfg),
];
const repro = replays[0].metrics;

const issues = [];
function cmp(label, a, b, tol = 0.15) {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) {
    issues.push(`${label}: missing (${a} vs ${b})`);
    return;
  }
  if (Math.abs(na - nb) > tol) issues.push(`${label}: stored=${na.toFixed(4)} repro=${nb.toFixed(4)} Δ=${(na - nb).toFixed(4)}`);
}

const trQ = await pool.query(
  `SELECT COUNT(*)::int AS n, SUM(net_pnl)::float AS sum_net, SUM(gross_pnl)::float AS sum_gross,
          SUM(fees_usdt)::float AS sum_fees, MIN(net_pnl)::float AS min_net, MAX(net_pnl)::float AS max_net
     FROM backtest_trades WHERE backtest_run_id = $1`,
  [run.id],
);
const tr = trQ.rows[0];
const sumNet = Number(tr.sum_net ?? 0);
const impliedFinal = startEq + sumNet;

console.log("\n=== RUN AUDIT ===");
console.log("id:", run.id);
console.log("created:", run.created_at?.toISOString?.());
console.log("symbol/tf:", run.symbol, run.timeframe);
console.log("window:", new Date(run.start_date).toISOString().slice(0, 10), "→", new Date(run.end_date).toISOString().slice(0, 10));
console.log("engine:", run.engine_type, "| gate:", run.gate_mode, "| source:", run.config_source);
console.log("candles:", candles.length, "| start $", startEq);

console.log("\n--- Frozen config (signal + sizing) ---");
for (const k of [
  "manualStrategy",
  "strategyMode",
  "backtestPositionSizing",
  "riskPerTrade",
  "riskPerTradeUnit",
  "futuresLeverage",
  "allowedBudgetUsdt",
  "multiBudgetSplitMode",
  "capitalCycleSymbols",
  "supertrendFuturesFixedSlPct",
  "supertrendFuturesFixedTpPct",
  "trailingStopLossAuto",
  "slippagePct",
]) {
  console.log(`  ${k}: ${JSON.stringify(cfg[k])}`);
}

console.log("\n--- Instance ops ---");
console.log(JSON.stringify(run.instance_operational_snapshot, null, 2));

console.log("\n--- Stored metrics ---");
console.log({
  totalReturnPct: stored.totalReturnPct,
  totalTrades: stored.totalTrades ?? run.total_trades,
  maxDrawdownPct: stored.maxDrawdownPct ?? run.max_drawdown_pct,
  profitFactor: stored.profitFactor ?? run.profit_factor,
  finalEquity: stored.finalEquity ?? run.final_capital,
  sharpe: stored.sharpe ?? run.sharpe_ratio,
});

console.log("\n--- Replay metrics (same frozen config) ---");
console.log({
  totalReturnPct: repro.totalReturnPct,
  totalTrades: repro.totalTrades,
  maxDrawdownPct: repro.maxDrawdownPct,
  profitFactor: repro.profitFactor,
  finalEquity: repro.finalEquity,
  sharpe: repro.sharpe,
});

console.log("\n--- Stored vs replay ---");
cmp("totalReturnPct", stored.totalReturnPct, repro.totalReturnPct, 0.5);
cmp("totalTrades", stored.totalTrades ?? run.total_trades, repro.totalTrades, 0);
cmp("maxDrawdownPct", stored.maxDrawdownPct, repro.maxDrawdownPct, 0.5);
cmp("profitFactor", stored.profitFactor, repro.profitFactor, 0.05);
cmp("finalEquity", stored.finalEquity ?? run.final_capital, repro.finalEquity, 1);

console.log("\n--- Persisted trades ---");
console.log("rows:", tr.n, "| sum net:", sumNet.toFixed(4), "| implied final:", impliedFinal.toFixed(4));
console.log("DB final_capital:", run.final_capital, "| total_pnl_usdt:", run.total_pnl_usdt);
console.log("min/max trade net:", tr.min_net?.toFixed?.(2), "/", tr.max_net?.toFixed?.(2));

const dbTrades = await pool.query(
  `SELECT trade_number, direction, exit_reason, net_pnl, quantity, entry_price, exit_price, capital_after
     FROM backtest_trades WHERE backtest_run_id = $1 ORDER BY trade_number`,
  [run.id],
);
console.log("\n--- All stored trades ---");
for (const t of dbTrades.rows) {
  console.log(
    `  #${t.trade_number} ${t.direction} ${t.exit_reason} net=${Number(t.net_pnl).toFixed(2)} qty=${Number(t.quantity).toFixed(4)} capAfter=${Number(t.capital_after).toFixed(2)}`,
  );
}

console.log("\n--- Replay variants ---");
for (const r of replays) {
  console.log(`${r.label}: ret=${Number(r.metrics.totalReturnPct).toFixed(2)}% trades=${r.metrics.totalTrades} dd=${Number(r.metrics.maxDrawdownPct).toFixed(2)}% final=$${Number(r.metrics.finalEquity).toFixed(2)} PF=${Number(r.metrics.profitFactor).toFixed(2)}`);
}

console.log("\n--- Replay trades (materialized, first/last 5) ---");
const sim = replays[0].sim;
const rt = sim.trades.filter((x) => x.exitReason !== "tp1_partial");
for (const t of [...rt.slice(0, 5), ...rt.slice(-5)]) {
  console.log(
    `  #${t.tradeNumber} ${t.direction} ${t.exitReason} net=${Number(t.netPnl).toFixed(2)} qty=${Number(t.qty).toFixed(4)}`,
  );
}

if (Math.abs(impliedFinal - Number(run.final_capital)) > 1) {
  issues.push(`final_capital vs sum(trades): DB=${run.final_capital} implied=${impliedFinal.toFixed(2)}`);
}

console.log("\n=== VERDICT ===");
if (!issues.length) console.log("OK — replay matches stored run.");
else {
  console.log(`ISSUES (${issues.length}):`);
  for (const x of issues) console.log(" •", x);
}

await closePool?.();
