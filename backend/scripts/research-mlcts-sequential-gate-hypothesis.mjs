#!/usr/bin/env node
/**
 * Sequential L1→L4 ICT formation + L5–L7 confidence threshold.
 *
 * Usage (backend/):
 *   FROM=2026-07-19 TO=2026-07-30 THRESHOLDS=40,45,50,55,60,65,70,75 \
 *     node scripts/research-mlcts-sequential-gate-hypothesis.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = (process.env.SYMBOL || "BTCUSDT").toUpperCase();
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2026-07-19";
const TO = process.env.TO || new Date().toISOString().slice(0, 10);
const THRESHOLDS = (process.env.THRESHOLDS || "40,45,50,55,60,65,70,75")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));
const START = Number(process.env.START_USDT || 10_000);
const LOOKBACK = Number(process.env.SEQ_LOOKBACK_BARS || 32);
const MAX_BOS_LAG = Number(process.env.SEQ_MAX_BOS_LAG || 8);

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
  detectSequentialL1234Formation,
  computeMlctsConfidenceScore,
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
const { ensureMlctsVisionData, loadMlctsVisionFeedsMemory } = await import("../src/backtest/data/mlctsVisionIngest.js");
const { utcDayId } = await import("../src/strategy/techniques/liquidity.js");

function iso(ts) {
  return new Date(ts).toISOString();
}
function ist(ts) {
  return new Date(ts).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}
function lookupBook(series, ts) {
  let best = null;
  for (const row of series ?? []) {
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
    const prev = rows?.[rows.length - 2];
    if (!prev) return null;
    const high = Number(prev.high);
    const low = Number(prev.low);
    if (!(high > 0 && low > 0)) return null;
    return { high, low, source: "binance_1w" };
  } catch {
    return null;
  }
}

console.error(`\n=== MLCTS sequential L1234 gate ${SYMBOL} ${FROM} → ${iso(analysisEndMs)} ===`);

const padFrom = mlctsPadFromMs(fromMs, TF);
let windowCandles;
let funding;
let hydrated;
let weekly;

if (dbOk) {
  console.error("Data: DB");
  await ensureKlines(SYMBOL, TF, { from: padFrom, to: analysisEndMs + 900_000, market: "futures" }).catch(() => {});
  await ensureMlctsVisionData(SYMBOL, padFrom, analysisEndMs + 900_000, { force: false }).catch(() => {});
  const candles = await readCandles(SYMBOL, TF, padFrom, analysisEndMs + 900_000, { market: "futures" });
  funding = await readFundingRates(SYMBOL, padFrom, analysisEndMs + 900_000).catch(() => []);
  hydrated = await hydrateMlctsCfg(resolveMlctsCfg({ symbol: SYMBOL, timeframe: TF }), SYMBOL, fromMs, analysisEndMs + 900_000, {
    ensureVision: false,
  });
  windowCandles = candles.filter((c) => c.ts >= padFrom && c.ts <= analysisEndMs + 900_000);
} else {
  console.error("Data: REST + Vision memory (no DB)");
  console.error("Fetching 15m klines…");
  windowCandles = await fetchBinanceKlinesRange({
    symbol: SYMBOL,
    interval: "15m",
    startTime: padFrom,
    endTime: analysisEndMs + 900_000,
    feedKind: "BINANCE_FUTURES",
    chartPublic: true,
  });
  console.error(`  klines: ${windowCandles.length} bars`);
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
    console.warn("funding:", e?.message);
  }
  console.error(`  funding: ${funding.length} events`);
  console.error("Downloading Binance Vision OI + book (this may take several minutes)…");
  let lastDay = "";
  const vision = await loadMlctsVisionFeedsMemory(SYMBOL, padFrom, analysisEndMs + 900_000, {
    onProgress: ({ phase, day, i, n }) => {
      if (day !== lastDay) {
        lastDay = day;
        console.error(`  ${phase} ${day} (${i + 1}/${n})`);
      }
    },
  });
  hydrated = resolveMlctsCfg({ symbol: SYMBOL, timeframe: TF });
  hydrated._mlctsOiSeries = vision.oiSeries;
  hydrated._mlctsFundingSeries = funding.map((r) => ({ ts: r.ts, rate: r.rate, current: r.rate }));
  hydrated._mlctsBookImbalanceSeries = vision.bookImbalanceSeries;
  hydrated._mlctsFeedCoverage = {
    source: "rest_vision_memory",
    visionMetricsPoints: vision.visionMetrics.length,
    bookImbalanceSnapshots: vision.bookImbalanceSeries.length,
    fundingPoints: funding.length,
  };
  console.error(
    `  vision OI: ${vision.oiSeries.length} book: ${vision.bookImbalanceSeries.length}`,
  );
}

weekly = await weeklyLiquidity(SYMBOL);
const pre = precomputeIntraday(windowCandles);
const opts = optsFromMlctsCfg(hydrated);
const marketCtx = {
  oiSeries: hydrated._mlctsOiSeries ?? [],
  fundingSeries: hydrated._mlctsFundingSeries ?? [],
  bookImbalanceSeries: hydrated._mlctsBookImbalanceSeries ?? [],
};
const seqCfg = { lookbackBars: LOOKBACK, maxBosLagBars: MAX_BOS_LAG };

const evalCache = new Map();
function evalAt(i) {
  if (!evalCache.has(i)) {
    const ts = windowCandles[i].ts;
    evalCache.set(
      i,
      evaluateMlctsLayers(windowCandles, i, opts, {
        pre,
        weeklyLiquidity: weekly,
        ...marketCtx,
        orderBookImbalance: lookupBook(marketCtx.bookImbalanceSeries, ts),
      }),
    );
  }
  return evalCache.get(i);
}

console.error("Precomputing layer evaluations…");
for (let i = MLCTS_WARMUP; i < windowCandles.length; i++) evalAt(i);
console.error(`  cached ${evalCache.size} bar evaluations`);

/** All sequential formations completing in analysis window (before threshold). */
const formations = [];
for (let i = MLCTS_WARMUP; i < windowCandles.length; i++) {
  const ts = windowCandles[i].ts;
  if (ts < fromMs || ts >= analysisEndMs) continue;
  const form = detectSequentialL1234Formation(windowCandles, i, opts, {
    pre,
    weeklyLiquidity: weekly,
    ...marketCtx,
    evalAt,
  }, seqCfg);
  if (!form) continue;
  const conf = computeMlctsConfidenceScore(form.layersAtEntry, opts);
  formations.push({
    entryIso: iso(ts),
    entryIst: ist(ts),
    sweepIso: iso(windowCandles[form.sweepIdx].ts),
    sweepIst: ist(windowCandles[form.sweepIdx].ts),
    barsSweepToBos: form.bosIdx - form.sweepIdx,
    side: form.side,
    confidence: Math.round(conf.score),
    sweepLevel: form.sweepLevel,
    levelType: form.levelType,
    L5: form.layersAtEntry.orderflow?.score,
    L6: form.layersAtEntry.positioning?.score,
    L7: form.layersAtEntry.volatility?.score,
    confBreakdown: {
      orderFlowCore: conf.orderFlowCore,
      book: conf.bookScore,
      oi: conf.oiScore,
      fund: conf.fundScore,
      vol: conf.volScore,
    },
  });
}

function buildSequentialAdapter(threshold) {
  const series = new Array(windowCandles.length).fill(null);
  for (let i = MLCTS_WARMUP; i < windowCandles.length; i++) {
    const ts = windowCandles[i].ts;
    if (ts < fromMs || ts >= analysisEndMs) continue;
    const form = detectSequentialL1234Formation(windowCandles, i, opts, {
      pre,
      weeklyLiquidity: weekly,
      ...marketCtx,
      evalAt,
    }, seqCfg);
    if (!form) continue;
    const conf = computeMlctsConfidenceScore(form.layersAtEntry, opts);
    if (conf.score < threshold) continue;
    const brackets = buildMlctsBrackets(windowCandles, i, form.side, form.layersAtEntry, opts, pre);
    if (!brackets) continue;
    series[i] = {
      action: form.side,
      reason: `mlcts_seq_L1234_conf_${Math.round(conf.score)}`,
      trigger: "mlcts_sequential_formation",
      playbook: "MLCTS",
      liqBrackets: brackets,
      mlctsContext: {
        gateMode: "sequential_L1234",
        confidenceScore: Math.round(conf.score),
        sweepIdx: form.sweepIdx,
        bosIdx: form.bosIdx,
        sweepLevel: form.sweepLevel,
      },
      mlctsLayers: form.layersAtEntry,
    };
  }

  let lastSignalIdx = -Infinity;
  let tradesToday = 0;
  let curDay = null;

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
  const adapter = buildSequentialAdapter(threshold);
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
  const metrics = computeAllMetrics({ trades, equityCurve: sim.equityCurve ?? [], tf: TF, startingEquity: START });
  const rStat = rMultipleStats(trades);

  thresholdResults.push({
    threshold,
    formationsTotal: formations.length,
    signalBars: formations.filter((f) => f.confidence >= threshold).length,
    simTrades: trades.length,
    metrics: {
      returnPct: +(metrics.totalReturnPct ?? 0).toFixed(2),
      pf: +(metrics.profitFactor ?? 0).toFixed(3),
      winRate: +((metrics.winRate ?? 0) * 100).toFixed(1),
      meanR: +(rStat.rMean ?? 0).toFixed(3),
      maxDd: +Math.abs(metrics.maxDrawdownPct ?? 0).toFixed(2),
    },
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

const confScores = formations.map((f) => f.confidence).sort((a, b) => a - b);
const pct = (p) => {
  if (!confScores.length) return null;
  const idx = (confScores.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return confScores[lo];
  return confScores[lo] + (confScores[hi] - confScores[lo]) * (idx - lo);
};

const report = {
  generatedAt: new Date().toISOString(),
  hypothesis:
    "Sequential ICT: L1 bias in window + L2 at sweep bar + L3 sweep/reclaim + L4 BOS (≤8 bars later); entry on BOS bar; L5–L7 confidence vs threshold",
  symbol: SYMBOL,
  window: { from: FROM, to: iso(analysisEndMs) },
  params: { lookbackBars: LOOKBACK, maxBosLagBars: MAX_BOS_LAG, dataSource: dbOk ? "db" : "rest" },
  sequentialFormations: formations.length,
  formationsPerDay: +(formations.length / Math.max(1, (analysisEndMs - fromMs) / 86400000)).toFixed(2),
  confidenceOnFormations: {
    min: confScores[0] ?? null,
    p50: Math.round(pct(0.5) ?? 0),
    max: confScores[confScores.length - 1] ?? null,
  },
  allFormations: formations.length <= 80 ? formations : { count: formations.length, sample: formations.slice(0, 20) },
  thresholdResults,
  compareSameBarStrict: { trades_at_thresh_40: 2, note: "prior same-bar L1234 test" },
};

const outPath = path.join(__dirname, `.mlcts-sequential-gate-${SYMBOL}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(
  JSON.stringify(
    {
      outPath,
      sequentialFormations: formations.length,
      formationsPerDay: report.formationsPerDay,
      confidence: report.confidenceOnFormations,
      thresholdSummary: thresholdResults.map((r) => ({
        threshold: r.threshold,
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
