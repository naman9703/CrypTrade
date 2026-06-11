#!/usr/bin/env node
/**
 * Multi-coin SUPERTREND_ELITE portfolio — walk-forward + Monte Carlo + acceptance gates.
 *
 * Usage:
 *   node scripts/backtest-validate-portfolio-elite.mjs
 *   SYMBOLS=BTCUSDT,BNBUSDT,SOLUSDT TF=1h FROM=2025-06-01 TO=2026-06-10 RISK_PCT=10 node scripts/backtest-validate-portfolio-elite.mjs
 *   USE_FIXED_SL=1 FIXED_SL_PCT=0.002 node scripts/backtest-validate-portfolio-elite.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,BNBUSDT,SOLUSDT").split(",").map((s) => s.trim()).filter(Boolean);
const TF = process.env.TF || "1h";
const FROM = process.env.FROM || "2025-06-01";
const TO = process.env.TO || "2026-06-10";
const START_USDT = Number(process.env.START_USDT || 100);
const RISK_PCT = Number(process.env.RISK_PCT || 10);
const LEVERAGE = Number(process.env.LEVERAGE || 25);
const USE_FIXED_SL = process.env.USE_FIXED_SL === "1" || process.env.USE_FIXED_SL === "true";
const FIXED_SL_PCT = Number(process.env.FIXED_SL_PCT || 0.002);
const USE_FIXED_TP = process.env.USE_FIXED_TP === "1" || process.env.USE_FIXED_TP === "true";
const FIXED_TP_PCT = Number(process.env.FIXED_TP_PCT || 0.015);
const WF_FOLDS = Number(process.env.WF_FOLDS || 4);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { normalizeEliteStRunCfg } = await import("../src/strategy/supertrendElite.js");
const { ensureBacktestMarketMode, applyInstanceOperationalToBot } = await import("../src/lib/strategyInstanceSplit.js");
const { portfolioReplay, tradesToREvents } = await import("../src/backtest/engine/portfolioReplay.js");
const { monteCarloBootstrap, purgedWalkForwardSplits, acceptanceGates } = await import(
  "../src/backtest/engine/validation.js",
);

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();
const fmt = (n, d = 2) => (Number.isFinite(n) ? Number(n).toFixed(d) : "—");

const snapQ = await pool.query(
  `SELECT config_snapshot, instance_operational_snapshot
     FROM backtest_runs WHERE is_portfolio = true AND status = 'done'
     ORDER BY created_at DESC LIMIT 1`,
);
const snapRow = snapQ.rows[0];
const baseBot =
  snapRow?.config_snapshot?.bot && typeof snapRow.config_snapshot.bot === "object"
    ? { ...snapRow.config_snapshot.bot }
    : snapRow?.config_snapshot && typeof snapRow.config_snapshot === "object"
      ? { ...snapRow.config_snapshot }
      : null;

function buildCfg(sym) {
  const raw = ensureBacktestMarketMode({
    ...(baseBot || {}),
    symbol: sym,
    timeframe: TF,
    manualStrategy: "SUPERTREND_ELITE",
    strategyMode: "MANUAL",
    supertrendFuturesAuto: false,
    supertrendSpotAuto: false,
    futuresLeverage: LEVERAGE,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: RISK_PCT,
    riskPerTradeUnit: "PCT",
    slippagePct: 0.0005,
    supertrendFuturesUseFixedSl: USE_FIXED_SL,
    supertrendFuturesFixedSlPct: USE_FIXED_SL ? FIXED_SL_PCT : 0,
    supertrendFuturesUseFixedTp: USE_FIXED_TP,
    supertrendFuturesFixedTpPct: USE_FIXED_TP ? FIXED_TP_PCT : 0,
    _intradayEngineMaterialized: true,
  });
  if (snapRow?.instance_operational_snapshot) {
    applyInstanceOperationalToBot(raw, snapRow.instance_operational_snapshot);
  }
  return normalizeEliteStRunCfg(raw);
}

async function loadCoinData(sym) {
  const candles = await readCandles(sym, TF, fromMs, toMs);
  if (!candles?.length) return null;
  let funding = [];
  try {
    funding = await readFundingRates(sym, fromMs, toMs);
  } catch {
    funding = [];
  }
  return { candles, funding };
}

async function runPortfolioWindow({ coinData, cfgBySym, sliceFromMs, sliceToMs, startingUsdt }) {
  const events = [];
  for (const sym of SYMBOLS) {
    const pack = coinData[sym];
    if (!pack) continue;
    const slice = pack.candles.filter((c) => c.ts >= sliceFromMs && c.ts < sliceToMs);
    if (slice.length < 120) continue;
    const fund = pack.funding.filter((f) => {
      const t = new Date(f.ts ?? f.time ?? f.fundingTime).getTime();
      return t >= sliceFromMs && t < sliceToMs;
    });
    const cfg = cfgBySym[sym];
    const adapters = await buildBacktestAdapters({
      strategyKey: "SUPERTREND_ELITE",
      cfg,
      symbol: sym,
      tf: TF,
      candles: slice,
      fromMs: sliceFromMs,
    });
    const sim = await runSimulation({
      strategyKey: "SUPERTREND_ELITE",
      candles: slice,
      cfg,
      gateMode: "off",
      fundingRates: fund,
      startingUsdt: 1000,
      timeframe: TF,
      adapters,
      symbol: sym,
    });
    events.push(...tradesToREvents(sym, sim.trades, RISK_PCT));
  }
  const replay = portfolioReplay({
    events,
    startingUsdt,
    riskFrac: RISK_PCT / 100,
    startTs: sliceFromMs,
  });
  const m = computeAllMetrics({
    trades: replay.trades,
    equityCurve: replay.equityCurve,
    tf: TF,
    startingEquity: startingUsdt,
  });
  return { replay, m, events };
}

const coinData = {};
const cfgBySym = {};
for (const sym of SYMBOLS) {
  const pack = await loadCoinData(sym);
  if (!pack) {
    console.log(`[skip] ${sym}: no candles`);
    continue;
  }
  coinData[sym] = pack;
  cfgBySym[sym] = buildCfg(sym);
}

const activeSyms = Object.keys(coinData);
if (!activeSyms.length) {
  console.error("No candle data for any symbol");
  process.exit(1);
}

// Reference bar index timeline from first symbol
const refCandles = coinData[activeSyms[0]].candles;
const stepMs = refCandles.length > 1 ? refCandles[1].ts - refCandles[0].ts : 3_600_000;
const embargo = Math.max(1, Math.round(86_400_000 / stepMs));

console.log(`\n=== PORTFOLIO VALIDATION — SUPERTREND_ELITE ===`);
console.log(`Config: ${baseBot ? "instance snapshot (latest portfolio run)" : "fallback minimal"}`);
console.log(`Coins: ${activeSyms.join(", ")}  TF: ${TF}  ${FROM} → ${TO}`);
console.log(
  `Risk: ${RISK_PCT}%  SL: ${USE_FIXED_SL ? `${(FIXED_SL_PCT * 100).toFixed(2)}%` : "off"}  TP: ${USE_FIXED_TP ? `${(FIXED_TP_PCT * 100).toFixed(2)}%` : "off"}`,
);
console.log(`Bars (ref ${activeSyms[0]}): ${refCandles.length}  embargo: ${embargo} bars\n`);

// Full window
const full = await runPortfolioWindow({
  coinData,
  cfgBySym,
  sliceFromMs: fromMs,
  sliceToMs: toMs,
  startingUsdt: START_USDT,
});

const rstats = rMultipleStats(full.replay.trades);
const mc = monteCarloBootstrap(rstats.rValues, {
  paths: 3000,
  riskFrac: RISK_PCT / 100,
  ruinDrawdownPct: 50,
});

console.log(`── Full window (in-sample reference) ──`);
console.log(
  `Trades: ${full.m.totalTrades}  WR: ${fmt((full.m.winRate || 0) * 100, 1)}%  PF: ${fmt(full.m.profitFactor, 2)}`,
);
console.log(
  `Return: ${fmt(full.m.totalReturnPct)}%  CAGR: ${fmt(full.m.cagrPct)}%  MaxDD: ${fmt(full.m.maxDrawdownPct)}%  Calmar: ${fmt(full.m.calmar, 2)}`,
);
console.log(`Final: $${fmt(full.m.finalEquity, 2)}  Expectancy/trade: $${fmt(full.m.expectancy, 2)}`);
if (!mc.insufficient) {
  console.log(
    `MC (${RISK_PCT}% risk/trade): p5=${fmt(mc.p5ReturnPct)}%  p50=${fmt(mc.p50ReturnPct)}%  p95=${fmt(mc.p95ReturnPct)}%  ruin≥50%DD=${fmt(mc.riskOfRuinPct, 1)}%`,
  );
} else {
  console.log(`MC: insufficient trades (${rstats.rCount})`);
}

// Walk-forward on bar timeline
const splits = purgedWalkForwardSplits(refCandles.length, {
  folds: WF_FOLDS,
  embargo,
  mode: "rolling",
  minTrain: Math.min(300, Math.floor(refCandles.length * 0.2)),
});

let trainExp = 0;
let testExp = 0;
let testRet = 0;
let testTrades = 0;

console.log(`\n── Walk-forward (${splits.length} folds, purged embargo=${embargo}) ──`);
for (const s of splits) {
  const trainFrom = refCandles[s.trainStart].ts;
  const trainTo = refCandles[Math.min(s.trainEnd, refCandles.length - 1)].ts;
  const testFrom = refCandles[s.testStart].ts;
  const testTo = refCandles[Math.min(s.testEnd - 1, refCandles.length - 1)].ts;

  const tr = await runPortfolioWindow({
    coinData,
    cfgBySym,
    sliceFromMs: trainFrom,
    sliceToMs: trainTo + stepMs,
    startingUsdt: START_USDT,
  });
  const te = await runPortfolioWindow({
    coinData,
    cfgBySym,
    sliceFromMs: testFrom,
    sliceToMs: testTo + stepMs,
    startingUsdt: START_USDT,
  });
  trainExp += tr.m.expectancy || 0;
  testExp += te.m.expectancy || 0;
  testRet += te.m.totalReturnPct || 0;
  testTrades += te.m.totalTrades || 0;
  console.log(
    `  fold ${s.fold}: train[n=${tr.m.totalTrades} exp=$${fmt(tr.m.expectancy, 2)} ret=${fmt(tr.m.totalReturnPct)}%] ` +
      `test[n=${te.m.totalTrades} ret=${fmt(te.m.totalReturnPct)}% PF=${fmt(te.m.profitFactor, 2)} DD=${fmt(te.m.maxDrawdownPct)}%]`,
  );
}

const avgTr = splits.length ? trainExp / splits.length : 0;
const avgTe = splits.length ? testExp / splits.length : 0;
const wfDeg = avgTr !== 0 ? ((avgTr - avgTe) / Math.abs(avgTr)) * 100 : 100;

const gate = acceptanceGates({
  oosReturnPct: testRet,
  mcP5ReturnPct: mc.insufficient ? -1 : mc.p5ReturnPct,
  calmar: full.m.calmar ?? -1,
  walkForwardDegradationPct: wfDeg,
});

console.log(`\n── Acceptance gates ──`);
for (const [k, g] of Object.entries(gate.gates)) {
  console.log(`  ${g.pass ? "✅" : "❌"} ${k}: ${fmt(g.value, 2)} (need ${g.threshold})`);
}
console.log(`\n  → ${gate.allPass ? "ACCEPTED ✅" : "REJECTED ❌"}`);

// Minimum expectation framing
const months =
  refCandles.length > 1
    ? (refCandles[refCandles.length - 1].ts - refCandles[0].ts) / (30.44 * 86400000)
    : 0;
const monthlyFromCagr =
  full.m.cagrPct != null && Number.isFinite(full.m.cagrPct)
    ? (Math.pow(1 + full.m.cagrPct / 100, 1 / 12) - 1) * 100
    : months > 0
      ? (Math.pow(full.m.finalEquity / START_USDT, 1 / months) - 1) * 100
      : 0;

console.log(`\n── Minimum expectation (conservative framing) ──`);
console.log(`  Span: ~${fmt(months, 1)} months  |  OOS test-window sum return: ${fmt(testRet)}%`);
if (!mc.insufficient) {
  console.log(`  Floor (MC 5th pct): ~${fmt(mc.p5ReturnPct)}% total over full window at ${RISK_PCT}% risk/trade`);
  const mcMonthlyFloor = months > 0 ? (Math.pow(1 + mc.p5ReturnPct / 100, 1 / months) - 1) * 100 : 0;
  console.log(`  Floor (~monthly): ~${fmt(mcMonthlyFloor, 2)}%/mo if trade mix resembles bootstrap`);
}
console.log(`  Median (MC 50th): ~${fmt(mc.p50ReturnPct)}% total`);
console.log(`  Full-window CAGR (not a floor): ${fmt(full.m.cagrPct)}% (~${fmt(monthlyFromCagr, 2)}%/mo)`);
console.log(`  Honest deploy band if gates pass: plan for MC p5 / OOS, not full-window headline %`);

await closePool?.();
