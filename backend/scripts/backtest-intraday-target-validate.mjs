#!/usr/bin/env node
/**
 * Validate the selected intraday target candidate:
 * 12-symbol SUPERTREND_ELITE 1H portfolio, normalized risk, shared-account replay.
 *
 * Usage:
 *   SYMBOLS=BTCUSDT,... FROM=2025-01-01 TO=2026-06-01 RISK_PCT=2 node scripts/backtest-intraday-target-validate.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT,LINKUSDT,XRPUSDT,SOLUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,UNIUSDT,LTCUSDT,DOTUSDT")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TF = process.env.TF || "1h";
const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-06-01";
const START = Number(process.env.START_USDT || 1000);
const RISK = Number(process.env.RISK_PCT || 2);
const TARGET_MIN = Number(process.env.TARGET_MIN || 1);
const TARGET_MAX = Number(process.env.TARGET_MAX || 2);
const WF_FOLDS = Number(process.env.WF_FOLDS || 4);
const VARIANT = String(process.env.VARIANT || "base").toLowerCase();
const USE_MICRO = process.env.USE_MICRO === "1" || process.env.USE_MICRO === "true";
const MICRO_PRICE_SOURCE = String(process.env.MICRO_PRICE_SOURCE || "mark").toLowerCase() === "trade" ? "trade" : "mark";
const TRAILING_OVERRIDE =
  process.env.TRAILING === "1" || process.env.TRAILING === "true"
    ? true
    : process.env.TRAILING === "0" || process.env.TRAILING === "false"
      ? false
      : null;
const FIXED_SL_OVERRIDE = process.env.FIXED_SL_PCT != null ? Number(process.env.FIXED_SL_PCT) : null;
const FIXED_TP_OVERRIDE = process.env.FIXED_TP_PCT != null ? Number(process.env.FIXED_TP_PCT) : null;
const MIN_ADX_OVERRIDE = process.env.MIN_ADX != null ? Number(process.env.MIN_ADX) : null;
const REQUIRE_ADX_RISING_OVERRIDE =
  process.env.REQUIRE_ADX_RISING === "1" || process.env.REQUIRE_ADX_RISING === "true"
    ? true
    : process.env.REQUIRE_ADX_RISING === "0" || process.env.REQUIRE_ADX_RISING === "false"
      ? false
      : null;

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
  console.error("Invalid FROM/TO");
  process.exit(1);
}

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { portfolioSliceReplay, resolveTradeRiskUsd } = await import("../src/backtest/engine/portfolioReplay.js");
const { monteCarloBootstrap, purgedWalkForwardSplits, acceptanceGates } = await import("../src/backtest/engine/validation.js");
const {
  SUPERTREND_ELITE_1H_PRESET,
  SUPERTREND_ELITE_1H_ADX_PRESET,
  SUPERTREND_ELITE_AUTO_1H_PRESET,
} = await import("../src/strategy/presets/supertrendEliteOptimized.js");

const COMMON = {
  marketMode: "FUTURES",
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: RISK,
  riskPerTradeUnit: "PCT",
  slippagePct: 0.0005,
  tradeHistoryTakerOpenFeeRate: 0.0004,
  tradeHistoryTakerCloseFeeRate: 0.0004,
  futuresLeverage: 12,
};

const SELECTED_PRESET =
  VARIANT === "adx"
    ? SUPERTREND_ELITE_1H_ADX_PRESET
    : VARIANT === "auto"
      ? SUPERTREND_ELITE_AUTO_1H_PRESET
      : SUPERTREND_ELITE_1H_PRESET;

const QUALITY_PATCH = {
  ...(Number.isFinite(MIN_ADX_OVERRIDE) ? { eliteStMinAdx: MIN_ADX_OVERRIDE } : {}),
  ...(REQUIRE_ADX_RISING_OVERRIDE != null ? { eliteStRequireAdxRising: REQUIRE_ADX_RISING_OVERRIDE } : {}),
  ...(TRAILING_OVERRIDE != null
    ? {
        trailingStopLossAuto: TRAILING_OVERRIDE,
        futuresTrailingStopMode: TRAILING_OVERRIDE ? "SUPERTREND" : "OFF",
        supertrendFuturesExitOnFlip: TRAILING_OVERRIDE,
      }
    : {}),
  ...(Number.isFinite(FIXED_SL_OVERRIDE) ? { supertrendFuturesFixedSlPct: FIXED_SL_OVERRIDE } : {}),
  ...(Number.isFinite(FIXED_TP_OVERRIDE) ? { supertrendFuturesFixedTpPct: FIXED_TP_OVERRIDE } : {}),
};

function tradesToLogicalEntryEvents(symbol, trades) {
  const byEntry = new Map();
  for (const t of trades || []) {
    const entryTs = Number(t.entryTs || 0);
    const direction = String(t.direction || t.side || "");
    const key = `${entryTs}:${direction}`;
    if (!byEntry.has(key)) {
      byEntry.set(key, {
        symbol,
        entryTs,
        exitTs: Number(t.exitTs || entryTs),
        direction,
        rawTrade: { ...t, symbol, netPnl: 0, grossPnl: 0, fees: 0, fundingPaid: 0, slippageCost: 0 },
        riskUsd: 0,
      });
    }
    const row = byEntry.get(key);
    row.exitTs = Math.max(row.exitTs, Number(t.exitTs || row.exitTs));
    row.rawTrade.exitTs = row.exitTs;
    row.rawTrade.netPnl += Number(t.netPnl || 0);
    row.rawTrade.grossPnl += Number(t.grossPnl || 0);
    row.rawTrade.fees += Number(t.fees || 0);
    row.rawTrade.fundingPaid += Number(t.fundingPaid || 0);
    row.rawTrade.slippageCost += Number(t.slippageCost || 0);
    row.riskUsd += Math.max(0, resolveTradeRiskUsd(t, RISK));
  }
  return [...byEntry.values()]
    .filter((row) => Number.isFinite(row.entryTs) && row.entryTs > 0)
    .map((row) => {
      row.rawTrade.initialRiskUsd = row.riskUsd || resolveTradeRiskUsd(row.rawTrade, RISK);
      return {
        timeline: { ts: row.exitTs, symbol, rawTrade: row.rawTrade },
        r: {
          ts: row.exitTs,
          symbol,
          R: row.rawTrade.initialRiskUsd > 0 ? Number(row.rawTrade.netPnl || 0) / row.rawTrade.initialRiskUsd : 0,
          rawTrade: row.rawTrade,
        },
      };
    });
}

function cfgFor(symbol) {
  return {
    ...SELECTED_PRESET,
    ...QUALITY_PATCH,
    ...COMMON,
    symbol,
    timeframe: TF,
    manualStrategy: "SUPERTREND_ELITE",
    strategyMode: "MANUAL",
  };
}

const coinData = {};
for (const symbol of SYMBOLS) {
  const candles = await readCandles(symbol, TF, fromMs, toMs, { market: "futures" });
  if (!candles?.length) {
    console.log(`[skip] ${symbol}: no ${TF} candles`);
    continue;
  }
  let funding = [];
  try {
    funding = await readFundingRates(symbol, fromMs, toMs);
  } catch {
    funding = [];
  }
  coinData[symbol] = { candles, funding };
}

const activeSymbols = Object.keys(coinData);
if (!activeSymbols.length) {
  console.error("No active symbols");
  process.exit(1);
}

async function runPortfolioWindow(sliceFromMs, sliceToMs) {
  const events = [];
  const rEvents = [];
  const perSymbol = {};
  for (const symbol of activeSymbols) {
    const pack = coinData[symbol];
    const candles = pack.candles.filter((c) => c.ts >= sliceFromMs && c.ts < sliceToMs);
    if (candles.length < 120) continue;
    const funding = pack.funding.filter((f) => {
      const ts = Number(f.ts ?? f.fundingTime ?? f.time);
      return Number.isFinite(ts) && ts >= sliceFromMs && ts < sliceToMs;
    });
    const cfg = cfgFor(symbol);
    const adapters = await buildBacktestAdapters({
      strategyKey: "SUPERTREND_ELITE",
      cfg,
      symbol,
      tf: TF,
      candles,
      fromMs: sliceFromMs,
    });
    let trailMicro = null;
    if (USE_MICRO && cfg.trailingStopLossAuto === true) {
      const { buildTrailMicroContext } = await import("../src/backtest/engine/trailMicroSim.js");
      trailMicro = await buildTrailMicroContext({
        symbol,
        fromMs: sliceFromMs,
        toMs: sliceToMs,
        cfg: { ...cfg, backtestTrailMicroTf: "1m", backtestTrailPriceSource: MICRO_PRICE_SOURCE },
        trailEnabled: true,
      });
    }
    const sim = await runSimulation({
      strategyKey: "SUPERTREND_ELITE",
      candles,
      cfg,
      gateMode: "off",
      fundingRates: funding,
      startingUsdt: START,
      timeframe: TF,
      adapters,
      symbol,
      trailMicro,
    });
    const symbolEvents = tradesToLogicalEntryEvents(symbol, sim.trades);
    events.push(...symbolEvents.map((e) => e.timeline));
    rEvents.push(...symbolEvents.map((e) => e.r));
    perSymbol[symbol] = { events: symbolEvents.length };
  }
  const replay = portfolioSliceReplay({
    events,
    startingUsdt: START,
    coinCount: activeSymbols.length,
    startTs: sliceFromMs,
  });
  const metrics = computeAllMetrics({
    trades: replay.trades,
    equityCurve: replay.equityCurve,
    tf: TF,
    startingEquity: START,
  });
  return { events, rEvents, replay, metrics, perSymbol };
}

const ref = coinData[activeSymbols[0]].candles;
const stepMs = ref.length > 1 ? ref[1].ts - ref[0].ts : 3_600_000;
const embargo = Math.max(1, Math.round(86_400_000 / stepMs));
const calendarDays = Math.max(1, (toMs - fromMs) / 86_400_000);
const fmt = (n, d = 2) => (Number.isFinite(n) ? Number(n).toFixed(d) : "--");

console.log(`\n=== INTRADAY TARGET VALIDATION: SUPERTREND_ELITE 1H PORTFOLIO ===`);
console.log(`symbols=${activeSymbols.join(",")} ${FROM}->${TO} risk=${RISK}% target=${TARGET_MIN}-${TARGET_MAX} entries/day`);
console.log(`Variant: ${VARIANT}`);
console.log(`Micro trailing: ${USE_MICRO ? `ON (1m ${MICRO_PRICE_SOURCE} replay)` : "OFF"}`);
if (Object.keys(QUALITY_PATCH).length) console.log(`Quality override: ${JSON.stringify(QUALITY_PATCH)}`);
console.log(`Config: 1H ST p10/m3 + 4H ST align + 1H EMA align + fixed 0.2% SL / 1.5% TP + ST trail\n`);

const full = await runPortfolioWindow(fromMs, toMs);
const entriesPerDay = full.events.length / calendarDays;
const rValues = full.rEvents.map((e) => Number(e.R)).filter(Number.isFinite);
const portfolioRiskFrac = RISK / 100 / activeSymbols.length;
const mc = monteCarloBootstrap(rValues, { paths: 3000, riskFrac: portfolioRiskFrac, ruinDrawdownPct: 50 });

console.log(`Full shared-account replay:`);
console.log(
  `  trades=${full.metrics.totalTrades} entries/day=${fmt(entriesPerDay)} WR=${fmt((full.metrics.winRate || 0) * 100, 1)}% PF=${fmt(full.metrics.profitFactor, 2)}`,
);
console.log(
  `  return=${fmt(full.metrics.totalReturnPct)}% CAGR=${fmt(full.metrics.cagrPct)}% maxDD=${fmt(full.metrics.maxDrawdownPct)}% Calmar=${fmt(full.metrics.calmar, 2)} final=$${fmt(full.metrics.finalEquity, 2)}`,
);
if (full.replay?.perCoin && Object.keys(full.replay.perCoin).length) {
  console.log("  Per-symbol contribution:");
  for (const [symbol, row] of Object.entries(full.replay.perCoin)) {
    const wr = row.n ? (row.wins / row.n) * 100 : 0;
    console.log(
      `    ${symbol.padEnd(9)} n=${String(row.n).padStart(3)} WR=${fmt(wr, 1).padStart(5)}% net=$${fmt(row.netPnl, 2).padStart(8)}`,
    );
  }
}
if (mc.insufficient) {
  console.log(`  MC: insufficient trades (${rValues.length})`);
} else {
  console.log(
    `  MC(equal-slice ${fmt(portfolioRiskFrac * 100, 3)}% acct-risk/event): p5=${fmt(mc.p5ReturnPct)}% p50=${fmt(mc.p50ReturnPct)}% p95=${fmt(mc.p95ReturnPct)}% maxDDp95=${fmt(mc.p95MaxDdPct)}% ruin=${fmt(mc.riskOfRuinPct, 1)}%`,
  );
}

const splits = purgedWalkForwardSplits(ref.length, {
  folds: WF_FOLDS,
  embargo,
  mode: "rolling",
  minTrain: Math.min(300, Math.floor(ref.length * 0.2)),
});

let trainExp = 0;
let testExp = 0;
let testRet = 0;
let testTrades = 0;
console.log(`\nWalk-forward (${splits.length} folds, embargo=${embargo} bars):`);
for (const split of splits) {
  const trainFrom = ref[split.trainStart].ts;
  const trainTo = ref[Math.min(split.trainEnd, ref.length - 1)].ts + stepMs;
  const testFrom = ref[split.testStart].ts;
  const testTo = ref[Math.min(split.testEnd - 1, ref.length - 1)].ts + stepMs;
  const tr = await runPortfolioWindow(trainFrom, trainTo);
  const te = await runPortfolioWindow(testFrom, testTo);
  trainExp += tr.metrics.expectancy || 0;
  testExp += te.metrics.expectancy || 0;
  testRet += te.metrics.totalReturnPct || 0;
  testTrades += te.metrics.totalTrades || 0;
  console.log(
    `  fold ${split.fold}: train[n=${tr.metrics.totalTrades} exp=$${fmt(tr.metrics.expectancy, 2)} ret=${fmt(tr.metrics.totalReturnPct)}%] ` +
      `test[n=${te.metrics.totalTrades} ret=${fmt(te.metrics.totalReturnPct)}% PF=${fmt(te.metrics.profitFactor, 2)} DD=${fmt(te.metrics.maxDrawdownPct)}%]`,
  );
}

const avgTrainExp = splits.length ? trainExp / splits.length : 0;
const avgTestExp = splits.length ? testExp / splits.length : 0;
const wfDeg = avgTrainExp !== 0 ? ((avgTrainExp - avgTestExp) / Math.abs(avgTrainExp)) * 100 : 100;
const gate = acceptanceGates({
  oosReturnPct: testRet,
  mcP5ReturnPct: mc.insufficient ? -1 : mc.p5ReturnPct,
  calmar: full.metrics.calmar ?? -1,
  walkForwardDegradationPct: wfDeg,
});
const freqPass = entriesPerDay >= TARGET_MIN && entriesPerDay <= TARGET_MAX;

console.log(`\nValidation gates:`);
for (const [name, g] of Object.entries(gate.gates)) {
  console.log(`  ${g.pass ? "PASS" : "FAIL"} ${name.padEnd(18)} value=${fmt(Number(g.value), 2)} need ${g.threshold}`);
}
console.log(`  ${freqPass ? "PASS" : "FAIL"} frequencyTarget    value=${fmt(entriesPerDay)} need ${TARGET_MIN}-${TARGET_MAX}/day`);
console.log(`  WF summary: testTrades=${testTrades} OOS-sum=${fmt(testRet)}% degradation=${fmt(wfDeg)}%`);
console.log(`  VERDICT: ${gate.allPass && freqPass ? "ACCEPTED" : "REJECTED"}\n`);

await closePool?.();
