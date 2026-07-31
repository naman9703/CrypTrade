#!/usr/bin/env node
/**
 * MLCTS book isolation — Vision book score vs trade outcome (cal window).
 * Does NOT use composite or threshold selection; tests discriminative power alone.
 *
 * Usage (backend/):
 *   node scripts/research-mlcts-book-isolation.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = (process.env.SYMBOL || "BTCUSDT").toUpperCase();
const TF = process.env.TF || "15m";
const CAL_FROM = process.env.CAL_FROM || "2026-01-01";
const CAL_TO = process.env.CAL_TO || "2026-05-01";
const ENTRY_THRESHOLD = Number(process.env.ENTRY_THRESHOLD || 50);

const calFromMs = Date.parse(CAL_FROM);
const calToMs = Date.parse(CAL_TO);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { rMultipleStats } = await import("../src/backtest/engine/metrics.js");

function tradeR(t) {
  if (Number.isFinite(Number(t.rMultiple))) return Number(t.rMultiple);
  const entry = Number(t.entryPrice ?? t.entryFill);
  const stop = Number(t.initialSlPrice ?? t.slPrice ?? t.stopPrice);
  const risk =
    Number(t.initialRiskUsd) ||
    Number(t.riskUsd) ||
    (Number.isFinite(entry) && Number.isFinite(stop) && Number(t.qty)
      ? Math.abs(entry - stop) * Math.abs(Number(t.qty))
      : 0);
  if (risk > 0) return Number(t.netPnl ?? 0) / risk;
  if (Number.isFinite(Number(t.pnlPct)) && Number.isFinite(Number(t.riskPct)) && Number(t.riskPct) !== 0) {
    return Number(t.pnlPct) / Number(t.riskPct);
  }
  return null;
}
const {
  hydrateMlctsCfg,
  resolveMlctsCfg,
  buildMlctsBacktestAdapter,
  mlctsPadFromMs,
} = await import("../src/strategy/mlctsIntraday.js");
const { orderFlowBookScore } = await import("../src/strategy/techniques/mlctsLayers.js");

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : null;
}

function stats(arr) {
  if (!arr.length) return { n: 0, mean: null, std: null };
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const std = Math.sqrt(arr.reduce((a, v) => a + (v - mean) ** 2, 0) / arr.length);
  return { n: arr.length, mean, std };
}

function lookupAt(series, ts) {
  let best = null;
  for (const row of series) {
    if (row.ts <= ts) best = row;
    else break;
  }
  return best;
}

const padFrom = mlctsPadFromMs(calFromMs, TF);
const fullPadFrom = mlctsPadFromMs(Math.min(calFromMs, calFromMs), TF);
const candles = await readCandles(SYMBOL, TF, fullPadFrom, calToMs, { market: "futures" });
const windowCandles = candles.filter((c) => c.ts >= padFrom && c.ts < calToMs);
const funding = (await readFundingRates(SYMBOL, padFrom, calToMs).catch(() => [])).filter(
  (f) => f.ts >= padFrom && f.ts < calToMs,
);
const hydrated = await hydrateMlctsCfg(
  resolveMlctsCfg({ symbol: SYMBOL, timeframe: TF, mlctsScoreThreshold: ENTRY_THRESHOLD }),
  SYMBOL,
  padFrom,
  calToMs,
  { ensureVision: false },
);
const bookSeries = hydrated._mlctsBookImbalanceSeries ?? [];

const cfg = {
  ...hydrated,
  mlctsScoreThreshold: ENTRY_THRESHOLD,
  symbol: SYMBOL,
  timeframe: TF,
  manualStrategy: "MLCTS",
  marketMode: "FUTURES",
  backtestSignalStartMs: calFromMs,
  riskPerTrade: 1,
  riskPerTradeUnit: "PCT",
  futuresLeverage: 10,
};
const marketCtx = {
  oiSeries: hydrated._mlctsOiSeries ?? [],
  fundingSeries: hydrated._mlctsFundingSeries ?? [],
  bookImbalanceSeries: bookSeries,
};
const adapter = buildMlctsBacktestAdapter(windowCandles, cfg, TF, marketCtx);
const sim = await runSimulation({
  candles: windowCandles,
  strategyKey: "MLCTS",
  cfg,
  gateMode: "off",
  fundingRates: funding,
  startingUsdt: 10_000,
  timeframe: TF,
  symbol: SYMBOL,
  adapters: { MLCTS: adapter },
  costModelOverride: { leverage: 10, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
});

const calTrades = (sim.trades ?? []).filter((t) => {
  const entry = Number(t.entryTs ?? t.openTs ?? t.ts);
  return entry >= calFromMs && entry < calToMs;
});

const tradeRows = [];
for (const t of calTrades) {
  const entry = Number(t.entryTs ?? t.openTs ?? t.ts);
  const side = String(t.side ?? t.action ?? "").toUpperCase().includes("SELL") ? "SELL" : "BUY";
  const bookRow = lookupAt(bookSeries, entry);
  const imb = bookRow?.imbalanceRatio ?? null;
  const bookScore = imb != null ? orderFlowBookScore(imb, side) : null;
  const r = tradeR(t);
  tradeRows.push({ entry, side, imb, bookScore, r, win: r != null && r > 0 });
}

const withBook = tradeRows.filter((r) => r.bookScore != null);
const rVals = withBook.map((r) => r.r).filter((v) => Number.isFinite(v));
const bookScores = withBook.map((r) => r.bookScore);
const imbs = withBook.map((r) => r.imb);

const rStat = rMultipleStats(calTrades);

// Bar-level: all directional bars with vision book (no trade filter)
const { evaluateMlctsLayers, MLCTS_WARMUP } = await import("../src/strategy/techniques/mlctsLayers.js");
const { precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const { optsFromMlctsCfg } = await import("../src/strategy/mlctsIntraday.js");
const pre = precomputeIntraday(windowCandles);
const opts = optsFromMlctsCfg(cfg);
const barBookScores = [];
for (let i = MLCTS_WARMUP; i < windowCandles.length; i++) {
  const ts = windowCandles[i].ts;
  if (ts < calFromMs || ts >= calToMs) continue;
  const bookRow = lookupAt(bookSeries, ts);
  const imb = bookRow?.imbalanceRatio;
  if (imb == null) continue;
  const ev = evaluateMlctsLayers(windowCandles, i, opts, {
    pre,
    oiSeries: marketCtx.oiSeries,
    fundingSeries: marketCtx.fundingSeries,
    orderBookImbalance: imb,
  });
  if (!ev.direction) continue;
  const side = ev.direction;
  barBookScores.push(orderFlowBookScore(imb, side));
}

const report = {
  generatedAt: new Date().toISOString(),
  window: { calFrom: CAL_FROM, calTo: CAL_TO, entryThreshold: ENTRY_THRESHOLD },
  tradeSample: {
    trades: calTrades.length,
    withVisionBook: withBook.length,
    rSummary: {
      meanR: +rStat.rMean.toFixed(3),
      rStd: +rStat.rStd.toFixed(3),
      rSe: rStat.rCount > 0 ? +(rStat.rStd / Math.sqrt(rStat.rCount)).toFixed(3) : null,
    },
    bookScoreVsR: {
      pearsonR: pearson(bookScores, rVals) != null ? +pearson(bookScores, rVals).toFixed(4) : null,
      n: withBook.length,
      bookScore: stats(bookScores),
      visionImb: stats(imbs),
      winRateHighBook: (() => {
        const med = stats(bookScores).mean;
        const hi = withBook.filter((x) => x.bookScore >= med);
        const lo = withBook.filter((x) => x.bookScore < med);
        return {
          medianSplitAt: med,
          highBookWinRate: hi.length ? hi.filter((x) => x.win).length / hi.length : null,
          lowBookWinRate: lo.length ? lo.filter((x) => x.win).length / lo.length : null,
          highN: hi.length,
          lowN: lo.length,
        };
      })(),
    },
  },
  barLevelBookScore: stats(barBookScores),
  interpretation: [
    "Pearson r near 0 + overlapping win rates → Vision book adds little isolated predictive signal on cal.",
    "Tight bar-level bookScore distribution → limited composite leverage regardless of live correlation.",
    "Does not replace live-vs-Vision contemporaneous correlation check.",
  ],
};

const outPath = path.join(__dirname, ".mlcts-book-isolation-cal.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ outPath, report }, null, 2));
await closePool?.().catch(() => {});
