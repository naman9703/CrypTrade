#!/usr/bin/env node
/**
 * Validates the SR_INTRADAY liquidity-solo config WITH the new reclaim body-ratio
 * filter (intradayLiqMinReclaimBodyRatio) against the trustworthy-validation gates:
 * Monte Carlo bootstrap (on trade R-multiples) + purged walk-forward (embargo) +
 * acceptance gates (OOS>0, MC p5>0, Calmar>1, WF degradation<35%).
 *
 * Baseline = the actual stored run config (body-ratio 0). Candidate = same config
 * with body-ratio 0.35. Run from backend/:
 *   node scripts/backtest-validate-sr-reclaim.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const sym = process.argv[2] || "BNBUSDT";
const tf = process.argv[3] || "15m";
const fromMs = new Date(process.env.FROM || "2026-01-01").getTime();
const toMs = new Date(process.env.TO || "2026-06-04").getTime();

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { monteCarloBootstrap, purgedWalkForwardSplits, acceptanceGates } = await import(
  "../src/backtest/engine/validation.js"
);

const run = (
  await pool.query(
    "SELECT config_snapshot FROM backtest_runs WHERE status='done' AND symbol=$1 AND timeframe=$2 ORDER BY finished_at DESC LIMIT 1",
    [sym, tf],
  )
).rows[0];
const BASE = run?.config_snapshot?.bot ?? run?.config_snapshot ?? {};

const candles = await readCandles(sym, tf, fromMs, toMs);
if (!candles?.length) {
  console.error(`No candles for ${sym} ${tf}`);
  await closePool?.();
  process.exit(1);
}
let fundingRates = [];
try {
  fundingRates = await readFundingRates(sym, fromMs, toMs);
} catch {
  fundingRates = [];
}

async function runWindow(slice, fundSlice, patch) {
  const cfg = {
    ...BASE,
    ...patch,
    symbol: sym,
    timeframe: tf,
    manualStrategy: "SR_INTRADAY",
    strategyMode: "MANUAL",
    marketMode: "FUTURES",
  };
  const adapters = await buildBacktestAdapters({
    strategyKey: "SR_INTRADAY",
    cfg,
    symbol: sym,
    tf,
    candles: slice,
    fromMs: slice[0]?.ts,
  });
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles: slice,
    cfg,
    gateMode: "off",
    fundingRates: fundSlice,
    startingUsdt: 100,
    timeframe: tf,
    adapters,
    symbol: sym,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf, startingEquity: 100 });
  return { sim, m };
}

async function validate(label, patch) {
  console.log(`\n${"=".repeat(70)}\n=== ${label} ===\n${"=".repeat(70)}`);

  // 1) Full window.
  const { sim, m } = await runWindow(candles, fundingRates, patch);
  console.log(
    `Full window: trades=${m.totalTrades} net=${(m.totalReturnPct || 0).toFixed(1)}% ` +
      `CAGR=${(m.cagrPct || 0).toFixed(1)}% Calmar=${(m.calmar ?? 0).toFixed(2)} ` +
      `maxDD=${(m.maxDrawdownPct || 0).toFixed(1)}% Sharpe=${(m.sharpe || 0).toFixed(2)} ` +
      `PF=${(m.profitFactor || 0).toFixed(2)} expR=${(m.expectancyR || 0).toFixed(3)}`,
  );

  // 2) Monte Carlo on R-multiples.
  const rstats = rMultipleStats(sim.trades);
  const mc = monteCarloBootstrap(rstats.rValues, { paths: 3000, riskFrac: 0.01, ruinDrawdownPct: 50 });
  console.log(`\nMonte Carlo (${mc.paths} paths, 1% risk/trade, n=${rstats.rCount} R-trades):`);
  if (mc.insufficient) console.log(`  insufficient trades for MC (${rstats.rCount})`);
  else {
    console.log(
      `  return p5=${mc.p5ReturnPct.toFixed(1)}% p50=${mc.p50ReturnPct.toFixed(1)}% p95=${mc.p95ReturnPct.toFixed(1)}%`,
    );
    console.log(`  maxDD  p50=${mc.medianMaxDdPct.toFixed(1)}% p95=${mc.p95MaxDdPct.toFixed(1)}%  ruin=${mc.riskOfRuinPct.toFixed(1)}%`);
  }

  // 3) Purged walk-forward.
  const stepMs = candles.length > 1 ? candles[1].ts - candles[0].ts : 900_000;
  const embargo = Math.max(1, Math.round(86_400_000 / stepMs));
  const splits = purgedWalkForwardSplits(candles.length, { folds: 4, embargo, mode: "rolling", minTrain: 300 });
  console.log(`\nPurged walk-forward (${splits.length} folds, embargo=${embargo} bars):`);
  let trainExpSum = 0;
  let testExpSum = 0;
  let testRetSum = 0;
  for (const s of splits) {
    const trainSlice = candles.slice(s.trainStart, s.trainEnd);
    const testSlice = candles.slice(s.testStart, s.testEnd);
    const ft = fundingRates.filter((f) => f.ts >= trainSlice[0]?.ts && f.ts <= trainSlice.at(-1)?.ts);
    const fe = fundingRates.filter((f) => f.ts >= testSlice[0]?.ts && f.ts <= testSlice.at(-1)?.ts);
    const tr = await runWindow(trainSlice, ft, patch);
    const te = await runWindow(testSlice, fe, patch);
    trainExpSum += tr.m.expectancy || 0;
    testExpSum += te.m.expectancy || 0;
    testRetSum += te.m.totalReturnPct || 0;
    console.log(
      `  fold ${s.fold}: train[n=${tr.m.totalTrades} exp=$${(tr.m.expectancy || 0).toFixed(2)}] ` +
        `test[n=${te.m.totalTrades} ret=${(te.m.totalReturnPct || 0).toFixed(1)}% exp=$${(te.m.expectancy || 0).toFixed(2)} PF=${(te.m.profitFactor || 0).toFixed(2)}]`,
    );
  }
  const avgTrainExp = splits.length ? trainExpSum / splits.length : 0;
  const avgTestExp = splits.length ? testExpSum / splits.length : 0;
  const wfDeg = avgTrainExp !== 0 ? ((avgTrainExp - avgTestExp) / Math.abs(avgTrainExp)) * 100 : 100;
  console.log(
    `\n  avg train exp=$${avgTrainExp.toFixed(2)} avg test exp=$${avgTestExp.toFixed(2)} degradation=${wfDeg.toFixed(1)}% OOS sum ret=${testRetSum.toFixed(1)}%`,
  );

  // 4) Gates.
  const gate = acceptanceGates({
    oosReturnPct: testRetSum,
    mcP5ReturnPct: mc.insufficient ? -1 : mc.p5ReturnPct,
    calmar: m.calmar ?? -1,
    walkForwardDegradationPct: wfDeg,
  });
  console.log(`\n  ----- ACCEPTANCE GATES -----`);
  for (const [name, g] of Object.entries(gate.gates)) {
    console.log(`  ${g.pass ? "PASS" : "FAIL"}  ${name.padEnd(18)} value=${Number(g.value).toFixed(2)} (need ${g.threshold})`);
  }
  console.log(`  VERDICT: ${gate.allPass ? "ACCEPTED" : "REJECTED"}`);
  return gate.allPass;
}

console.log(`\nValidating SR_INTRADAY on ${sym} ${tf} (${candles.length} bars, ${new Date(fromMs).toISOString().slice(0, 10)}→${new Date(toMs).toISOString().slice(0, 10)})`);
await validate("BASELINE (reclaim body-ratio 0)", { intradayLiqMinReclaimBodyRatio: 0 });
await validate("CANDIDATE (reclaim body-ratio 0.35)", { intradayLiqMinReclaimBodyRatio: 0.35 });

await closePool?.();
