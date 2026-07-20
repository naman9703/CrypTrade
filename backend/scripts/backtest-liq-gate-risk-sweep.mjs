#!/usr/bin/env node
/** Quick gate validation for a fixed liquidity patch at multiple risk levels. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const SYMBOL = process.env.SYMBOL || "ETHUSDT";
const TF = "15m";
const MONTHS = ["2025-03", "2025-07", "2025-10", "2026-01", "2026-04"];
const PATCH = {
  srIntradaySweepPct: 0.001,
  intradayLiqMinSweepExtensionPct: 0.004,
  intradayLiqMinRr: 1.25,
  intradayLiqMinReclaimBodyRatio: 0.25,
  intradayLiqMinScore: 5,
  intradayLiqRequireHtfAlign: false,
  intradayLiqSessionExtreme: true,
  intradayLiqSessionExtremeMinTouches: 2,
  intradayLiqSessionExtremeMinExtensionPct: 0.001,
  intradayLiqOnePickPerDay: true,
  srIntradayMaxTradesPerDay: 2,
};

const RISKS = String(process.env.RISKS || "1,1.5,2,2.5")
  .split(",")
  .map(Number)
  .filter((n) => n > 0);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { monteCarloBootstrap, purgedWalkForwardSplits, acceptanceGates } = await import(
  "../src/backtest/engine/validation.js"
);
const { INTRADAY_PRO_LIQ_15M, fillLiqSoloPresetDefaults, materializeIntradayEngineCfg } = await import(
  "../src/strategy/presets/srIntradayOptimized.js"
);

const fromMs = Date.parse(`${MONTHS[0]}-01`) - 21 * 86_400_000;
const toMs = Date.parse(
  (() => {
    const [y, m] = MONTHS.at(-1).split("-").map(Number);
    const nm = m === 12 ? 1 : m + 1;
    const ny = m === 12 ? y + 1 : y;
    return `${ny}-${String(nm).padStart(2, "0")}-01`;
  })(),
);
const candles = await readCandles(SYMBOL, TF, fromMs, toMs, { market: "futures" });
let fundingRates = [];
try {
  fundingRates = await readFundingRates(SYMBOL, fromMs, toMs);
} catch {
  fundingRates = [];
}

async function validate(risk) {
  const cfg = await materializeIntradayEngineCfg(
    fillLiqSoloPresetDefaults({
      ...INTRADAY_PRO_LIQ_15M,
      ...PATCH,
      symbol: SYMBOL,
      timeframe: TF,
      strategyMode: "MANUAL",
      manualStrategy: "SR_INTRADAY",
      marketMode: "FUTURES",
      backtestPositionSizing: "RISK_AT_SL",
      riskPerTrade: risk,
      riskPerTradeUnit: "PCT",
      futuresLeverage: 12,
      slippagePct: 0.0005,
      backtestSignalStartMs: Date.parse(`${MONTHS[0]}-01`),
    }),
  );

  async function runSlice(slice, fundSlice) {
    const adapters = await buildBacktestAdapters({
      strategyKey: "SR_INTRADAY",
      cfg,
      symbol: SYMBOL,
      tf: TF,
      candles: slice,
      fromMs: slice[0]?.ts,
    });
    return runSimulation({
      strategyKey: "SR_INTRADAY",
      candles: slice,
      cfg,
      gateMode: "off",
      fundingRates: fundSlice,
      startingUsdt: 10_000,
      timeframe: TF,
      symbol: SYMBOL,
      adapters,
    });
  }

  const sim = await runSlice(candles, fundingRates);
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: 10_000 });
  const rstats = rMultipleStats(sim.trades);
  const mc = monteCarloBootstrap(rstats.rValues, { paths: 3000, riskFrac: risk / 100, ruinDrawdownPct: 50 });
  const stepMs = candles[1].ts - candles[0].ts;
  const embargo = Math.max(1, Math.round(86_400_000 / stepMs));
  const splits = purgedWalkForwardSplits(candles.length, { folds: 4, embargo, mode: "rolling", minTrain: 300 });
  let trainExpSum = 0;
  let testExpSum = 0;
  let testRetSum = 0;
  for (const s of splits) {
    const tr = await runSlice(candles.slice(s.trainStart, s.trainEnd), fundingRates);
    const te = await runSlice(candles.slice(s.testStart, s.testEnd), fundingRates);
    const trM = computeAllMetrics({ trades: tr.trades, equityCurve: tr.equityCurve, tf: TF, startingEquity: 10_000 });
    const teM = computeAllMetrics({ trades: te.trades, equityCurve: te.equityCurve, tf: TF, startingEquity: 10_000 });
    trainExpSum += trM.expectancy || 0;
    testExpSum += teM.expectancy || 0;
    testRetSum += teM.totalReturnPct || 0;
  }
  const avgTrainExp = trainExpSum / splits.length;
  const avgTestExp = testExpSum / splits.length;
  const wfDeg = avgTrainExp !== 0 ? ((avgTrainExp - avgTestExp) / Math.abs(avgTrainExp)) * 100 : 100;
  const gate = acceptanceGates({
    oosReturnPct: testRetSum,
    mcP5ReturnPct: mc.insufficient ? -1 : mc.p5ReturnPct,
    calmar: m.calmar ?? -1,
    walkForwardDegradationPct: wfDeg,
  });
  return { risk, ret: m.totalReturnPct, calmar: m.calmar, dd: m.maxDrawdownPct, trades: m.totalTrades, mcP5: mc.p5ReturnPct, wfDeg, gate };
}

for (const risk of RISKS) {
  const r = await validate(risk);
  console.log(
    `risk=${risk}% ret=${r.ret?.toFixed(1)}% dd=${r.dd?.toFixed(1)}% calmar=${r.calmar?.toFixed(2)} ` +
      `mcP5=${r.mcP5?.toFixed(1)}% wfDeg=${r.wfDeg?.toFixed(1)}% gates=${r.gate.allPass ? "PASS" : "FAIL"} n=${r.trades}`,
  );
}

await closePool?.();
