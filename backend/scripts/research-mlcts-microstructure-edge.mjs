#!/usr/bin/env node
/**
 * Microstructure-only edge screen — skip L1–L4; test OI, funding, delta, book, combos.
 *
 * Usage (backend/):
 *   FROM=2026-01-01 TO=2026-07-01 SCORE_THRESHOLDS=60,65,70 \
 *     node scripts/research-mlcts-microstructure-edge.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = (process.env.SYMBOL || "BTCUSDT").toUpperCase();
const FROM = process.env.FROM || "2026-01-01";
const TO = process.env.TO || "2026-07-01";
const SCORE_THRESHOLDS = (process.env.SCORE_THRESHOLDS || "60,65,70")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));
const START = Number(process.env.START_USDT || 10_000);
const MIN_SIDE_SPREAD = Number(process.env.MIN_SIDE_SPREAD || 15);

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO) > fromMs ? Date.parse(TO) : Date.now();
const analysisEndMs = Math.min(toMs, Date.now());

const { fetchBinanceKlinesRange } = await import("../src/lib/binanceKlinesRest.js");
const { loadMlctsVisionFeedsMemory } = await import("../src/backtest/data/mlctsVisionIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const {
  evaluateMlctsMicroScores,
  buildMlctsBrackets,
  MLCTS_WARMUP,
} = await import("../src/strategy/techniques/mlctsLayers.js");
const { precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const { optsFromMlctsCfg, resolveMlctsCfg, mlctsPadFromMs } = await import("../src/strategy/mlctsIntraday.js");
const { utcDayId } = await import("../src/strategy/techniques/liquidity.js");

function lookupBook(series, ts) {
  let best = null;
  for (const row of series ?? []) {
    if (row.ts <= ts) best = row;
    else break;
  }
  return best?.imbalanceRatio ?? null;
}

function pickSide(buyScore, sellScore, minScore) {
  if (buyScore >= minScore && buyScore - sellScore >= MIN_SIDE_SPREAD) return { side: "BUY", score: buyScore };
  if (sellScore >= minScore && sellScore - buyScore >= MIN_SIDE_SPREAD) return { side: "SELL", score: sellScore };
  return null;
}

function scorePair(micro, key) {
  const custom = {
    oi_plus_funding: () => ({
      buy: (micro.sides.BUY.oiScore + micro.sides.BUY.fundScore) / 2,
      sell: (micro.sides.SELL.oiScore + micro.sides.SELL.fundScore) / 2,
    }),
    delta_plus_book: () => ({
      buy: (micro.sides.BUY.deltaScore + micro.sides.BUY.bookScore) / 2,
      sell: (micro.sides.SELL.deltaScore + micro.sides.SELL.bookScore) / 2,
    }),
    positioning_plus_orderflow: () => ({
      buy: (micro.sides.BUY.positioningScore + micro.sides.BUY.orderflowScore) / 2,
      sell: (micro.sides.SELL.positioningScore + micro.sides.SELL.orderflowScore) / 2,
    }),
  };
  if (custom[key]) return custom[key]();
  const map = {
    delta: ["deltaScore", "deltaScore"],
    cvd_div: ["divScore", "divScore"],
    absorption: ["absScore", "absScore"],
    book: ["bookScore", "bookScore"],
    orderflow_core: ["orderflowCore", "orderflowCore"],
    orderflow_l5: ["orderflowScore", "orderflowScore"],
    oi: ["oiScore", "oiScore"],
    funding: ["fundScore", "fundScore"],
    positioning_l6: ["positioningScore", "positioningScore"],
    volatility_l7: ["volatilityScore", "volatilityScore"],
    l567_confidence: ["confidence", "confidence"],
  };
  const [bk, sk] = map[key] ?? ["confidence", "confidence"];
  return { buy: micro.sides.BUY[bk], sell: micro.sides.SELL[sk] };
}

const HYPOTHESES = [
  { id: "delta", label: "Bar delta (taker flow)" },
  { id: "cvd_div", label: "CVD divergence" },
  { id: "absorption", label: "Absorption pattern" },
  { id: "book", label: "Book imbalance (Vision proxy)" },
  { id: "orderflow_core", label: "L5 core (delta+div+abs, no book)" },
  { id: "orderflow_l5", label: "L5 full (+ book in blend)" },
  { id: "oi", label: "OI class score" },
  { id: "funding", label: "Funding rate score" },
  { id: "positioning_l6", label: "L6 positioning (OI+funding blend)" },
  { id: "volatility_l7", label: "L7 volatility score only" },
  { id: "oi_plus_funding", label: "OI + funding average" },
  { id: "delta_plus_book", label: "Delta + book average" },
  { id: "positioning_plus_orderflow", label: "L6 + L5 average" },
  { id: "l567_confidence", label: "L5+L6+L7 weighted confidence" },
];

console.error(`\n=== MLCTS microstructure edge (no L1–L4) ${SYMBOL} ${FROM} → ${TO} ===`);

const padFrom = mlctsPadFromMs(fromMs, "15m");
const windowCandles = await fetchBinanceKlinesRange({
  symbol: SYMBOL,
  interval: "15m",
  startTime: padFrom,
  endTime: analysisEndMs + 900_000,
  feedKind: "BINANCE_FUTURES",
  chartPublic: true,
});
console.error(`klines: ${windowCandles.length}`);

const funding = [];
const axios = (await import("axios")).default;
const FAPI = process.env.BINANCE_FUTURES_REST_BASE || "https://fapi.binance.com";
let fStart = padFrom;
while (fStart < analysisEndMs) {
  const { data } = await axios.get(`${FAPI}/fapi/v1/fundingRate`, {
    params: { symbol: SYMBOL, startTime: fStart, endTime: analysisEndMs, limit: 1000 },
    timeout: 20_000,
  });
  if (!Array.isArray(data) || !data.length) break;
  for (const row of data) funding.push({ ts: Number(row.fundingTime), rate: Number(row.fundingRate) });
  fStart = Number(data[data.length - 1].fundingTime) + 1;
  if (data.length < 1000) break;
}

console.error("Vision OI + book…");
let lastDay = "";
const vision = await loadMlctsVisionFeedsMemory(SYMBOL, padFrom, analysisEndMs + 900_000, {
  onProgress: ({ day, i, n }) => {
    if (day !== lastDay && (i % 25 === 0 || i < 2)) {
      lastDay = day;
      console.error(`  vision ${day} (${i + 1}/${n})`);
    }
  },
});

const marketCtx = {
  oiSeries: vision.oiSeries,
  fundingSeries: funding.map((r) => ({ ts: r.ts, rate: r.rate, current: r.rate })),
  bookImbalanceSeries: vision.bookImbalanceSeries,
};
const pre = precomputeIntraday(windowCandles);
const opts = optsFromMlctsCfg(resolveMlctsCfg({ symbol: SYMBOL, timeframe: "15m" }));

console.error("Scoring L5–L7 both sides per bar…");
const microByIdx = new Map();
for (let i = MLCTS_WARMUP; i < windowCandles.length; i++) {
  const ts = windowCandles[i].ts;
  const micro = evaluateMlctsMicroScores(windowCandles, i, opts, {
    pre,
    ...marketCtx,
    orderBookImbalance: lookupBook(marketCtx.bookImbalanceSeries, ts),
  });
  if (micro) microByIdx.set(i, micro);
}

function buildMicroAdapter(hypothesisId, minScore) {
  const series = new Array(windowCandles.length).fill(null);
  for (let i = MLCTS_WARMUP; i < windowCandles.length; i++) {
    const ts = windowCandles[i].ts;
    if (ts < fromMs || ts >= analysisEndMs) continue;
    const micro = microByIdx.get(i);
    if (!micro) continue;
    const { buy, sell } = scorePair(micro, hypothesisId);
    const pick = pickSide(buy, sell, minScore);
    if (!pick) continue;
    const layers = {
      sweep: {
        detail: { wick: pick.side === "BUY" ? windowCandles[i].low : windowCandles[i].high },
      },
    };
    const brackets = buildMlctsBrackets(windowCandles, i, pick.side, layers, opts, pre);
    if (!brackets) continue;
    series[i] = {
      action: pick.side,
      reason: `micro_${hypothesisId}_${Math.round(pick.score)}`,
      trigger: hypothesisId,
      playbook: "MLCTS_MICRO",
      liqBrackets: brackets,
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

const cfg = {
  ...resolveMlctsCfg({ symbol: SYMBOL, timeframe: "15m" }),
  symbol: SYMBOL,
  timeframe: "15m",
  manualStrategy: "MLCTS",
  marketMode: "FUTURES",
  backtestSignalStartMs: fromMs,
  riskPerTrade: 1,
  riskPerTradeUnit: "PCT",
  futuresLeverage: 10,
};

const results = [];
for (const hyp of HYPOTHESES) {
  for (const thresh of SCORE_THRESHOLDS) {
    process.stderr.write(`  sim ${hyp.id} @ ${thresh}…\n`);
    const adapter = buildMicroAdapter(hyp.id, thresh);
    const sim = await runSimulation({
      candles: windowCandles,
      strategyKey: "MLCTS",
      cfg,
      gateMode: "off",
      fundingRates: funding,
      startingUsdt: START,
      timeframe: "15m",
      symbol: SYMBOL,
      adapters: { MLCTS: adapter },
      costModelOverride: { leverage: 10, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
    });
    const trades = (sim.trades ?? []).filter((t) => {
      const entry = Number(t.entryTs ?? t.openTs ?? t.ts);
      return entry >= fromMs && entry < analysisEndMs;
    });
    const weeks = Math.max(0.01, (analysisEndMs - fromMs) / (7 * 86400000));
    const m = computeAllMetrics({ trades, equityCurve: sim.equityCurve ?? [], tf: "15m", startingEquity: START });
    const rStat = rMultipleStats(trades);
    results.push({
      hypothesis: hyp.id,
      label: hyp.label,
      scoreThreshold: thresh,
      trades: trades.length,
      tradesPerWeek: +(trades.length / weeks).toFixed(2),
      returnPct: +(m.totalReturnPct ?? 0).toFixed(2),
      pf: +(m.profitFactor ?? 0).toFixed(3),
      winRate: +((m.winRate ?? 0) * 100).toFixed(1),
      meanR: +(rStat.rMean ?? 0).toFixed(3),
      maxDd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
      expectancyR: +(rStat.rMean ?? 0).toFixed(3),
    });
  }
}

results.sort((a, b) => b.pf - a.pf || b.returnPct - a.returnPct);

const positivePf = results.filter((r) => r.pf >= 1 && r.trades >= 30);
const report = {
  generatedAt: new Date().toISOString(),
  hypothesis: "Skip L1–L4 entirely; enter on microstructure score (side = higher score if spread >= 15)",
  window: { from: FROM, to: new Date(analysisEndMs).toISOString() },
  data: {
    bars: windowCandles.length,
    oiPoints: vision.oiSeries.length,
    bookSnapshots: vision.bookImbalanceSeries.length,
    fundingEvents: funding.length,
  },
  entryRule: {
    minSideSpread: MIN_SIDE_SPREAD,
    brackets: "ATR from bar wick (no sweep level)",
    costs: "4bps/side + 0.05% slip, 10x lev, 1% risk",
  },
  resultsSortedByPf: results,
  passingPfGte1_tradesGte30: positivePf,
  bestPerHypothesis: HYPOTHESES.map((h) => {
    const rows = results.filter((r) => r.hypothesis === h.id);
    const best = rows.sort((a, b) => b.pf - a.pf || b.trades - a.trades)[0];
    return best ? { ...best, label: h.label } : null;
  }).filter(Boolean),
};

const outPath = path.join(__dirname, `.mlcts-microstructure-edge-${SYMBOL}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(
  JSON.stringify(
    {
      outPath,
      window: report.window,
      passingPfGte1_min30Trades: positivePf,
      bestPerHypothesis: report.bestPerHypothesis.map((r) => ({
        id: r.hypothesis,
        thresh: r.scoreThreshold,
        trades: r.trades,
        perWeek: r.tradesPerWeek,
        returnPct: r.returnPct,
        pf: r.pf,
        meanR: r.meanR,
      })),
      top5Overall: results.slice(0, 5),
      bottom5Overall: results.slice(-5),
    },
    null,
    2,
  ),
);
