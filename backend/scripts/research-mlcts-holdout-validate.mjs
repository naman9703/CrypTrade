#!/usr/bin/env node
/**
 * MLCTS cal/holdout validation — threshold picked on cal ONLY, tested once on holdout.
 *
 * Pre-registered cal selection rule (no holdout peek):
 *   Among thresholds with trades >= MIN_CAL_TRADES and PF >= MIN_CAL_PF on cal,
 *   pick the LOWEST threshold (max frequency subject to cal gates).
 *   If none qualify → selectedThreshold=null; holdout marked exploratory-only.
 *
 * Usage (backend/):
 *   SYMBOLS=BTCUSDT node scripts/research-mlcts-holdout-validate.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT").split(",").map((s) => s.trim());
const TF = process.env.TF || "15m";
const START = Number(process.env.START_USDT || 10_000);
const THRESHOLDS = (process.env.THRESHOLDS || "50,55,60,65,70,75")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));
const MIN_CAL_TRADES = Number(process.env.MIN_CAL_TRADES || 20);
const MIN_CAL_PF = Number(process.env.MIN_CAL_PF || 1.0);

const CAL_FROM = process.env.CAL_FROM || "2026-01-01";
const CAL_TO = process.env.CAL_TO || "2026-05-01";
const HOLD_FROM = process.env.HOLD_FROM || "2026-05-01";
const HOLD_TO = process.env.HOLD_TO || "2026-07-01";

const calFromMs = Date.parse(CAL_FROM);
const calToMs = Date.parse(CAL_TO);
const holdFromMs = Date.parse(HOLD_FROM);
const holdToMs = Date.parse(HOLD_TO);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const {
  hydrateMlctsCfg,
  resolveMlctsCfg,
  buildMlctsBacktestAdapter,
  mlctsPadFromMs,
} = await import("../src/strategy/mlctsIntraday.js");

function tradeMetrics(sim, lo, hi) {
  const trades = (sim.trades ?? []).filter((t) => {
    const entry = Number(t.entryTs ?? t.openTs ?? t.ts);
    return entry >= lo && entry < hi;
  });
  const m = computeAllMetrics({
    trades,
    equityCurve: sim.equityCurve ?? [],
    tf: TF,
    startingEquity: START,
  });
  const r = rMultipleStats(trades);
  const weeks = Math.max(0.01, (hi - lo) / (7 * 86400_000));
  const se = r.rCount > 0 ? r.rStd / Math.sqrt(r.rCount) : null;
  return {
    trades: r.rCount,
    perWeek: +(r.rCount / weeks).toFixed(2),
    returnPct: +(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(3),
    winRate: +((m.winRate ?? 0) * 100).toFixed(1),
    meanR: +(r.rMean ?? 0).toFixed(3),
    rStd: +(r.rStd ?? 0).toFixed(3),
    rSe: se != null ? +se.toFixed(3) : null,
    meanRCi95: se != null ? [+(r.rMean - 1.96 * se).toFixed(3), +(r.rMean + 1.96 * se).toFixed(3)] : null,
    expectancyR: +(r.expectancyR ?? 0).toFixed(3),
    maxDd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
  };
}

async function runWindowSim({ symbol, candles, funding, hydrated, threshold, signalFromMs, signalToMs }) {
  const padFrom = mlctsPadFromMs(signalFromMs, TF);
  const windowCandles = candles.filter((c) => c.ts >= padFrom && c.ts < signalToMs);
  const windowFunding = funding.filter((f) => f.ts >= padFrom && f.ts < signalToMs);
  const cfg = {
    ...hydrated,
    mlctsScoreThreshold: threshold,
    symbol,
    timeframe: TF,
    manualStrategy: "MLCTS",
    marketMode: "FUTURES",
    backtestSignalStartMs: signalFromMs,
    backtestSignalEndMs: signalToMs,
    riskPerTrade: 1,
    riskPerTradeUnit: "PCT",
    futuresLeverage: 10,
  };
  const marketCtx = {
    oiSeries: hydrated._mlctsOiSeries ?? [],
    fundingSeries: hydrated._mlctsFundingSeries ?? [],
    bookImbalanceSeries: hydrated._mlctsBookImbalanceSeries ?? [],
  };
  const adapter = buildMlctsBacktestAdapter(windowCandles, cfg, TF, marketCtx);
  const sim = await runSimulation({
    candles: windowCandles,
    strategyKey: "MLCTS",
    cfg,
    gateMode: "off",
    fundingRates: windowFunding,
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
  return tradeMetrics(sim, signalFromMs, signalToMs);
}

function selectThreshold(calResults) {
  const qualifying = calResults
    .filter((r) => r.trades >= MIN_CAL_TRADES && r.pf >= MIN_CAL_PF)
    .sort((a, b) => a.threshold - b.threshold);
  if (qualifying.length) {
    return {
      threshold: qualifying[0].threshold,
      rule: `lowest_threshold_with_trades>=${MIN_CAL_TRADES}_and_pf>=${MIN_CAL_PF}`,
      qualifying: qualifying.map((q) => q.threshold),
    };
  }
  return {
    threshold: null,
    rule: `none_met_cal_gates(trades>=${MIN_CAL_TRADES},pf>=${MIN_CAL_PF})`,
    qualifying: [],
  };
}

async function analyzeSymbol(symbol) {
  const fullPadFrom = mlctsPadFromMs(Math.min(calFromMs, holdFromMs), TF);
  const candles = await readCandles(symbol, TF, fullPadFrom, holdToMs, { market: "futures" });
  const funding = await readFundingRates(symbol, fullPadFrom, holdToMs).catch(() => []);
  const hydrated = await hydrateMlctsCfg(
    resolveMlctsCfg({ symbol, timeframe: TF }),
    symbol,
    fullPadFrom,
    holdToMs,
    { ensureVision: false },
  );

  const calSweep = [];
  for (const threshold of THRESHOLDS) {
    calSweep.push({
      threshold,
      ...(await runWindowSim({
        symbol,
        candles,
        funding,
        hydrated,
        threshold,
        signalFromMs: calFromMs,
        signalToMs: calToMs,
      })),
    });
  }

  const selection = selectThreshold(calSweep);
  let holdout = null;
  if (selection.threshold != null) {
    holdout = {
      threshold: selection.threshold,
      ...(await runWindowSim({
        symbol,
        candles,
        funding,
        hydrated,
        threshold: selection.threshold,
        signalFromMs: holdFromMs,
        signalToMs: holdToMs,
      })),
      preRegistered: true,
    };
  } else {
    holdout = {
      threshold: null,
      preRegistered: false,
      note: "No cal threshold met gates — holdout not run (no post-hoc threshold pick).",
    };
  }

  return {
    symbol,
    split: { cal: { from: CAL_FROM, to: CAL_TO }, holdout: { from: HOLD_FROM, to: HOLD_TO } },
    selectionRule: selection,
    calibrationSweep: calSweep,
    holdoutValidation: holdout,
    feedCoverage: hydrated._mlctsFeedCoverage,
  };
}

const results = [];
for (const sym of SYMBOLS) {
  try {
    results.push(await analyzeSymbol(sym));
  } catch (err) {
    results.push({ symbol: sym, error: String(err?.message || err) });
  }
}

const outPath = path.join(__dirname, ".mlcts-holdout-validate.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      methodology:
        "Threshold selected on cal window only via pre-registered rule; holdout run once unmodified.",
      minCalTrades: MIN_CAL_TRADES,
      minCalPf: MIN_CAL_PF,
      thresholdsScanned: THRESHOLDS,
      results,
    },
    null,
    2,
  ),
);

console.log(JSON.stringify({ outPath, results }, null, 2));
await closePool?.().catch(() => {});
