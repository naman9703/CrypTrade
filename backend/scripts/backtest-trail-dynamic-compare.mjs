#!/usr/bin/env node
/**
 * Fast Fixed % vs Dynamic V2 compare — single symbol, worker 1m mark micro-trail.
 * Usage: node scripts/backtest-trail-dynamic-compare.mjs [runPrefix] [--symbol BTCUSDT]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { DYNAMIC_TRAIL_V2_DEFAULTS, getDynamicTrailDefaultsForStrategy } from "../src/lib/dynamicTrailing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const runPrefix = process.argv.find((a) => /^[0-9a-f]{6,}$/i.test(a)) ?? "1845b3b6";
const symArg = (() => {
  const i = process.argv.indexOf("--symbol");
  return i >= 0 ? String(process.argv[i + 1] || "BTCUSDT").toUpperCase() : "BTCUSDT";
})();

const TUNED_FIXED_ST = {
  trailSizingMode: "FIXED_PCT",
  supertrendFuturesFixedSlPct: 0.01,
  trailBufferRate: 0.01,
  trailFeeBeMultiplier: 2,
  trailPostT02SpacingFrac: 0.001,
};

const TUNED_FIXED_UNI = {
  trailSizingMode: "FIXED_PCT",
  supertrendFuturesFixedSlPct: 0.025,
  trailBufferRate: 0.01,
  trailFeeBeMultiplier: 2,
  trailPostT02SpacingFrac: 0.001,
};

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

const runQ = await pool.query(
  `SELECT * FROM backtest_runs WHERE id::text LIKE $1 AND status = 'done' LIMIT 1`,
  [`${runPrefix}%`],
);
const run = runQ.rows[0];
if (!run) throw new Error(`No run for ${runPrefix}`);

const snap = run.config_snapshot?.bot ?? run.config_snapshot ?? {};
const strategyKey = String(snap.manualStrategy || run.engine_type || "SUPERTREND_ELITE").toUpperCase();
const tunedFixed = strategyKey === "UNIFIED_ELITE" ? TUNED_FIXED_UNI : TUNED_FIXED_ST;

const CASES = [
  { label: "saved (tight)", overrides: { trailSizingMode: "FIXED_PCT" } },
  { label: "tuned FIXED %", overrides: null },
  { label: "DYNAMIC v2 defaults", overrides: { trailSizingMode: "DYNAMIC", ...getDynamicTrailDefaultsForStrategy(strategyKey) } },
  {
    label: "DYNAMIC sl=1.0 be=1.0",
    overrides: {
      trailSizingMode: "DYNAMIC",
      trailDynamicSlAtrMult: 1,
      trailDynamicBeAtrMult: 1,
      trailDynamicMicroFloorMult: 0.9,
      trailDynamicAdvAtrHwmMult: 2.5,
      trailDynamicAdvMfeGivebackFrac: 0.18,
      trailDynamicAdvMfeMinR: 1.25,
      trailDynamicAdvPostT02StepAtrMult: 0.085,
      trailDynamicBeT01LockAtrMult: 0,
      trailDynamicBeRegimeAdjust: true,
    },
  },
  {
    label: "DYNAMIC alt-wide (3% ATR coins)",
    overrides: {
      trailSizingMode: "DYNAMIC",
      trailDynamicSlAtrMult: 1.1,
      trailDynamicBeAtrMult: 1.05,
      trailDynamicMicroFloorMult: 1,
      trailDynamicAdvAtrHwmMult: 2.75,
      trailDynamicAdvMfeGivebackFrac: 0.16,
      trailDynamicAdvMfeMinR: 1.5,
      trailDynamicAdvPostT02StepAtrMult: 0.09,
      trailDynamicBeT01LockAtrMult: 0,
    },
  },
];

const baseCfg = { ...snap, symbol: symArg, timeframe: run.timeframe, manualStrategy: strategyKey };
const fromMs = new Date(run.start_date).getTime();
const toMs = new Date(run.end_date).getTime();
const startingUsdt = Number(run.initial_capital) || 100;
const market = String(baseCfg.marketMode ?? "FUTURES").toUpperCase() === "SPOT" ? "spot" : "futures";
const isFutures = market === "futures";

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { materializeIntradayEngineCfgSync } = await import("../src/strategy/presets/srIntradayOptimized.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");

if (!baseCfg._intradayEngineMaterialized) {
  Object.assign(baseCfg, materializeIntradayEngineCfgSync(baseCfg, materializeIntradayPanelOnCfg));
}

const candles = await readCandles(symArg, run.timeframe, fromMs, toMs, { market });
if (!candles.length) throw new Error(`No candles for ${symArg}`);
const funding = await readFundingRates(symArg, fromMs, toMs).catch(() => []);
const adapters = await buildBacktestAdapters({
  strategyKey,
  cfg: baseCfg,
  symbol: symArg,
  tf: run.timeframe,
  candles,
  fromMs,
});

let trailMicro = null;
async function getTrailMicro(cfg) {
  if (trailMicro) return trailMicro;
  const { buildTrailMicroContext } = await import("../src/backtest/engine/trailMicroSim.js");
  trailMicro = await buildTrailMicroContext({
    symbol: symArg,
    fromMs,
    toMs,
    cfg,
    trailEnabled: true,
  });
  return trailMicro;
}

function pnl(t) {
  return Number(t.netPnl ?? t.netPnlUsdt ?? 0);
}

async function runCase(label, overrides) {
  const cfg = {
    ...baseCfg,
    trailingStopLossAuto: true,
    futuresTrailingStopMode: "SUPERTREND",
    futuresTrailingStFeeBreakeven: baseCfg.futuresTrailingStFeeBreakeven !== false,
    futuresTrailingStAdvanced: baseCfg.futuresTrailingStAdvanced !== false,
    supertrendFuturesUseFixedSl: true,
    backtestTrailMicroTf: "1m",
    ...(overrides === null ? tunedFixed : overrides),
  };
  const micro = await getTrailMicro(cfg);
  const sim = await runSimulation({
    strategyKey,
    candles,
    cfg,
    gateMode: String(run.gate_mode || "off") === "approx" ? "approx" : "off",
    fundingRates: funding,
    startingUsdt,
    timeframe: run.timeframe,
    adapters,
    symbol: symArg,
    trailMicro: micro,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: run.timeframe,
    startingEquity: startingUsdt,
  });
  let trailN = 0;
  let slN = 0;
  let trailPnl = 0;
  for (const t of sim.trades) {
    if (t.exitReason === "trail") {
      trailN++;
      trailPnl += pnl(t);
    }
    if (t.exitReason === "sl") slN++;
  }
  return {
    label,
    ret: m.totalReturnPct ?? 0,
    dd: m.maxDrawdownPct ?? 0,
    wr: (m.winRate ?? 0) * 100,
    pf: m.profitFactor ?? 0,
    n: m.totalTrades ?? 0,
    trailN,
    slN,
    trailPnl,
  };
}

console.log(`\n=== Trail compare (1m mark micro) ===`);
console.log(`${strategyKey} | ${symArg} ${run.timeframe} | ${run.start_date?.toISOString?.()?.slice(0, 10)} → ${run.end_date?.toISOString?.()?.slice(0, 10)}`);
console.log(`run ${run.id.slice(0, 8)} | stored ret ${Number(run.metrics?.totalReturnPct).toFixed(1)}%\n`);

const rows = [];
for (const c of CASES) {
  process.stdout.write(`  ${c.label.padEnd(28)} `);
  const r = await runCase(c.label, c.overrides);
  rows.push(r);
  console.log(
    `ret=${r.ret.toFixed(1).padStart(7)}% DD=${r.dd.toFixed(1)}% trail=${r.trailN} sl=${r.slN} trail$=${r.trailPnl.toFixed(1)} PF=${r.pf.toFixed(2)}`,
  );
}

const fixed = rows.find((r) => r.label === "tuned FIXED %");
const bestDyn = rows
  .filter((r) => r.label.startsWith("DYNAMIC"))
  .sort((a, b) => b.ret - a.ret)[0];
console.log("\n--- Verdict ---");
if (fixed && bestDyn) {
  console.log(`Tuned Fixed: ${fixed.ret.toFixed(2)}% | Best Dynamic: ${bestDyn.label} → ${bestDyn.ret.toFixed(2)}% (Δ ${(bestDyn.ret - fixed.ret).toFixed(2)}%)`);
}

await closePool();
