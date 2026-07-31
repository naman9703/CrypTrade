#!/usr/bin/env node
/**
 * MLCTS recent-window signal audit — full layer breakdown + sim by threshold.
 *
 * Usage (backend/):
 *   FROM=2026-07-28 TO=2026-07-30 THRESHOLDS=50,55,60,65,70,75 \
 *     node scripts/research-mlcts-recent-signals.mjs
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
const THRESHOLDS = (process.env.THRESHOLDS || "50,55,60,65,70,75")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));
const START = Number(process.env.START_USDT || 10_000);

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO) > fromMs ? Date.parse(TO) : Date.now();
const analysisEndMs = Math.min(toMs, Date.now());

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles, ensureKlines } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const {
  evaluateMlctsLayers,
  computeMlctsCompositeScore,
  MLCTS_WARMUP,
} = await import("../src/strategy/techniques/mlctsLayers.js");
const { precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const { fetchBinanceKlinesRows } = await import("../src/lib/binanceKlinesRest.js");
const {
  optsFromMlctsCfg,
  hydrateMlctsCfg,
  mlctsPadFromMs,
  resolveMlctsCfg,
  buildMlctsBacktestAdapter,
} = await import("../src/strategy/mlctsIntraday.js");
const { ensureMlctsVisionData } = await import("../src/backtest/data/mlctsVisionIngest.js");
const { resolveSeriesDataTier } = await import("../src/strategy/techniques/orderFlow.js");

function iso(ts) {
  return new Date(ts).toISOString();
}

function layerRow(key, row, minScore) {
  if (!row) return { key, score: null, pass: false, minScore };
  return {
    key,
    score: row.score ?? 0,
    pass: row.pass === true,
    minScore: row.detail?.minScore ?? minScore,
    detail: row.detail ?? {},
  };
}

function summarizeLayers(ev, comp, opts) {
  const L = ev.layers ?? {};
  return {
    L1_trend: layerRow("trend", L.trend, opts.minLayerScore),
    L2_liquidity: layerRow("liquidity", L.liquidity, opts.minLayerScore),
    L3_sweep: layerRow("sweep", L.sweep, opts.minLayerScore),
    L4_structure: layerRow("structure", L.structure, opts.minLayerScore),
    L5_orderflow: layerRow("orderflow", L.orderflow, opts.minLayerScore),
    L6_positioning: layerRow("positioning", L.positioning, opts.minPositioningScore),
    L7_volatility: {
      key: "volatility",
      score: L.volatility?.score ?? 0,
      pass: L.volatility?.pass === true,
      gate: true,
      detail: L.volatility?.detail ?? {},
    },
    composite: Math.round(ev.score ?? 0),
    compositeBreakdown: comp.breakdown,
    orderFlowCore: comp.orderFlowCore,
    bookScore: comp.bookScore,
    oiScore: comp.oiScore,
    fundScore: comp.fundScore,
    triggerAvg: comp.triggerAvg,
    layersAllPass: ev.layersAllPass,
    hardVetoesOk: ev.hardVetoesOk,
    signalOk: ev.signalOk,
    direction: ev.direction,
    displayDirection: ev.displayDirection,
    brackets: ev.brackets,
  };
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

console.error(`\n=== MLCTS recent audit ${SYMBOL} ${FROM} → ${iso(analysisEndMs)} ===`);

const padFrom = mlctsPadFromMs(fromMs, TF);
console.error("Refreshing klines, funding, Vision feeds…");
await ensureKlines(SYMBOL, TF, { from: padFrom, to: analysisEndMs + 900_000, market: "futures" }).catch(
  (e) => console.warn("klines:", e?.message),
);
await ensureMlctsVisionData(SYMBOL, padFrom, analysisEndMs + 900_000, { force: false }).catch((e) =>
  console.warn("vision:", e?.message),
);

const candles = await readCandles(SYMBOL, TF, padFrom, analysisEndMs + 900_000, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, analysisEndMs + 900_000).catch(() => []);
const baseCfg = resolveMlctsCfg({ symbol: SYMBOL, timeframe: TF });
const hydrated = await hydrateMlctsCfg(baseCfg, SYMBOL, fromMs, analysisEndMs + 900_000, {
  ensureVision: false,
});
const weekly = await weeklyLiquidity(SYMBOL);

const marketCtx = {
  oiSeries: hydrated._mlctsOiSeries ?? [],
  fundingSeries: hydrated._mlctsFundingSeries ?? [],
  bookImbalanceSeries: hydrated._mlctsBookImbalanceSeries ?? [],
};

const windowCandles = candles.filter((c) => c.ts >= padFrom && c.ts <= analysisEndMs + 900_000);
const pre = precomputeIntraday(windowCandles);
const ofTier = resolveSeriesDataTier(windowCandles);

const opts = optsFromMlctsCfg(baseCfg);
const extras = { ...marketCtx, pre, weeklyLiquidity: weekly };

/** Bar-level harvest in analysis window (signal logic evaluated per threshold later). */
const barAudits = [];
for (let i = MLCTS_WARMUP; i < windowCandles.length; i++) {
  const ts = windowCandles[i].ts;
  if (ts < fromMs || ts >= analysisEndMs) continue;
  const bookRow = marketCtx.bookImbalanceSeries.find((r, idx, arr) => {
    const next = arr[idx + 1];
    return r.ts <= ts && (!next || next.ts > ts);
  });
  let bookImb = bookRow?.imbalanceRatio ?? null;
  if (bookImb == null) {
    for (let j = marketCtx.bookImbalanceSeries.length - 1; j >= 0; j--) {
      if (marketCtx.bookImbalanceSeries[j].ts <= ts) {
        bookImb = marketCtx.bookImbalanceSeries[j].imbalanceRatio;
        break;
      }
    }
  }
  const ev = evaluateMlctsLayers(windowCandles, i, opts, {
    ...extras,
    orderBookImbalance: bookImb,
  });
  const comp = computeMlctsCompositeScore(ev.layers, opts);
  barAudits.push({
    ts,
    iso: iso(ts),
    barIndex: i,
    close: windowCandles[i].close,
    layers: summarizeLayers(ev, comp, opts),
    blockers: {
      noDirection: !ev.direction,
      l7Fail: !ev.layers?.volatility?.pass,
      noBrackets: !ev.brackets,
    },
  });
}

/** Threshold sweep: signals + full sim. */
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
  const adapter = buildMlctsBacktestAdapter(windowCandles, cfg, TF, marketCtx);
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

  const signals = barAudits.filter((b) => {
    const evOpts = { ...opts, scoreThreshold: threshold };
    const idx = b.barIndex;
    const ts = b.ts;
    let bookImb = null;
    for (let j = marketCtx.bookImbalanceSeries.length - 1; j >= 0; j--) {
      if (marketCtx.bookImbalanceSeries[j].ts <= ts) {
        bookImb = marketCtx.bookImbalanceSeries[j].imbalanceRatio;
        break;
      }
    }
    const ev = evaluateMlctsLayers(windowCandles, idx, evOpts, { ...extras, orderBookImbalance: bookImb });
    return ev.signalOk && ev.direction;
  });

  const metrics = computeAllMetrics({
    trades,
    equityCurve: sim.equityCurve ?? [],
    tf: TF,
    startingEquity: START,
  });
  const rStat = rMultipleStats(trades);

  thresholdResults.push({
    threshold,
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
      ts: s.ts,
      side: s.layers.direction,
      composite: s.layers.composite,
      L1: s.layers.L1_trend.score,
      L2: s.layers.L2_liquidity.score,
      L3: s.layers.L3_sweep.score,
      L4: s.layers.L4_structure.score,
      L5: s.layers.L5_orderflow.score,
      L6: s.layers.L6_positioning.score,
      L7_pass: s.layers.L7_volatility.pass,
      bookScore: s.layers.bookScore,
      layersAllPass: s.layers.layersAllPass,
      sl: s.layers.brackets?.slPrice,
      tp: s.layers.brackets?.tpPrice,
    })),
    trades: trades.map((t) => ({
      entryIso: iso(Number(t.entryTs ?? t.openTs ?? t.ts)),
      exitIso: iso(Number(t.exitTs ?? t.closeTs ?? 0)),
      side: t.side ?? t.action,
      entry: t.entryPrice ?? t.entryFill,
      exit: t.exitPrice ?? t.exitFill,
      netPnl: t.netPnl,
      exitReason: t.exitReason ?? t.reason,
      rMultiple: t.rMultiple ?? null,
    })),
  });
}

const compositeScores = barAudits.map((b) => b.layers.composite).sort((a, b) => a - b);
const pct = (p) => {
  if (!compositeScores.length) return null;
  const idx = (compositeScores.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return compositeScores[lo];
  return compositeScores[lo] + (compositeScores[hi] - compositeScores[lo]) * (idx - lo);
};

const report = {
  generatedAt: new Date().toISOString(),
  symbol: SYMBOL,
  timeframe: TF,
  window: { from: FROM, to: iso(analysisEndMs), fromMs, toMs: analysisEndMs },
  dataQuality: {
    candles: windowCandles.length,
    analysisBars: barAudits.length,
    orderFlowTier: ofTier,
    feedCoverage: hydrated._mlctsFeedCoverage ?? {},
    weeklyLiquidity: weekly,
    padBars: windowCandles.length - barAudits.length,
  },
  compositeInWindow: {
    min: compositeScores[0] ?? null,
    p50: Math.round(pct(0.5) ?? 0),
    p95: Math.round(pct(0.95) ?? 0),
    max: compositeScores[compositeScores.length - 1] ?? null,
  },
  entryGateReminder:
    "signalOk = direction(BULL/BEAR) + L7 vol pass + composite >= threshold + valid brackets; layersAllPass is diagnostic only",
  thresholdResults,
  allBarAudits: barAudits,
};

const outPath = path.join(__dirname, `.mlcts-recent-signals-${SYMBOL}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(
  JSON.stringify(
    {
      outPath,
      window: report.window,
      dataQuality: report.dataQuality,
      compositeInWindow: report.compositeInWindow,
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
