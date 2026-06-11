#!/usr/bin/env node
/**
 * UNIFIED_ELITE — 5-coin portfolio backtest + walk-forward + Monte Carlo gates.
 *
 * Tests three variants on each coin, then aggregates portfolio results:
 *   A) SUPERTREND_ELITE baseline (1H, no regime / liq layers)
 *   B) UNIFIED_ELITE — all layers on
 *   C) UNIFIED_ELITE — regime gate only (no liq supplement, no scale-up)
 *
 * Acceptance gates (same as research harness):
 *   OOS sum return > 0
 *   MC 5th-pct return > 0
 *   Calmar > 1
 *   WF degradation < 35%
 *
 * Usage (from backend/):
 *   node scripts/backtest-unified-elite.mjs
 *   FROM=2025-06-01 TO=2026-06-04 node scripts/backtest-unified-elite.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const fromMs = new Date(process.env.FROM || "2025-06-01").getTime();
const toMs = new Date(process.env.TO || "2026-06-04").getTime();
const TF = "1h";
const COINS = ["BNBUSDT", "BTCUSDT", "ETHUSDT", "LINKUSDT", "XRPUSDT"];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const { buildEliteStBacktestAdapter, buildEliteStOptsFromCfg } = await import(
  "../src/strategy/supertrendElite.js"
);
const { buildUnifiedEliteBacktestAdapter, buildUnifiedEliteOptsFromCfg } = await import(
  "../src/strategy/unifiedElite.js"
);
const { monteCarloBootstrap, purgedWalkForwardSplits, acceptanceGates } = await import(
  "../src/backtest/engine/validation.js"
);

// ─── Shared Elite config ───────────────────────────────────────────────────────

const ELITE_BASE_CFG = {
  manualStrategy: "SUPERTREND_ELITE",
  strategyMode: "MANUAL",
  marketMode: "FUTURES",
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  supertrendWilderAtr: true,
  eliteStRequireHtf4hAlign: true,
  eliteStHtf4hPeriod: 10,
  eliteStHtf4hMultiplier: 3.0,
  eliteStRequireHtf1hEmaAlign: true,
  eliteStHtf1hMinSep: 0.0003,
  eliteStMinAdx: 0,
  eliteStRequireAdxRising: false,
  eliteStMinVolumeVsAvg: 0,
  eliteStRequireAtrExpansion: false,
  eliteStLiqSweepEnabled: false,
  trailingStopLossAuto: true,
  futuresTrailingStopMode: "SUPERTREND",
  supertrendFuturesExitOnFlip: true,
  supertrendFuturesFixedSlPct: 0,
  supertrendFuturesFixedTpPct: 0,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 5,
  riskPerTradeUnit: "PCT",
  futuresLeverage: 25,
};

const UNIFIED_FULL_CFG = {
  ...ELITE_BASE_CFG,
  manualStrategy: "UNIFIED_ELITE",
  // Only skip SQUEEZE — VOLATILE bars are high-ATR moves where Elite performs best.
  unifiedRegimeGate: true,
  unifiedRegimeGateMode: "skip_squeeze_only",
  unifiedLiqScale: true,
  unifiedLiqScaleFactor: 1.5,
  unifiedLiqLookback: 8,
  // LIQ+SR supplemental needs 15m data; disabled for 1H run (no intraday sweeps visible).
  unifiedLiqSrEnabled: false,
  unifiedLiqSrMinScore: 10,
  unifiedLiqSrRiskScale: 0.5,
  unifiedLiqSrMaxPerDay: 1,
  unifiedLiqSrKillzone: "LONDON_NY",
};

const UNIFIED_REGIME_ONLY_CFG = {
  ...UNIFIED_FULL_CFG,
  unifiedLiqScale: false,
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function buildAdapter(candles, variantKey, cfg) {
  if (variantKey === "ELITE") {
    return buildEliteStBacktestAdapter(candles, buildEliteStOptsFromCfg(cfg));
  }
  return buildUnifiedEliteBacktestAdapter(candles, buildUnifiedEliteOptsFromCfg(cfg));
}

async function runWindow(candles, funding, variantKey, cfg) {
  const adapter = buildAdapter(candles, variantKey, cfg);
  const sim = await runSimulation({
    strategyKey: variantKey === "ELITE" ? "SUPERTREND_ELITE" : "UNIFIED_ELITE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: 1000,
    timeframe: TF,
    adapters: { [variantKey === "ELITE" ? "SUPERTREND_ELITE" : "UNIFIED_ELITE"]: adapter },
    symbol: cfg.symbol,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: 1000,
  });
  return { sim, m };
}

function fundSlice(rates, start, end) {
  return rates.filter((f) => f.ts >= start && f.ts <= end);
}

// ─── Per-coin validation ───────────────────────────────────────────────────────

async function validateCoin(sym, variantKey, cfg) {
  const candles = await readCandles(sym, TF, fromMs, toMs);
  if (!candles?.length) return null;
  let funding = [];
  try { funding = await readFundingRates(sym, fromMs, toMs); } catch { /* ok */ }

  const coinCfg = { ...cfg, symbol: sym, timeframe: TF };
  const { sim, m } = await runWindow(candles, funding, variantKey, coinCfg);

  // Monte Carlo
  const rs = rMultipleStats(sim.trades);
  const mc = monteCarloBootstrap(rs.rValues, { paths: 2000, riskFrac: 0.01, ruinDrawdownPct: 50 });

  // Walk-forward
  const stepMs = candles.length > 1 ? candles[1].ts - candles[0].ts : 3_600_000;
  const embargo = Math.max(1, Math.round(86_400_000 / stepMs));
  const splits = purgedWalkForwardSplits(candles.length, { folds: 4, embargo, mode: "rolling", minTrain: 200 });
  let trainExpSum = 0, testExpSum = 0, testRetSum = 0;
  for (const s of splits) {
    const tr = candles.slice(s.trainStart, s.trainEnd);
    const te = candles.slice(s.testStart, s.testEnd);
    const ft = fundSlice(funding, tr[0]?.ts, tr.at(-1)?.ts);
    const fe = fundSlice(funding, te[0]?.ts, te.at(-1)?.ts);
    const trR = await runWindow(tr, ft, variantKey, coinCfg);
    const teR = await runWindow(te, fe, variantKey, coinCfg);
    trainExpSum += trR.m.expectancy || 0;
    testExpSum += teR.m.expectancy || 0;
    testRetSum += teR.m.totalReturnPct || 0;
  }
  const avgTrain = splits.length ? trainExpSum / splits.length : 0;
  const avgTest  = splits.length ? testExpSum  / splits.length : 0;
  const wfDeg = avgTrain !== 0 ? ((avgTrain - avgTest) / Math.abs(avgTrain)) * 100 : 100;

  return { sym, m, mc, wfDeg, testRetSum, candles: candles.length, trades: m.totalTrades };
}

// ─── Portfolio aggregation ─────────────────────────────────────────────────────

function portfolioSummary(results) {
  const valid = results.filter(Boolean);
  if (!valid.length) return null;
  const totalTrades = valid.reduce((a, r) => a + r.trades, 0);
  const sumRet = valid.reduce((a, r) => a + (r.m.totalReturnPct || 0), 0);
  const meanRet = sumRet / valid.length;
  const meanDD = valid.reduce((a, r) => a + Math.abs(r.m.maxDrawdownPct || 0), 0) / valid.length;
  const meanPF = valid.reduce((a, r) => a + (r.m.profitFactor || 0), 0) / valid.length;
  const meanCalmar = valid.reduce((a, r) => a + (r.m.calmar || 0), 0) / valid.length;
  const oosRetSum = valid.reduce((a, r) => a + r.testRetSum, 0);
  const allRs = valid.flatMap((r) => r.mc.p5ReturnPct != null ? [r.mc.p5ReturnPct] : []);
  const avgMcP5 = allRs.length ? allRs.reduce((a, b) => a + b, 0) / allRs.length : -99;
  const avgWfDeg = valid.reduce((a, r) => a + r.wfDeg, 0) / valid.length;
  return { totalTrades, meanRet, meanDD, meanPF, meanCalmar, oosRetSum, avgMcP5, avgWfDeg, n: valid.length };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

const variants = [
  { key: "ELITE",          label: "SUPERTREND_ELITE (baseline)",                   cfg: ELITE_BASE_CFG },
  { key: "UNIFIED_REGIME", label: "UNIFIED_ELITE — skip-SQUEEZE gate only",        cfg: UNIFIED_REGIME_ONLY_CFG },
  { key: "UNIFIED_FULL",   label: "UNIFIED_ELITE — skip-SQUEEZE + liq 1.5× scale", cfg: UNIFIED_FULL_CFG },
];

console.log(
  `\n=== UNIFIED_ELITE PORTFOLIO BACKTEST ===\n` +
  `Coins: ${COINS.join(", ")} | TF: ${TF} | Window: ${new Date(fromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)}\n`,
);

for (const v of variants) {
  console.log(`\n${"─".repeat(72)}\n  ${v.label}\n${"─".repeat(72)}`);
  console.log(`  coin       n    ret%   PF    DD%  Calmar  OOS%   MC-p5%  WFdeg%`);
  const coinResults = [];
  for (const sym of COINS) {
    process.stdout.write(`  ${sym.padEnd(9)} `);
    const r = await validateCoin(sym, v.key, v.cfg);
    coinResults.push(r);
    if (!r) { console.log("(no data)"); continue; }
    console.log(
      `${String(r.trades).padStart(3)}  ${(r.m.totalReturnPct||0).toFixed(1).padStart(6)}` +
      ` ${(r.m.profitFactor||0).toFixed(2).padStart(5)}` +
      ` ${Math.abs(r.m.maxDrawdownPct||0).toFixed(1).padStart(5)}` +
      ` ${(r.m.calmar||0).toFixed(2).padStart(7)}` +
      ` ${r.testRetSum.toFixed(1).padStart(6)}` +
      ` ${r.mc.insufficient ? "  insuf" : r.mc.p5ReturnPct.toFixed(1).padStart(7)}` +
      ` ${r.wfDeg.toFixed(0).padStart(6)}%`,
    );
  }
  const port = portfolioSummary(coinResults);
  if (port) {
    console.log(`\n  PORTFOLIO (${port.n} coins, ${port.totalTrades} trades total):`);
    console.log(`    mean ret/coin ${port.meanRet.toFixed(1)}%  mean DD ${port.meanDD.toFixed(1)}%  mean PF ${port.meanPF.toFixed(2)}  mean Calmar ${port.meanCalmar.toFixed(2)}`);
    console.log(`    OOS sum ret ${port.oosRetSum.toFixed(1)}%  avg MC-p5 ${port.avgMcP5.toFixed(1)}%  avg WF-deg ${port.avgWfDeg.toFixed(0)}%`);

    const gate = acceptanceGates({
      oosReturnPct: port.oosRetSum,
      mcP5ReturnPct: port.avgMcP5,
      calmar: port.meanCalmar,
      walkForwardDegradationPct: port.avgWfDeg,
    });
    console.log(`\n    ACCEPTANCE GATES:`);
    for (const [name, g] of Object.entries(gate.gates)) {
      console.log(`    ${g.pass ? "PASS" : "FAIL"}  ${name.padEnd(20)} ${Number(g.value).toFixed(2)}  (need ${g.threshold})`);
    }
    console.log(`    VERDICT: ${gate.allPass ? "ACCEPTED ✅" : "REJECTED ❌"}`);
  }
}

await closePool();
console.log("\nDone.");
