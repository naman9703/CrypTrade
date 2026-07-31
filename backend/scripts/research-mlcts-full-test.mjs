#!/usr/bin/env node
/**
 * MLCTS full-fidelity test — Vision OI + bookDepth, distribution + PnL sim.
 *
 * Usage (backend/):
 *   SYMBOLS=BTCUSDT FROM=2026-01-01 TO=2026-07-01 node scripts/research-mlcts-full-test.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT").split(",").map((s) => s.trim());
const FROM = process.env.FROM || "2026-01-01";
const TO = process.env.TO || "2026-07-01";
const TF = process.env.TF || "15m";
const START = Number(process.env.START_USDT || 10_000);
const THRESHOLDS = (process.env.THRESHOLDS || "50,55,60").split(",").map((s) => Number(s.trim()));

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildMlctsSeries } = await import("../src/strategy/techniques/mlctsLayers.js");
const {
  optsFromMlctsCfg,
  hydrateMlctsCfg,
  mlctsPadFromMs,
  resolveMlctsCfg,
  buildMlctsBacktestAdapter,
} = await import("../src/strategy/mlctsIntraday.js");
const { ensureMlctsVisionData } = await import("../src/backtest/data/mlctsVisionIngest.js");

function metricsFromSim(sim, lo, hi) {
  const trades = (sim.trades ?? []).filter((t) => Number(t.exitTs) >= lo && Number(t.exitTs) < hi);
  const m = computeAllMetrics({
    trades,
    equityCurve: sim.equityCurve ?? [],
    tf: TF,
    startingEquity: START,
  });
  const weeks = Math.max(0.01, (hi - lo) / (7 * 86400_000));
  return {
    trades: trades.length,
    perWeek: +(trades.length / weeks).toFixed(2),
    returnPct: +(m.totalReturnPct ?? 0).toFixed(2),
    cagr: +(m.cagrPct ?? 0).toFixed(2),
    maxDd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(3),
    sharpe: +(m.sharpe ?? 0).toFixed(3),
    winRate: +((m.winRate ?? 0) * 100).toFixed(1),
    meanR: +(m.rMean ?? 0).toFixed(3),
    expectancyR: +(m.expectancyR ?? 0).toFixed(3),
  };
}

async function runSymbol(symbol) {
  const padFrom = mlctsPadFromMs(fromMs, TF);
  console.error(`\n=== ${symbol} ingest + test ${FROM} → ${TO} ===`);
  await ensureMlctsVisionData(symbol, padFrom, toMs, { force: process.env.FORCE === "1" });

  const candles = await readCandles(symbol, TF, padFrom, toMs, { market: "futures" });
  const funding = await readFundingRates(symbol, padFrom, toMs).catch(() => []);
  const baseCfg = resolveMlctsCfg({ symbol, timeframe: TF });
  const hydrated = await hydrateMlctsCfg(baseCfg, symbol, fromMs, toMs, { ensureVision: false });

  const marketCtx = {
    oiSeries: hydrated._mlctsOiSeries ?? [],
    fundingSeries: hydrated._mlctsFundingSeries ?? [],
    bookImbalanceSeries: hydrated._mlctsBookImbalanceSeries ?? [],
  };

  const { series } = buildMlctsSeries(candles, optsFromMlctsCfg(hydrated), marketCtx);
  const inWindowSignals = series.filter((s, i) => {
    if (!s) return false;
    const ts = candles[i]?.ts;
    return ts >= fromMs && ts < toMs;
  }).length;

  const simResults = [];
  for (const threshold of THRESHOLDS) {
    const cfg = {
      ...hydrated,
      mlctsScoreThreshold: threshold,
      symbol,
      timeframe: TF,
      manualStrategy: "MLCTS",
      marketMode: "FUTURES",
      backtestSignalStartMs: fromMs,
      riskPerTrade: 1,
      riskPerTradeUnit: "PCT",
      futuresLeverage: 10,
    };
    const opts = optsFromMlctsCfg(cfg);
    const adapter = buildMlctsBacktestAdapter(candles, cfg, TF, marketCtx);
    const sim = await runSimulation({
      candles,
      strategyKey: "MLCTS",
      cfg,
      gateMode: "off",
      fundingRates: funding,
      startingUsdt: START,
      timeframe: TF,
      symbol,
      adapters: { MLCTS: adapter },
      costModelOverride: {
        leverage: 10,
        openFeeRate: 0.0004,
        closeFeeRate: 0.0004,
        slippagePct: 0.0005,
      },
    });
    const trades = sim.trades ?? [];
    simResults.push({
      threshold,
      signalsBuilt: series.filter(Boolean).length,
      ...metricsFromSim(sim, fromMs, toMs),
    });
  }

  return {
    symbol,
    window: { from: FROM, to: TO, tf: TF },
    candles: candles.length,
    feedCoverage: hydrated._mlctsFeedCoverage,
    signalsInWindowDefaultThreshold: inWindowSignals,
    defaultThreshold: hydrated.mlctsScoreThreshold,
    simByThreshold: simResults,
  };
}

const results = [];
for (const sym of SYMBOLS) {
  try {
    results.push(await runSymbol(sym));
  } catch (err) {
    results.push({ symbol: sym, error: String(err?.message || err) });
  }
}

const outPath = path.join(__dirname, ".mlcts-full-test.json");
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
console.log(JSON.stringify({ outPath, results }, null, 2));
await closePool?.().catch(() => {});
