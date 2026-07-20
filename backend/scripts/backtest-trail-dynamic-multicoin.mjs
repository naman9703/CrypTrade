#!/usr/bin/env node
/** Multi-coin Fixed % vs Dynamic V2 — 1m mark micro trail. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { DYNAMIC_TRAIL_V2_DEFAULTS, getDynamicTrailDefaultsForStrategy } from "../src/lib/dynamicTrailing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const runPrefix = process.argv[2] ?? "1845b3b6";
const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "LINKUSDT"];

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
const runQ = await pool.query(`SELECT * FROM backtest_runs WHERE id::text LIKE $1 AND status='done' LIMIT 1`, [`${runPrefix}%`]);
const run = runQ.rows[0];
const snap = run.config_snapshot?.bot ?? run.config_snapshot ?? {};
const strategyKey = String(snap.manualStrategy || run.engine_type || "SUPERTREND_ELITE").toUpperCase();
const tunedFixed = strategyKey === "UNIFIED_ELITE" ? TUNED_FIXED_UNI : TUNED_FIXED_ST;
const fromMs = new Date(run.start_date).getTime();
const toMs = new Date(run.end_date).getTime();
const startingUsdt = Number(run.initial_capital) || 100;
const market = "futures";

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { materializeIntradayEngineCfgSync } = await import("../src/strategy/presets/srIntradayOptimized.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");

const baseCfg = { ...snap, timeframe: run.timeframe, manualStrategy: strategyKey };
if (!baseCfg._intradayEngineMaterialized) {
  Object.assign(baseCfg, materializeIntradayEngineCfgSync(baseCfg, materializeIntradayPanelOnCfg));
}

const microCache = new Map();
async function sim(sym, overrides) {
  const candles = await readCandles(sym, run.timeframe, fromMs, toMs, { market });
  if (!candles.length) return null;
  const cfg = {
    ...baseCfg,
    symbol: sym,
    trailingStopLossAuto: true,
    futuresTrailingStopMode: "SUPERTREND",
    futuresTrailingStFeeBreakeven: true,
    futuresTrailingStAdvanced: true,
    supertrendFuturesUseFixedSl: true,
    backtestTrailMicroTf: "1m",
    ...overrides,
  };
  const funding = await readFundingRates(sym, fromMs, toMs).catch(() => []);
  const adapters = await buildBacktestAdapters({ strategyKey, cfg, symbol: sym, tf: run.timeframe, candles, fromMs });
  if (!microCache.has(sym)) {
    const { buildTrailMicroContext } = await import("../src/backtest/engine/trailMicroSim.js");
    microCache.set(sym, await buildTrailMicroContext({ symbol: sym, fromMs, toMs, cfg, trailEnabled: true }));
  }
  const sim = await runSimulation({
    strategyKey, candles, cfg, gateMode: "off", fundingRates: funding, startingUsdt,
    timeframe: run.timeframe, adapters, symbol: sym, trailMicro: microCache.get(sym),
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: run.timeframe, startingEquity: startingUsdt });
  return { sym, ret: m.totalReturnPct ?? 0, dd: m.maxDrawdownPct ?? 0, pf: m.profitFactor ?? 0, n: m.totalTrades ?? 0 };
}

console.log(`\n=== Multi-coin ${strategyKey} | 1m micro | ${run.start_date?.toISOString?.()?.slice(0,10)} → ${run.end_date?.toISOString?.()?.slice(0,10)} ===\n`);
console.log(`${"symbol".padEnd(10)} ${"fixed%".padStart(8)} ${"dynamic".padStart(8)} ${"Δ".padStart(8)}`);
let fSum = 0;
let dSum = 0;
let n = 0;
for (const sym of symbols) {
  process.stdout.write(`  ${sym}… `);
  const f = await sim(sym, tunedFixed);
  const d = await sim(sym, { trailSizingMode: "DYNAMIC", ...getDynamicTrailDefaultsForStrategy(strategyKey) });
  if (!f || !d) {
    console.log("skip");
    continue;
  }
  fSum += f.ret;
  dSum += d.ret;
  n++;
  console.log(`${sym.padEnd(10)} ${f.ret.toFixed(1).padStart(7)}% ${d.ret.toFixed(1).padStart(7)}% ${(d.ret - f.ret).toFixed(1).padStart(7)}%`);
}
if (n) {
  console.log(`\navg fixed: ${(fSum / n).toFixed(2)}% | avg dynamic: ${(dSum / n).toFixed(2)}% | Δ ${((dSum - fSum) / n).toFixed(2)}%`);
}
await closePool();
