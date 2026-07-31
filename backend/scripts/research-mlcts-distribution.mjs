#!/usr/bin/env node
/**
 * MLCTS composite distribution — directional bars only (research, pre-threshold calibration).
 *
 * Usage (backend/):
 *   SYMBOLS=BTCUSDT FROM=2026-01-01 TO=2026-07-01 node scripts/research-mlcts-distribution.mjs
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

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const {
  evaluateMlctsLayers,
  computeMlctsCompositeScore,
  MLCTS_WARMUP,
  MLCTS_DEFAULTS,
} = await import("../src/strategy/techniques/mlctsLayers.js");
const { precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const { optsFromMlctsCfg, hydrateMlctsCfg, mlctsPadFromMs, resolveMlctsCfg } = await import(
  "../src/strategy/mlctsIntraday.js",
);

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

const LAYER_KEYS = [
  { key: "trend", label: "L1 trend", weightKey: "weightTrend" },
  { key: "liquidity", label: "L2 liquidity", weightKey: "weightLiquidity" },
  { key: "sweep", label: "L3 sweep", weightKey: "weightTrigger", triggerHalf: true },
  { key: "structure", label: "L4 structure", weightKey: "weightTrigger", triggerHalf: true },
  { key: "orderflow", label: "L5 orderflow core", weightKey: "weightOrderFlow", useCore: true },
  { key: "book", label: "L5 book", weightKey: "weightBook", fromDetail: "bookScore" },
  { key: "positioningOi", label: "L6 OI", weightKey: "weightOi", fromDetail: "oiScore", layer: "positioning" },
  { key: "positioningFund", label: "L6 funding", weightKey: "weightFunding", fromDetail: "fundScore", layer: "positioning" },
];

function layerScoreForCap(layers, comp, spec) {
  if (spec.fromDetail) {
    const row = layers[spec.layer ?? spec.key] ?? {};
    return num(row.detail?.[spec.fromDetail], num(row.score, 0));
  }
  if (spec.useCore) return num(comp.orderFlowCore, 0);
  if (spec.triggerHalf) return num(layers[spec.key]?.score, 0);
  return num(layers[spec.key]?.score, 0);
}

function weightedHeadroom(score, weight, wSum) {
  return (num(weight, 0) * (100 - num(score, 0))) / num(wSum, 1);
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function capAnalysis(rows, opts) {
  const wSum =
    num(opts.weightTrend) +
    num(opts.weightLiquidity) +
    num(opts.weightTrigger) +
    num(opts.weightOrderFlow) +
    num(opts.weightBook) +
    num(opts.weightOi) +
    num(opts.weightFunding);

  const byMinScore = {};
  const byHeadroom = {};

  for (const row of rows) {
    const layers = row.layers;
    const comp = row.comp;

    let minSpec = null;
    let minScore = Infinity;
    let maxHeadroom = -Infinity;
    let maxHeadSpec = null;

    for (const spec of LAYER_KEYS) {
      const s = layerScoreForCap(layers, comp, spec);
      if (s < minScore) {
        minScore = s;
        minSpec = spec;
      }
      const w = num(opts[spec.weightKey], 0) * (spec.triggerHalf ? 0.5 : 1);
      const head = weightedHeadroom(s, w, wSum);
      if (head > maxHeadroom) {
        maxHeadroom = head;
        maxHeadSpec = spec;
      }
    }

    if (minSpec) byMinScore[minSpec.label] = (byMinScore[minSpec.label] ?? 0) + 1;
    if (maxHeadSpec) byHeadroom[maxHeadSpec.label] = (byHeadroom[maxHeadSpec.label] ?? 0) + 1;
  }

  const sortCounts = (map) =>
    Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({ label, count, pct: rows.length ? (100 * count) / rows.length : 0 }));

  return {
    n: rows.length,
    capByLowestLayerScore: sortCounts(byMinScore),
    capByLargestWeightedHeadroom: sortCounts(byHeadroom),
  };
}

function lookupAt(series, ts) {
  if (!Array.isArray(series) || !series.length) return null;
  let best = null;
  for (const row of series) {
    const t = num(row?.ts);
    if (t <= ts) best = row;
    else break;
  }
  return best;
}

async function analyzeSymbol(symbol) {
  const padFrom = mlctsPadFromMs(fromMs, TF);
  const candles = await readCandles(symbol, TF, padFrom, toMs, { market: "futures" });
  const cfg = await hydrateMlctsCfg(resolveMlctsCfg({ symbol, timeframe: TF }), symbol, fromMs, toMs);
  const opts = optsFromMlctsCfg(cfg);
  const pre = precomputeIntraday(candles);
  const bookSeries = cfg._mlctsBookImbalanceSeries ?? [];
  const extras = {
    oiSeries: cfg._mlctsOiSeries ?? [],
    fundingSeries: cfg._mlctsFundingSeries ?? [],
    bookImbalanceSeries: bookSeries,
    pre,
  };

  let barsWithBook = 0;
  let barsWithOi = 0;
  const directional = [];
  let signalCount = 0;

  for (let i = MLCTS_WARMUP; i < candles.length; i++) {
    const ts = Number(candles[i]?.ts);
    if (!(ts >= fromMs && ts < toMs)) continue;

    const bookRow = lookupAt(bookSeries, ts);
    const orderBookImbalance = bookRow?.imbalanceRatio ?? null;
    if (orderBookImbalance != null && orderBookImbalance > 0) barsWithBook++;
    if (lookupAt(extras.oiSeries, ts)?.changePct != null) barsWithOi++;

    const ev = evaluateMlctsLayers(candles, i, opts, { ...extras, orderBookImbalance });
    if (!ev.direction) continue;

    const comp = computeMlctsCompositeScore(ev.layers, opts);
    if (ev.signalOk) signalCount++;

    directional.push({
      ts,
      score: ev.score,
      compScore: comp.score,
      signalOk: ev.signalOk,
      hardVetoesOk: ev.hardVetoesOk,
      layers: ev.layers,
      comp,
      vector: {
        trend: ev.layers.trend?.score ?? 0,
        liquidity: ev.layers.liquidity?.score ?? 0,
        sweep: ev.layers.sweep?.score ?? 0,
        structure: ev.layers.structure?.score ?? 0,
        orderflowCore: comp.orderFlowCore,
        book: comp.bookScore,
        oi: comp.oiScore,
        funding: comp.fundScore,
        volatility: ev.layers.volatility?.score ?? 0,
        volatilityPass: ev.layers.volatility?.pass === true,
      },
    });
  }

  const scores = directional.map((r) => r.score).sort((a, b) => a - b);
  const p75 = percentile(scores, 0.75);
  const p95 = percentile(scores, 0.95);

  const p75p95 = directional.filter((r) => r.score >= p75 && r.score <= p95);
  const p75p95Cap = capAnalysis(p75p95, opts);

  const coverageDays = Math.max(1, (toMs - fromMs) / 86400_000);
  return {
    symbol,
    window: { from: FROM, to: TO, tf: TF, days: coverageDays },
    barsEvaluated: candles.length,
    directionalBars: directional.length,
    signalsAtCurrentThreshold: signalCount,
    scoreThreshold: opts.scoreThreshold,
    feedCoverage: cfg._mlctsFeedCoverage ?? {},
    barFeedAttribution: {
      directionalBars: directional.length,
      barsWithBookImbalance: barsWithBook,
      barsWithOi: barsWithOi,
      bookPct: directional.length ? (100 * barsWithBook) / directional.length : 0,
      oiPct: directional.length ? (100 * barsWithOi) / directional.length : 0,
    },
    distribution: {
      n: scores.length,
      min: scores[0] ?? null,
      p50: percentile(scores, 0.5),
      p75,
      p90: percentile(scores, 0.9),
      p95,
      max: scores[scores.length - 1] ?? null,
      mean: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    },
    p75p95Band: {
      range: [p75, p95],
      n: p75p95.length,
      ...p75p95Cap,
    },
    thresholdHints: [50, 55, 60, 65, 70, 75].map((t) => ({
      threshold: t,
      signals: directional.filter((r) => r.score >= t && r.hardVetoesOk).length,
      perWeek: directional.filter((r) => r.score >= t && r.hardVetoesOk).length / (coverageDays / 7),
    })),
    topCompositeBars: directional
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((r) => ({ ts: r.ts, score: r.score, vector: r.vector, signalOk: r.signalOk })),
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

const outPath = path.join(__dirname, ".mlcts-composite-distribution.json");
fs.writeFileSync(
  outPath,
  JSON.stringify({ generatedAt: new Date().toISOString(), from: FROM, to: TO, tf: TF, results }, null, 2),
);

console.log(JSON.stringify({ outPath, results }, null, 2));
await closePool?.().catch(() => {});
