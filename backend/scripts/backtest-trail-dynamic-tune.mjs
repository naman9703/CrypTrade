#!/usr/bin/env node
/**
 * Tune dynamic trailing params on a frozen backtest config, then compare FIXED_PCT vs best DYNAMIC.
 * Uses the same 1m mark micro-trail path as the backtest worker (live parity) — not parent-bar only.
 *
 * Usage (from backend/):
 *   node scripts/backtest-trail-dynamic-tune.mjs
 *   node scripts/backtest-trail-dynamic-tune.mjs <runIdPrefix>
 *   node scripts/backtest-trail-dynamic-tune.mjs --quick
 *   node scripts/backtest-trail-dynamic-tune.mjs --no-micro   # debug: parent-bar fallback only
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const quick = process.argv.includes("--quick");
const noMicro = process.argv.includes("--no-micro");
const runPrefix = process.argv.find(
  (a) => !a.startsWith("-") && a.endsWith(".mjs") === false && !a.includes("node"),
);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

function pickBot(snap) {
  if (!snap) return {};
  return snap.bot && typeof snap.bot === "object" ? snap.bot : snap;
}

const runQ = runPrefix
  ? await pool.query(`SELECT * FROM backtest_runs WHERE id::text LIKE $1 AND status = 'done' LIMIT 1`, [`${runPrefix}%`])
  : await pool.query(`SELECT * FROM backtest_runs WHERE status = 'done' ORDER BY created_at DESC LIMIT 1`);
const run = runQ.rows[0];
if (!run) {
  console.error("No completed run found");
  process.exit(1);
}

const baseCfg = pickBot(run.config_snapshot);
baseCfg.symbol = run.symbol;
baseCfg.timeframe = run.timeframe;
const fromMs = new Date(run.start_date).getTime();
const toMs = new Date(run.end_date).getTime();
const startingUsdt = Number(run.initial_capital) || 100;
const strategyKey = String(baseCfg.manualStrategy || run.engine_type || "SUPERTREND_ELITE").toUpperCase();

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { materializeIntradayEngineCfgSync } = await import("../src/strategy/presets/srIntradayOptimized.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");

console.log(`\n=== Dynamic trailing tune ===`);
console.log(`runId: ${run.id}`);
console.log(`strategy: ${strategyKey} | ${run.symbol} ${run.timeframe}`);
console.log(`window: ${run.start_date?.toISOString?.()?.slice(0, 10) ?? run.start_date} → ${run.end_date?.toISOString?.()?.slice(0, 10) ?? run.end_date}`);
console.log(`stored return: ${run.metrics?.totalReturnPct ?? "?"}% | trades: ${run.total_trades ?? "?"}`);
console.log(
  `trail sim: ${noMicro ? "parent-bar ONLY (--no-micro)" : "worker parity 1m mark micro-trail"}\n`,
);

const market = String(baseCfg.marketMode ?? "FUTURES").toUpperCase() === "SPOT" ? "spot" : "futures";
const isFutures = market === "futures";
const candles = await readCandles(run.symbol, run.timeframe, fromMs, toMs, { market });
if (!candles.length) {
  console.error("No candles — backfill DB first");
  process.exit(1);
}
if (!baseCfg._intradayEngineMaterialized) {
  Object.assign(baseCfg, materializeIntradayEngineCfgSync(baseCfg, materializeIntradayPanelOnCfg));
}
const funding = await readFundingRates(run.symbol, fromMs, toMs).catch(() => []);

const adapters = await buildBacktestAdapters({
  strategyKey,
  cfg: baseCfg,
  symbol: run.symbol,
  tf: run.timeframe,
  candles,
  fromMs,
});

function trailBase(overrides = {}) {
  return {
    ...baseCfg,
    trailingStopLossAuto: true,
    futuresTrailingStopMode: "SUPERTREND",
    futuresTrailingStFeeBreakeven: baseCfg.futuresTrailingStFeeBreakeven !== false,
    futuresTrailingStAdvanced: baseCfg.futuresTrailingStAdvanced !== false,
    backtestTrailMicroTf: baseCfg.backtestTrailMicroTf ?? "1m",
    ...overrides,
  };
}

function pnl(t) {
  return Number(t.netPnl ?? t.netPnlUsdt ?? t.pnlUsdt ?? 0);
}

/** Same handoff as backtest worker → runner (1m mark micro replay when trail on). */
let sharedTrailMicro = null;
async function resolveTrailMicro(cfg) {
  if (noMicro) return null;
  const futuresTrailMode = String(cfg?.futuresTrailingStopMode ?? "SUPERTREND").toUpperCase();
  const trailEnabled =
    cfg?.trailingStopLossAuto === true && isFutures && futuresTrailMode !== "OFF";
  if (!trailEnabled) return null;
  if (sharedTrailMicro) return sharedTrailMicro;
  const { buildTrailMicroContext } = await import("../src/backtest/engine/trailMicroSim.js");
  sharedTrailMicro = await buildTrailMicroContext({
    symbol: run.symbol,
    fromMs,
    toMs,
    cfg,
    trailEnabled: true,
  });
  return sharedTrailMicro;
}

async function simCfg(label, cfg) {
  const trailMicro = await resolveTrailMicro(cfg);
  const sim = await runSimulation({
    strategyKey,
    candles,
    cfg,
    gateMode: String(run.gate_mode || "off") === "approx" ? "approx" : "off",
    fundingRates: funding,
    startingUsdt,
    timeframe: run.timeframe,
    adapters,
    symbol: run.symbol,
    trailMicro,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: run.timeframe,
    startingEquity: startingUsdt,
  });
  const exits = {};
  for (const t of sim.trades) {
    const k = t.exitReason || "?";
    exits[k] = (exits[k] || 0) + 1;
  }
  const winners = sim.trades.filter((t) => pnl(t) > 0);
  const losers = sim.trades.filter((t) => pnl(t) <= 0);
  const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + pnl(t), 0) / winners.length : 0;
  const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + pnl(t), 0) / losers.length : 0;
  const trailExits = sim.trades.filter((t) => String(t.exitReason || "").toLowerCase() === "trail");
  const trailWinners = trailExits.filter((t) => pnl(t) > 0);
  const avgTrailPnl =
    trailExits.length > 0 ? trailExits.reduce((s, t) => s + pnl(t), 0) / trailExits.length : 0;
  const avgTrailWin =
    trailWinners.length > 0 ? trailWinners.reduce((s, t) => s + pnl(t), 0) / trailWinners.length : 0;
  const ret = m.totalReturnPct ?? 0;
  const dd = m.maxDrawdownPct ?? 0;
  const wr = (m.winRate ?? 0) * 100;
  const pf = m.profitFactor ?? 0;
  const score = ret - dd * 0.3 + (pf > 1 ? pf * 2 : 0);
  return {
    label,
    ret,
    dd,
    wr,
    pf,
    n: m.totalTrades ?? 0,
    exits,
    avgWin,
    avgLoss,
    avgTrailWin,
    avgTrailPnl,
    trailN: exits.trail ?? 0,
    score,
    cfg,
  };
}

const results = [];

async function runCase(label, cfg) {
  process.stdout.write(`  ${label.slice(0, 56).padEnd(56)} `);
  const r = await simCfg(label, cfg);
  results.push(r);
  console.log(
    `ret=${r.ret.toFixed(1).padStart(6)}% WR=${r.wr.toFixed(0).padStart(3)}% trail=${String(r.trailN).padStart(2)} DD=${r.dd.toFixed(1).padStart(5)}% PF=${r.pf.toFixed(2)}`,
  );
  return r;
}

console.log("--- Baseline (frozen config, as stored) ---\n");
await runCase("stored config (unchanged)", { ...baseCfg });

console.log("\n--- Fixed % trailing (explicit) ---\n");
await runCase("FIXED_PCT explicit", trailBase({ trailSizingMode: "FIXED_PCT" }));

console.log("\n--- Dynamic trailing grid ---\n");
const beMults = quick ? [0.35, 0.5, 0.75] : [0.25, 0.35, 0.5, 0.65, 0.85];
const hwmMults = quick ? [0.75, 1.0, 1.25] : [0.6, 0.85, 1.0, 1.25, 1.5];
const givebacks = quick ? [0.15, 0.25, 0.35] : [0.15, 0.2, 0.25, 0.3, 0.35];
const mfeMinRs = quick ? [0.75, 1.0] : [0.5, 0.75, 1.0, 1.25];
const stepMults = quick ? [0.35, 0.5] : [0.25, 0.35, 0.5, 0.65, 0.85];

for (const be of beMults) {
  for (const hwm of hwmMults) {
    for (const gb of givebacks) {
      for (const minR of mfeMinRs) {
        for (const step of stepMults) {
          await runCase(`DYN be=${be} hwm=${hwm} gb=${gb} minR=${minR} step=${step}`, trailBase({
            trailSizingMode: "DYNAMIC",
            trailDynamicBeAtrMult: be,
            trailDynamicAdvAtrHwmMult: hwm,
            trailDynamicAdvMfeGivebackFrac: gb,
            trailDynamicAdvMfeMinR: minR,
            trailDynamicAdvPostT02StepAtrMult: step,
            trailDynamicAdvMergeSupertrend: true,
            trailDynamicAdvAtrSource: "ENTRY",
            trailDynamicBeRegimeAdjust: false,
          }));
        }
      }
    }
  }
}

if (!quick) {
  console.log("\n--- Regime-adjust variants (top BE mult candidates) ---\n");
  for (const be of [0.35, 0.5]) {
    await runCase(`DYN+regime be=${be}`, trailBase({
      trailSizingMode: "DYNAMIC",
      trailDynamicBeAtrMult: be,
      trailDynamicBeRegimeAdjust: true,
      trailDynamicBeRegimeLowMult: 0.85,
      trailDynamicBeRegimeHighMult: 1.15,
      trailDynamicAdvAtrHwmMult: 1.0,
      trailDynamicAdvMfeGivebackFrac: 0.25,
      trailDynamicAdvMfeMinR: 1.0,
      trailDynamicAdvPostT02StepAtrMult: 0.5,
    }));
  }
}

results.sort((a, b) => b.score - a.score);
const fixed = results.find((r) => r.label === "FIXED_PCT explicit") ?? results.find((r) => r.label.includes("stored"));
const bestDyn = results
  .filter((r) => r.label.startsWith("DYN"))
  .sort((a, b) => b.score - a.score)[0];

console.log("\n╔══════════════════════════════════════════════════════════════╗");
console.log("║ TOP 12 by score (return − 0.3×DD + PF bonus)              ║");
console.log("╚══════════════════════════════════════════════════════════════╝\n");
for (const r of results.slice(0, 12)) {
  console.log(
    `${r.label.padEnd(44)} ret=${r.ret.toFixed(2).padStart(7)}% WR=${r.wr.toFixed(0).padStart(3)}% trail=${r.trailN} avgTrail=$${r.avgTrailPnl.toFixed(2)} DD=${r.dd.toFixed(1)}%`,
  );
}

console.log("\n=== VERDICT ===");
if (fixed) {
  console.log(`Stored / Fixed baseline:  ${fixed.label} → ${fixed.ret.toFixed(2)}% (trail exits: ${fixed.trailN}, DD: ${fixed.dd.toFixed(1)}%)`);
}
if (bestDyn) {
  console.log(`Best dynamic:           ${bestDyn.label} → ${bestDyn.ret.toFixed(2)}% (trail exits: ${bestDyn.trailN}, avg trail PnL: $${bestDyn.avgTrailPnl.toFixed(2)}, DD: ${bestDyn.dd.toFixed(1)}%)`);
  if (fixed) {
    const delta = bestDyn.ret - fixed.ret;
    console.log(`Dynamic vs Fixed Δ:     ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}% return`);
    console.log(`Trail capture:          avg win $${fixed.avgWin.toFixed(2)} → $${bestDyn.avgWin.toFixed(2)} | trail-specific avg $${bestDyn.avgTrailWin.toFixed(2)}`);
  }
  console.log("\nRecommended dynamic params:");
  console.log(
    JSON.stringify(
      {
        trailSizingMode: "DYNAMIC",
        trailDynamicBeAtrMult: bestDyn.cfg.trailDynamicBeAtrMult,
        trailDynamicBeT01LockAtrMult: bestDyn.cfg.trailDynamicBeT01LockAtrMult ?? 0,
        trailDynamicBeRegimeAdjust: bestDyn.cfg.trailDynamicBeRegimeAdjust ?? false,
        trailDynamicAdvAtrHwmMult: bestDyn.cfg.trailDynamicAdvAtrHwmMult,
        trailDynamicAdvMfeGivebackFrac: bestDyn.cfg.trailDynamicAdvMfeGivebackFrac,
        trailDynamicAdvMfeMinR: bestDyn.cfg.trailDynamicAdvMfeMinR,
        trailDynamicAdvPostT02StepAtrMult: bestDyn.cfg.trailDynamicAdvPostT02StepAtrMult,
        trailDynamicAdvMergeSupertrend: bestDyn.cfg.trailDynamicAdvMergeSupertrend !== false,
        trailDynamicAdvAtrSource: bestDyn.cfg.trailDynamicAdvAtrSource ?? "ENTRY",
      },
      null,
      2,
    ),
  );
}

await closePool();
