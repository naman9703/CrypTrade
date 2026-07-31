#!/usr/bin/env node
/**
 * Hypothesis: L1–L4 mandatory gates; L5–L7 confidence score vs threshold.
 *
 * Usage (backend/):
 *   FROM=2026-07-28 TO=2026-07-30 THRESHOLDS=40,45,50,55,60,65,70,75 \
 *     node scripts/research-mlcts-L1234-gate-hypothesis.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = (process.env.SYMBOL || "BTCUSDT").toUpperCase();
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2026-07-28";
const TO = process.env.TO || new Date().toISOString().slice(0, 10);
const THRESHOLDS = (process.env.THRESHOLDS || "40,45,50,55,60,65,70,75")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));
const START = Number(process.env.START_USDT || 10_000);

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO) > fromMs ? Date.parse(TO) : Date.now();
const analysisEndMs = Math.min(toMs, Date.now());

const { initPool, closePool, getPool } = await import("../src/db/pool.js");

async function probeDb() {
  if (process.env.FORCE_REST === "1") return false;
  const url = String(process.env.DATABASE_URL || "").trim();
  const host = String(process.env.DB_HOST || "").trim();
  if (!url && !host) return false;
  try {
    const pg = (await import("pg")).default;
    const cfg = url
      ? { connectionString: url, connectionTimeoutMillis: 4000 }
      : {
          host,
          port: Number(process.env.DB_PORT || 5432),
          database: String(process.env.DB_NAME || "trading"),
          user: String(process.env.DB_USER || "postgres"),
          password: String(process.env.DB_PASSWORD || ""),
          connectionTimeoutMillis: 4000,
        };
    const test = new pg.Pool(cfg);
    await test.query("SELECT 1");
    await test.end();
    if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
    return Boolean(getPool?.());
  } catch (err) {
    console.error("DB unavailable → REST fallback:", err?.message || err);
    return false;
  }
}

const dbOk = await probeDb();

const { readCandles, ensureKlines } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { fetchBinanceKlinesRange } = await import("../src/lib/binanceKlinesRest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const {
  evaluateMlctsLayers,
  computeMlctsConfidenceScore,
  mandatoryLayersPass,
  buildMlctsBrackets,
  MLCTS_WARMUP,
} = await import("../src/strategy/techniques/mlctsLayers.js");
const { precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const { fetchBinanceKlinesRows } = await import("../src/lib/binanceKlinesRest.js");
const {
  optsFromMlctsCfg,
  hydrateMlctsCfg,
  mlctsPadFromMs,
  resolveMlctsCfg,
} = await import("../src/strategy/mlctsIntraday.js");
const { ensureMlctsVisionData } = await import("../src/backtest/data/mlctsVisionIngest.js");
const { resolveSeriesDataTier } = await import("../src/strategy/techniques/orderFlow.js");
const { utcDayId } = await import("../src/strategy/techniques/liquidity.js");

function iso(ts) {
  return new Date(ts).toISOString();
}

function ist(ts) {
  return new Date(ts).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

function lookupBook(series, ts) {
  let best = null;
  for (const row of series) {
    if (row.ts <= ts) best = row;
    else break;
  }
  return best?.imbalanceRatio ?? null;
}

async function weeklyLiquidity(symbol) {
  try {
    const rows = await fetchBinanceKlinesRows({
      symbol,
      interval: "1w",
      limit: 3,
      feedKind: "futures",
      chartPublic: true,
    });
    if (!Array.isArray(rows) || rows.length < 2) return null;
    const prev = rows[rows.length - 2];
    const high = Number(prev?.high);
    const low = Number(prev?.low);
    if (!(high > 0 && low > 0)) return null;
    return { high, low, source: "binance_1w", weekTs: Number(prev?.ts) || 0 };
  } catch {
    return null;
  }
}

function buildHypothesisAdapter(candles, opts, marketCtx, pre, weekly, threshold) {
  const series = new Array(candles.length).fill(null);
  let lastSignalIdx = -Infinity;
  let tradesToday = 0;
  let curDay = null;

  for (let idx = MLCTS_WARMUP; idx < candles.length; idx++) {
    const barTs = candles[idx].ts;
    const bookImb = lookupBook(marketCtx.bookImbalanceSeries ?? [], barTs);
    const ev = evaluateMlctsLayers(candles, idx, opts, {
      pre,
      weeklyLiquidity: weekly,
      oiSeries: marketCtx.oiSeries,
      fundingSeries: marketCtx.fundingSeries,
      orderBookImbalance: bookImb,
    });
    const layers = ev.layers ?? {};
    const mandatoryOk = mandatoryLayersPass(layers, ev.direction);
    const conf = computeMlctsConfidenceScore(layers, opts);
    const brackets =
      mandatoryOk && conf.score >= threshold
        ? buildMlctsBrackets(candles, idx, ev.direction, layers, opts, pre)
        : null;
    const signalOk = mandatoryOk && conf.score >= threshold && brackets != null;

    if (signalOk) {
      series[idx] = {
        action: ev.direction,
        reason: `mlcts_L1234_conf_${Math.round(conf.score)}`,
        trigger: "mlcts_L1234_mandatory",
        playbook: "MLCTS",
        liqBrackets: brackets,
        mlctsContext: { ...ev.featureVector, confidenceScore: Math.round(conf.score), gateMode: "L1234_mandatory" },
        mlctsLayers: layers,
      };
    }
  }

  return function adapter(bar, idx) {
    if (idx < MLCTS_WARMUP) return null;
    const day = utcDayId(bar.ts);
    if (day !== curDay) {
      curDay = day;
      tradesToday = 0;
    }
    const sig = series[idx];
    if (!sig) return null;
    if (tradesToday >= opts.maxTradesPerDay) return null;
    if (idx - lastSignalIdx < opts.minBarGap) return null;
    lastSignalIdx = idx;
    tradesToday += 1;
    return sig;
  };
}

console.error(`\n=== MLCTS L1234-gate hypothesis ${SYMBOL} ${FROM} → ${iso(analysisEndMs)} ===`);
console.error(dbOk ? "Data source: DB" : "Data source: REST fallback (no DB)");

const padFrom = mlctsPadFromMs(fromMs, TF);
let windowCandles;
let funding;
let hydrated;
let weekly;

if (dbOk) {
  await ensureKlines(SYMBOL, TF, { from: padFrom, to: analysisEndMs + 900_000, market: "futures" }).catch(() => {});
  await ensureMlctsVisionData(SYMBOL, padFrom, analysisEndMs + 900_000, { force: false }).catch(() => {});
  const candles = await readCandles(SYMBOL, TF, padFrom, analysisEndMs + 900_000, { market: "futures" });
  funding = await readFundingRates(SYMBOL, padFrom, analysisEndMs + 900_000).catch(() => []);
  hydrated = await hydrateMlctsCfg(resolveMlctsCfg({ symbol: SYMBOL, timeframe: TF }), SYMBOL, fromMs, analysisEndMs + 900_000, {
    ensureVision: false,
  });
  windowCandles = candles.filter((c) => c.ts >= padFrom && c.ts <= analysisEndMs + 900_000);
} else {
  windowCandles = await fetchBinanceKlinesRange({
    symbol: SYMBOL,
    interval: "15m",
    startTime: padFrom,
    endTime: analysisEndMs + 900_000,
    feedKind: "BINANCE_FUTURES",
    chartPublic: true,
  });
  funding = [];
  try {
    const axios = (await import("axios")).default;
    const FAPI = process.env.BINANCE_FUTURES_REST_BASE || "https://fapi.binance.com";
    let start = padFrom;
    while (start < analysisEndMs) {
      const { data } = await axios.get(`${FAPI}/fapi/v1/fundingRate`, {
        params: { symbol: SYMBOL, startTime: start, endTime: analysisEndMs, limit: 1000 },
        timeout: 20_000,
      });
      if (!Array.isArray(data) || !data.length) break;
      for (const row of data) funding.push({ ts: Number(row.fundingTime), rate: Number(row.fundingRate) });
      start = Number(data[data.length - 1].fundingTime) + 1;
      if (data.length < 1000) break;
    }
  } catch (e) {
    console.warn("funding REST:", e?.message);
  }
  const oiRows = [];
  try {
    const axios = (await import("axios")).default;
    const FAPI = process.env.BINANCE_FUTURES_REST_BASE || "https://fapi.binance.com";
    let end = analysisEndMs;
    for (let g = 0; g < 20 && end > padFrom; g++) {
      const { data } = await axios.get(`${FAPI}/futures/data/openInterestHist`, {
        params: { symbol: SYMBOL, period: "1h", limit: 500, endTime: end },
        timeout: 20_000,
      });
      if (!Array.isArray(data) || !data.length) break;
      for (const row of data) {
        const ts = Number(row.timestamp);
        const oi = Number(row.sumOpenInterestValue ?? row.sumOpenInterest);
        if (ts >= padFrom && Number.isFinite(oi)) oiRows.push({ ts, oiUsdt: oi });
      }
      end = Number(data[0].timestamp) - 1;
    }
  } catch (e) {
    console.warn("OI REST:", e?.message);
  }
  oiRows.sort((a, b) => a.ts - b.ts);
  const oiSeries = [];
  for (let i = 0; i < oiRows.length; i++) {
    const prev = oiRows[Math.max(0, i - 4)];
    const cur = oiRows[i];
    const oiNow = cur.oiUsdt;
    const oiPrev = prev?.oiUsdt ?? oiNow;
    const changePct = i > 0 && oiPrev > 0 ? ((oiNow - oiPrev) / oiPrev) * 100 : 0;
    oiSeries.push({ ts: cur.ts, changePct, change4hPct: changePct });
  }
  hydrated = resolveMlctsCfg({ symbol: SYMBOL, timeframe: TF });
  hydrated._mlctsOiSeries = oiSeries;
  hydrated._mlctsFundingSeries = funding.map((r) => ({ ts: r.ts, rate: r.rate, current: r.rate }));
  hydrated._mlctsBookImbalanceSeries = [];
  hydrated._mlctsFeedCoverage = { source: "rest_fallback", oiSeriesPoints: oiSeries.length, fundingPoints: funding.length };
}

weekly = await weeklyLiquidity(SYMBOL);
const pre = precomputeIntraday(windowCandles);
const opts = optsFromMlctsCfg(hydrated);
const marketCtx = {
  oiSeries: hydrated._mlctsOiSeries ?? [],
  fundingSeries: hydrated._mlctsFundingSeries ?? [],
  bookImbalanceSeries: hydrated._mlctsBookImbalanceSeries ?? [],
};

/** Harvest bars in analysis window for distribution stats. */
const barRows = [];
for (let i = MLCTS_WARMUP; i < windowCandles.length; i++) {
  const ts = windowCandles[i].ts;
  if (ts < fromMs || ts >= analysisEndMs) continue;
  const bookImb = lookupBook(marketCtx.bookImbalanceSeries, ts);
  const ev = evaluateMlctsLayers(windowCandles, i, opts, {
    pre,
    weeklyLiquidity: weekly,
    ...marketCtx,
    orderBookImbalance: bookImb,
  });
  const layers = ev.layers ?? {};
  const mandatoryOk = mandatoryLayersPass(layers, ev.direction);
  const conf = computeMlctsConfidenceScore(layers, opts);
  barRows.push({
    iso: iso(ts),
    ist: ist(ts),
    mandatoryOk,
    confidence: Math.round(conf.score),
    L1: layers.trend?.score,
    L1pass: layers.trend?.pass,
    L2: layers.liquidity?.score,
    L2pass: layers.liquidity?.pass,
    L3: layers.sweep?.score,
    L3pass: layers.sweep?.pass,
    L4: layers.structure?.score,
    L4pass: layers.structure?.pass,
    L5: layers.orderflow?.score,
    L6: layers.positioning?.score,
    L7: layers.volatility?.score,
    L7pass: layers.volatility?.pass,
    direction: ev.direction,
    confBreakdown: conf,
  });
}

const confScores = barRows.map((b) => b.confidence).sort((a, b) => a - b);
const pct = (p) => {
  if (!confScores.length) return null;
  const idx = (confScores.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return confScores[lo];
  return confScores[lo] + (confScores[hi] - confScores[lo]) * (idx - lo);
};

const thresholdResults = [];
for (const threshold of THRESHOLDS) {
  const cfg = {
    ...hydrated,
    mlctsScoreThreshold: threshold,
    symbol: SYMBOL,
    timeframe: TF,
    manualStrategy: "MLCTS",
    marketMode: "FUTURES",
    backtestSignalStartMs: fromMs,
    riskPerTrade: 1,
    riskPerTradeUnit: "PCT",
    futuresLeverage: 10,
  };
  const adapter = buildHypothesisAdapter(windowCandles, opts, marketCtx, pre, weekly, threshold);
  const sim = await runSimulation({
    candles: windowCandles,
    strategyKey: "MLCTS",
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START,
    timeframe: TF,
    symbol: SYMBOL,
    adapters: { MLCTS: adapter },
    costModelOverride: { leverage: 10, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
  });

  const trades = (sim.trades ?? []).filter((t) => {
    const entry = Number(t.entryTs ?? t.openTs ?? t.ts);
    return entry >= fromMs && entry < analysisEndMs;
  });

  const signals = barRows.filter((b) => b.mandatoryOk && b.confidence >= threshold);
  const rStat = rMultipleStats(trades);
  const metrics = computeAllMetrics({
    trades,
    equityCurve: sim.equityCurve ?? [],
    tf: TF,
    startingEquity: START,
  });

  thresholdResults.push({
    threshold,
    mandatoryGateBars: barRows.filter((b) => b.mandatoryOk).length,
    signalBars: signals.length,
    simTrades: trades.length,
    metrics: {
      returnPct: +(metrics.totalReturnPct ?? 0).toFixed(2),
      pf: +(metrics.profitFactor ?? 0).toFixed(3),
      winRate: +((metrics.winRate ?? 0) * 100).toFixed(1),
      meanR: +(rStat.rMean ?? 0).toFixed(3),
      maxDd: +Math.abs(metrics.maxDrawdownPct ?? 0).toFixed(2),
    },
    signals: signals.map((s) => ({
      iso: s.iso,
      ist: s.ist,
      side: s.direction,
      confidence: s.confidence,
      L1: s.L1,
      L2: s.L2,
      L3: s.L3,
      L4: s.L4,
      L5: s.L5,
      L6: s.L6,
      L7: s.L7,
    })),
    trades: trades.map((t) => ({
      entryIso: iso(Number(t.entryTs ?? t.openTs ?? t.ts)),
      entryIst: ist(Number(t.entryTs ?? t.openTs ?? t.ts)),
      exitIso: iso(Number(t.exitTs ?? t.closeTs ?? 0)),
      side: t.side ?? t.action,
      entry: t.entryPrice ?? t.entryFill,
      exit: t.exitPrice ?? t.exitFill,
      netPnl: +(Number(t.netPnl ?? 0).toFixed(2)),
      exitReason: t.exitReason ?? t.reason,
    })),
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  hypothesis:
    "L1+L2+L3+L4 mandatory pass; L5+L6+L7 weighted confidence score vs threshold (weights: OF 15, book 10, OI 10, fund 5, vol 15)",
  symbol: SYMBOL,
  timeframe: TF,
  window: { from: FROM, to: iso(analysisEndMs) },
  dataQuality: {
    analysisBars: barRows.length,
    orderFlowTier: resolveSeriesDataTier(windowCandles),
    feedCoverage: hydrated._mlctsFeedCoverage ?? {},
  },
  mandatoryGateStats: {
    L1234_pass_bars: barRows.filter((b) => b.mandatoryOk).length,
    L1_only: barRows.filter((b) => b.L1pass).length,
    L2_only: barRows.filter((b) => b.L2pass).length,
    L3_only: barRows.filter((b) => b.L3pass).length,
    L4_only: barRows.filter((b) => b.L4pass).length,
  },
  confidenceInWindow: {
    min: confScores[0] ?? null,
    p50: Math.round(pct(0.5) ?? 0),
    p95: Math.round(pct(0.95) ?? 0),
    max: confScores[confScores.length - 1] ?? null,
  },
  thresholdResults,
};

const outPath = path.join(__dirname, `.mlcts-L1234-gate-hypothesis-${SYMBOL}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(
  JSON.stringify(
    {
      outPath,
      hypothesis: report.hypothesis,
      mandatoryGateBars: report.mandatoryGateStats.L1234_pass_bars,
      confidenceInWindow: report.confidenceInWindow,
      thresholdSummary: thresholdResults.map((r) => ({
        threshold: r.threshold,
        mandatoryBars: r.mandatoryGateBars,
        signals: r.signalBars,
        trades: r.simTrades,
        ...r.metrics,
      })),
    },
    null,
    2,
  ),
);
await closePool?.().catch(() => {});
