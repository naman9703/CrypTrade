#!/usr/bin/env node
/**
 * Trustworthy-validation harness for the REGIME_ADAPTIVE strategy.
 *
 * Runs the real backtest adapter (regime engine -> one playbook per regime,
 * structure brackets, A/B grade, killzones, 2-3 trades/day) through:
 *   1) full-window backtest with per-regime PnL attribution
 *   2) Monte Carlo bootstrap on trade R-multiples (risk-of-ruin)
 *   3) purged walk-forward with embargo (out-of-sample degradation)
 *   4) acceptance gates (OOS > 0, MC p5 > 0, Calmar > 1, WF degradation < 35%)
 *
 * Runs across multiple coins and prints a combined report.
 *
 * Usage:
 *   node scripts/backtest-validate-regime.mjs                      # BTC+ETH 15m, Jan-May 2026
 *   SYMBOLS=BTCUSDT,ETHUSDT,BNBUSDT TF=15m node scripts/backtest-validate-regime.mjs
 *   RISK_SCALE=1.5 MIN_GRADE=B node scripts/backtest-validate-regime.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT").split(",").map((s) => s.trim()).filter(Boolean);
const TF = process.env.TF || "15m";
const fromMs = new Date(process.env.FROM || "2026-01-01").getTime();
const toMs = new Date(process.env.TO || "2026-05-18").getTime();
const START_USDT = Number(process.env.START_USDT || 1000);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const { buildRegimeAdaptiveBacktestAdapter } = await import("../src/strategy/regimeAdaptive.js");
const { monteCarloBootstrap, purgedWalkForwardSplits, acceptanceGates } = await import(
  "../src/backtest/engine/validation.js"
);

// Strategy + risk config (overridable via env so we can sweep without code edits).
const cfg = {
  marketMode: "FUTURES",
  futuresLeverage: Number(process.env.LEVERAGE || 10),
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: Number(process.env.RISK_PCT || 1.0),
  riskPerTradeUnit: "PCT",
  slippagePct: Number(process.env.SLIPPAGE || 0.0005),
  // Strategy knobs.
  regimeAdaptiveEnableTrend: true,
  regimeAdaptiveEnableRange: true,
  regimeAdaptiveEnableBreakout: true,
  regimeAdaptiveMinGrade: process.env.MIN_GRADE || "A",
  regimeAdaptiveConfidenceFloor: Number(process.env.CONF_FLOOR || 0.45),
  regimeAdaptiveMaxTradesPerDay: Number(process.env.MAX_TRADES || 2),
  regimeAdaptiveMinBarGap: Number(process.env.MIN_GAP || 8),
  regimeAdaptiveKillzoneMode: process.env.KILLZONE || "LONDON_NY",
  regimeAdaptiveTrendRR: Number(process.env.TREND_RR || 2.0),
  regimeAdaptiveRangeRR: Number(process.env.RANGE_RR || 1.5),
  regimeAdaptiveBreakoutRR: Number(process.env.BREAKOUT_RR || 2.0),
  regimeAdaptiveAtrSlMult: Number(process.env.ATR_SL || 1.1),
  // Risk overlay.
  riskScale: Number(process.env.RISK_SCALE || 1),
  volTargetSizing: process.env.VOL_TARGET === "1",
  riskKillSwitchDdPct: Number(process.env.KILL_DD || 0),
  riskConsecutiveLossLimit: Number(process.env.CONSEC_LOSS || 0),
  riskWeeklyMaxLossPct: Number(process.env.WEEKLY_DD || 0),
};

const STRAT = "REGIME_ADAPTIVE";

async function runWindow(symbol, slice, fundSlice) {
  const adapter = buildRegimeAdaptiveBacktestAdapter(slice, cfg, TF);
  const sim = await runSimulation({
    strategyKey: STRAT,
    candles: slice,
    cfg: { ...cfg, symbol },
    gateMode: "off",
    fundingRates: fundSlice,
    startingUsdt: START_USDT,
    timeframe: TF,
    adapters: { [STRAT]: adapter },
    symbol,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: START_USDT });
  return { sim, m };
}

function regimeAttribution(trades) {
  const byRegime = {};
  for (const t of trades) {
    if (t.exitReason === "tp1_partial") continue;
    const r = t.regime || "UNKNOWN";
    byRegime[r] = byRegime[r] || { n: 0, wins: 0, net: 0 };
    byRegime[r].n++;
    if (Number(t.netPnl ?? 0) > 0) byRegime[r].wins++;
    byRegime[r].net += Number(t.netPnl ?? 0);
  }
  return byRegime;
}

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

console.log(`\n=== REGIME_ADAPTIVE validation — ${SYMBOLS.join(", ")} ${TF} ===`);
console.log(`window ${new Date(fromMs).toISOString().slice(0, 10)} -> ${new Date(toMs).toISOString().slice(0, 10)}  ` +
  `riskScale=${cfg.riskScale} minGrade=${cfg.regimeAdaptiveMinGrade} maxTrades/day=${cfg.regimeAdaptiveMaxTradesPerDay} ` +
  `confFloor=${cfg.regimeAdaptiveConfidenceFloor} killzone=${cfg.regimeAdaptiveKillzoneMode}\n`);

const aggRegime = {};
let acceptCount = 0;

for (const sym of SYMBOLS) {
  const candles = await readCandles(sym, TF, fromMs, toMs);
  if (!candles?.length) {
    console.log(`[skip] ${sym}: no candles in DB`);
    continue;
  }
  let fundingRates = [];
  try {
    fundingRates = await readFundingRates(sym, fromMs, toMs);
  } catch {
    fundingRates = [];
  }

  console.log(`\n────────── ${sym} (${candles.length} bars) ──────────`);
  const { sim, m } = await runWindow(sym, candles, fundingRates);
  console.log(
    `full: trades=${m.totalTrades} WR=${((m.winRate || 0) * 100).toFixed(0)}% net=${m.totalReturnPct.toFixed(1)}% ` +
      `CAGR=${(m.cagrPct || 0).toFixed(1)}% Calmar=${(m.calmar ?? 0).toFixed(2)} maxDD=${m.maxDrawdownPct.toFixed(1)}% ` +
      `Sharpe=${(m.sharpe || 0).toFixed(2)} PF=${(m.profitFactor || 0).toFixed(2)} expR=${(m.expectancyR || 0).toFixed(3)}`,
  );

  // Per-regime attribution.
  const byReg = regimeAttribution(sim.trades);
  for (const [reg, v] of Object.entries(byReg)) {
    aggRegime[reg] = aggRegime[reg] || { n: 0, wins: 0, net: 0 };
    aggRegime[reg].n += v.n;
    aggRegime[reg].wins += v.wins;
    aggRegime[reg].net += v.net;
  }
  const regLine = Object.entries(byReg)
    .map(([r, v]) => `${r}: $${v.net.toFixed(0)}/${v.n}/${((v.wins / v.n) * 100).toFixed(0)}%`)
    .join("  ");
  console.log(`  by-regime (net/n/wr): ${regLine || "—"}`);

  // Monte Carlo.
  const rstats = rMultipleStats(sim.trades);
  const mc = monteCarloBootstrap(rstats.rValues, { paths: 3000, riskFrac: 0.01, ruinDrawdownPct: 50 });
  if (mc.insufficient) {
    console.log(`  MC: insufficient trades (${rstats.rCount})`);
  } else {
    console.log(
      `  MC(1% risk): ret p5=${mc.p5ReturnPct.toFixed(1)}% p50=${mc.p50ReturnPct.toFixed(1)}% p95=${mc.p95ReturnPct.toFixed(1)}%  ` +
        `maxDD p95=${mc.p95MaxDdPct.toFixed(1)}%  ruin(>=50%)=${mc.riskOfRuinPct.toFixed(1)}%`,
    );
  }

  // Purged walk-forward.
  const stepMs = candles.length > 1 ? candles[1].ts - candles[0].ts : 900_000;
  const embargo = Math.max(1, Math.round(86_400_000 / stepMs));
  const splits = purgedWalkForwardSplits(candles.length, { folds: 4, embargo, mode: "rolling", minTrain: 300 });
  let trainExpSum = 0;
  let testExpSum = 0;
  let testRetSum = 0;
  for (const s of splits) {
    const trainSlice = candles.slice(s.trainStart, s.trainEnd);
    const testSlice = candles.slice(s.testStart, s.testEnd);
    const ft = fundingRates.filter((f) => f.ts >= trainSlice[0]?.ts && f.ts <= trainSlice[trainSlice.length - 1]?.ts);
    const fe = fundingRates.filter((f) => f.ts >= testSlice[0]?.ts && f.ts <= testSlice[testSlice.length - 1]?.ts);
    const tr = await runWindow(sym, trainSlice, ft);
    const te = await runWindow(sym, testSlice, fe);
    trainExpSum += tr.m.expectancy || 0;
    testExpSum += te.m.expectancy || 0;
    testRetSum += te.m.totalReturnPct || 0;
    console.log(
      `    WF fold ${s.fold}: train[n=${padL(tr.m.totalTrades, 3)} exp=$${(tr.m.expectancy || 0).toFixed(2)}] ` +
        `test[n=${padL(te.m.totalTrades, 3)} ret=${(te.m.totalReturnPct || 0).toFixed(1)}% exp=$${(te.m.expectancy || 0).toFixed(2)} PF=${(te.m.profitFactor || 0).toFixed(2)}]`,
    );
  }
  const avgTrainExp = splits.length ? trainExpSum / splits.length : 0;
  const avgTestExp = splits.length ? testExpSum / splits.length : 0;
  const wfDeg = avgTrainExp !== 0 ? ((avgTrainExp - avgTestExp) / Math.abs(avgTrainExp)) * 100 : 100;
  console.log(`  WF: avgTrainExp=$${avgTrainExp.toFixed(2)} avgTestExp=$${avgTestExp.toFixed(2)} degradation=${wfDeg.toFixed(1)}% OOSsumRet=${testRetSum.toFixed(1)}%`);

  const gate = acceptanceGates({
    oosReturnPct: testRetSum,
    mcP5ReturnPct: mc.insufficient ? -1 : mc.p5ReturnPct,
    calmar: m.calmar ?? -1,
    walkForwardDegradationPct: wfDeg,
  });
  const gateStr = Object.entries(gate.gates)
    .map(([name, g]) => `${g.pass ? "✅" : "❌"}${name}`)
    .join(" ");
  console.log(`  GATES: ${gateStr}  -> ${gate.allPass ? "ACCEPTED ✅" : "REJECTED ❌"}`);
  if (gate.allPass) acceptCount++;
}

// Combined per-regime report.
console.log(`\n========== COMBINED PER-REGIME (net / trades / winrate) ==========`);
console.log(`${pad("regime", 16)}${padL("net$", 12)}${padL("trades", 10)}${padL("winrate", 10)}`);
for (const [reg, v] of Object.entries(aggRegime)) {
  console.log(`${pad(reg, 16)}${padL("$" + v.net.toFixed(0), 12)}${padL(v.n, 10)}${padL(((v.wins / v.n) * 100).toFixed(0) + "%", 10)}`);
}
console.log(`\n${acceptCount}/${SYMBOLS.length} symbols ACCEPTED by gates.\n`);

await closePool?.();
