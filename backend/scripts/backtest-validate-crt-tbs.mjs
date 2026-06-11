#!/usr/bin/env node
/**
 * Validate CRT_TBS — monthly, attribution, WF, MC gates.
 * Usage: node scripts/backtest-validate-crt-tbs.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SYMBOL = process.env.SYMBOL || "BNBUSDT";
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2025-06-01";
const TO = process.env.TO || "2026-06-05";
const RISK = Number(process.env.RISK || 2);
const START_USDT = Number(process.env.START_USDT || 100);

const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const { buildCrtTbsBacktestAdapter, resolveCrtTbsCfg } = await import("../src/strategy/crtTbsIntraday.js");
const { CRT_TBS_BNB_15M } = await import("../src/strategy/presets/crtTbsOptimized.js");
const { monteCarloBootstrap, purgedWalkForwardSplits, acceptanceGates } = await import(
  "../src/backtest/engine/validation.js"
);
const { aggregateSituationEntries } = await import("./lib/situationBacktestMetrics.mjs");

await initPool({ info: () => {}, warn: () => {}, error: console.error });

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const { crtTbsPadFromMs } = await import("../src/strategy/crtTbsIntraday.js");
const candles = await readCandles(SYMBOL, TF, crtTbsPadFromMs(fromMs, TF), toMs, { market: "futures" });

const crtCfg = resolveCrtTbsCfg({ ...CRT_TBS_BNB_15M, symbol: SYMBOL, timeframe: TF, riskPerTrade: RISK });
const cost = { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 };
const STRAT = "CRT_TBS";

async function runCrt(slice, start = START_USDT) {
  const adapter = buildCrtTbsBacktestAdapter(slice, crtCfg, TF);
  return runSimulation({
    candles: slice,
    strategyKey: STRAT,
    cfg: { ...crtCfg, symbol: SYMBOL },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: start,
    timeframe: TF,
    adapters: { [STRAT]: adapter },
    symbol: SYMBOL,
    costModelOverride: cost,
  });
}

const sim = await runCrt(candles);
const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: START_USDT });
const list = aggregateSituationEntries(sim.trades, fromMs, toMs);
const totalReturnPct = m.totalReturnPct ?? 0;
const wins = list.filter((t) => t.pnlPct > 0).length;
const wr = list.length ? (wins / list.length) * 100 : 0;

const byMonth = new Map();
const byTrigger = new Map();
for (const t of list) {
  const mo = new Date(t.ts).toISOString().slice(0, 7);
  byMonth.set(mo, (byMonth.get(mo) || 0) + t.pnlPct);
  const trig = t.trigger || "unknown";
  byTrigger.set(trig, (byTrigger.get(trig) || 0) + t.pnlPct);
}

console.log(`\n=== CRT_TBS ${SYMBOL} ${TF} ${FROM} → ${TO} @ ${RISK}% ===`);
console.log(`Entries: ${list.length} | Return: ${totalReturnPct >= 0 ? "+" : ""}${totalReturnPct.toFixed(2)}% | WR: ${wr.toFixed(0)}%`);
console.log(`MaxDD: ${(m.maxDrawdownPct ?? 0).toFixed(1)}% | Calmar: ${(m.calmar ?? 0).toFixed(2)} | PF: ${(m.profitFactor ?? 0).toFixed(2)}`);
console.log(`Trades/day: ${(list.length / Math.max(1, new Set(list.map((t) => new Date(t.ts).toISOString().slice(0, 10))).size)).toFixed(2)}`);

console.log("\n--- Monthly ---");
for (const [mo, pnl] of [...byMonth.entries()].sort()) {
  console.log(`  ${mo}: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%`);
}

console.log("\n--- Trigger attribution ---");
for (const [tr, pnl] of byTrigger.entries()) {
  console.log(`  ${tr}: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%`);
}

const rStats = rMultipleStats(sim.trades);
const rVals = rStats?.rValues ?? [];
const mc = monteCarloBootstrap(rVals, { paths: 2000, riskFrac: RISK / 100 });
console.log(`\n--- Monte Carlo (${rVals.length} R-values) ---`);
console.log(`  p5=${mc.p5ReturnPct.toFixed(2)}% p50=${mc.p50ReturnPct.toFixed(2)}% p95=${mc.p95ReturnPct.toFixed(2)}%`);

const splits = purgedWalkForwardSplits(candles, { nFolds: 5, purgeBars: 48, embargoBars: 24 });
let oosSum = 0;
for (const sp of splits) {
  const slice = candles.slice(sp.trainEnd, sp.testEnd);
  if (slice.length < 200) continue;
  const s = await runCrt(slice);
  const sm = computeAllMetrics({ trades: s.trades, equityCurve: s.equityCurve, tf: TF, startingEquity: START_USDT });
  oosSum += sm.totalReturnPct ?? 0;
}
const gates = acceptanceGates({
  oosReturnPct: oosSum,
  mcP5ReturnPct: mc.p5ReturnPct,
  calmar: m.calmar ?? 0,
  wfDegradationPct: 0,
});
console.log(`\n--- Walk-forward OOS sum: ${oosSum.toFixed(2)}% ---`);
console.log(`  VERDICT: ${Object.values(gates).every(Boolean) ? "PASS" : "REJECTED"}`);

await closePool();
