/**
 * MLCTS — Multi-Layer Confluence Trading System (bar-close).
 */
import { dayStore } from "./adapterPersisted.js";
import { utcDayId } from "./techniques/liquidity.js";
import {
  buildMlctsSeries,
  evaluateMlctsLayers,
  MLCTS_DEFAULTS,
  MLCTS_DISPLAY_WARMUP,
  MLCTS_PAD_BARS,
  MLCTS_WARMUP,
} from "./techniques/mlctsLayers.js";
import { buildMlctsFeedStatus } from "./mlctsFeedStatus.js";
import { getCachedWeeklyLiquidity } from "./weeklyLiquidityCache.js";
import { precomputeIntraday } from "./intradayPro.js";
import { MLCTS_BTC_15M } from "./presets/mlctsOptimized.js";
import { ensureOpenInterest, readOpenInterest } from "../backtest/data/openInterestIngest.js";
import { ensureFunding, readFundingRates } from "../backtest/data/fundingIngest.js";
import {
  ensureMlctsVisionData,
  mergeMlctsOiSeries,
  normalizeVisionMetricsOiSeries,
  readBookImbalanceSeries,
  readVisionMetrics,
} from "../backtest/data/mlctsVisionIngest.js";

const MLCTS_USER_KEYS = [
  "symbol",
  "timeframe",
  "marketMode",
  "market",
  "futuresLeverage",
  "leverage",
  "futuresLeverageMode",
  "backtestPositionSizing",
  "riskPerTrade",
  "riskPerTradeUnit",
  "mlctsScoreThreshold",
  "mlctsMinLayerScore",
  "mlctsSwingLeft",
  "mlctsSwingRight",
  "mlctsSwingConfirmBars",
  "mlctsSweepPct",
  "mlctsEqualHighTolAtr",
  "mlctsMinAdx",
  "mlctsStrongAdx",
  "mlctsVolGateAtrMult",
  "mlctsVolGateRvol",
  "mlctsTargetRr",
  "mlctsSlAtrBuffer",
  "mlctsMaxTradesPerDay",
  "mlctsMinBarGap",
  "mlctsMaxHoldBars",
  "mlctsWeightTrend",
  "mlctsWeightLiquidity",
  "mlctsWeightTrigger",
  "mlctsWeightOrderFlow",
  "mlctsWeightBook",
  "mlctsWeightOi",
  "mlctsWeightFunding",
  "mlctsRequireOrderBook",
  "mlctsRequireOi",
  "intradayLiqPartialTp",
  "intradayLiqTp1Enabled",
  "intradayLiqTp2Enabled",
  "intradayLiqBreakevenAfterPartial",
  "intradayLiqEntryAtSignalClose",
];

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function resolveMlctsCfg(cfg = {}) {
  const out = { ...MLCTS_BTC_15M };
  for (const k of MLCTS_USER_KEYS) {
    if (cfg[k] !== undefined) out[k] = cfg[k];
  }
  out.manualStrategy = "MLCTS";
  out.strategyMode = cfg.strategyMode ?? "MANUAL";
  return out;
}

export function optsFromMlctsCfg(cfg = {}) {
  const c = resolveMlctsCfg(cfg);
  return {
    ...MLCTS_DEFAULTS,
    swingLeft: num(c.mlctsSwingLeft, MLCTS_DEFAULTS.swingLeft),
    swingRight: num(c.mlctsSwingRight, MLCTS_DEFAULTS.swingRight),
    swingConfirmBars: num(c.mlctsSwingConfirmBars, MLCTS_DEFAULTS.swingConfirmBars),
    sweepPct: num(c.mlctsSweepPct, MLCTS_DEFAULTS.sweepPct),
    equalHighTolAtr: num(c.mlctsEqualHighTolAtr, MLCTS_DEFAULTS.equalHighTolAtr),
    minAdx: num(c.mlctsMinAdx, MLCTS_DEFAULTS.minAdx),
    strongAdx: num(c.mlctsStrongAdx, MLCTS_DEFAULTS.strongAdx),
    scoreThreshold: num(c.mlctsScoreThreshold, MLCTS_DEFAULTS.scoreThreshold),
    minLayerScore: num(c.mlctsMinLayerScore, MLCTS_DEFAULTS.minLayerScore),
    minPositioningScore: num(c.mlctsMinPositioningScore, MLCTS_DEFAULTS.minPositioningScore),
    volGateAtrMult: num(c.mlctsVolGateAtrMult, MLCTS_DEFAULTS.volGateAtrMult),
    volGateRvol: num(c.mlctsVolGateRvol, MLCTS_DEFAULTS.volGateRvol),
    targetRr: num(c.mlctsTargetRr, MLCTS_DEFAULTS.targetRr),
    slAtrBuffer: num(c.mlctsSlAtrBuffer, MLCTS_DEFAULTS.slAtrBuffer),
    maxTradesPerDay: num(c.mlctsMaxTradesPerDay, 6),
    minBarGap: num(c.mlctsMinBarGap, 3),
    weightTrend: num(c.mlctsWeightTrend, MLCTS_DEFAULTS.weightTrend),
    weightLiquidity: num(c.mlctsWeightLiquidity, MLCTS_DEFAULTS.weightLiquidity),
    weightTrigger: num(c.mlctsWeightTrigger, MLCTS_DEFAULTS.weightTrigger),
    weightOrderFlow: num(c.mlctsWeightOrderFlow, MLCTS_DEFAULTS.weightOrderFlow),
    weightBook: num(c.mlctsWeightBook, MLCTS_DEFAULTS.weightBook),
    weightOi: num(c.mlctsWeightOi, MLCTS_DEFAULTS.weightOi),
    weightFunding: num(c.mlctsWeightFunding, MLCTS_DEFAULTS.weightFunding),
    requireOrderBook: c.mlctsRequireOrderBook === true,
    requireOi: c.mlctsRequireOi === true,
  };
}

export function mlctsPadFromMs(fromMs, tf = "15m") {
  const tfMs =
    tf === "1m" ? 60_000 : tf === "5m" ? 300_000 : tf === "15m" ? 900_000 : tf === "1h" ? 3_600_000 : 900_000;
  return fromMs - MLCTS_PAD_BARS * tfMs;
}

function normalizeOiSeries(rows) {
  // Rows are 1h-period OI snapshots; compute a true 4h delta (4 rows back) so the
  // backtest horizon matches the live collector's change4hPct.
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];
    const prev = rows[Math.max(0, i - 4)];
    const oiNow = num(cur?.oiUsdt ?? cur?.usdt, 0);
    const oiPrev = num(prev?.oiUsdt ?? prev?.usdt, oiNow);
    const changePct = i > 0 && oiPrev > 0 ? ((oiNow - oiPrev) / oiPrev) * 100 : 0;
    out.push({ ts: num(cur?.ts), changePct, change4hPct: changePct });
  }
  return out;
}

function normalizeFundingSeries(rows) {
  return (rows ?? []).map((r) => ({
    ts: num(r?.ts),
    rate: num(r?.rate),
    current: num(r?.rate),
  }));
}

export async function hydrateMlctsCfg(cfg, symbol, fromMs, toMs, opts = {}) {
  const c = resolveMlctsCfg(cfg);
  const padFrom = mlctsPadFromMs(fromMs, c.timeframe ?? "15m");
  const hydrated = await hydrateMlctsMarketSeries(symbol, padFrom, toMs, opts);
  return {
    ...c,
    _mlctsOiSeries: hydrated.oiSeries,
    _mlctsFundingSeries: hydrated.fundingSeries,
    _mlctsBookImbalanceSeries: hydrated.bookImbalanceSeries,
    _mlctsFeedCoverage: hydrated.feedCoverage,
  };
}

export async function hydrateMlctsMarketSeries(symbol, fromMs, toMs, opts = {}) {
  const sym = String(symbol || "BTCUSDT").toUpperCase();
  if (opts.ensureVision !== false) {
    await ensureMlctsVisionData(sym, fromMs, toMs, { force: opts.forceVision === true }).catch(() => {});
  }
  await ensureOpenInterest(sym, { from: fromMs, to: toMs, period: "1h" }).catch(() => {});
  await ensureFunding(sym, { from: fromMs, to: toMs }).catch(() => {});

  const visionRaw = await readVisionMetrics(sym, fromMs, toMs).catch(() => []);
  const visionOi = normalizeVisionMetricsOiSeries(visionRaw);
  const oiRaw = await readOpenInterest(sym, fromMs, toMs).catch(() => []);
  const restOi = normalizeOiSeries(oiRaw);
  const oiSeries = visionOi.length ? mergeMlctsOiSeries(visionOi, restOi) : restOi;

  const bookImbalanceSeries = await readBookImbalanceSeries(sym, fromMs, toMs).catch(() => []);
  const fundRaw = await readFundingRates(sym, fromMs, toMs).catch(() => []);

  return {
    oiSeries,
    fundingSeries: normalizeFundingSeries(fundRaw),
    bookImbalanceSeries,
    feedCoverage: {
      visionMetricsPoints: visionRaw.length,
      bookImbalanceSnapshots: bookImbalanceSeries.length,
      oiSeriesPoints: oiSeries.length,
      fundingPoints: fundRaw.length,
    },
  };
}

export function buildMlctsLayerSnapshot(candles, cfg = {}, extras = {}) {
  const sym = String(cfg.symbol ?? "BTCUSDT").toUpperCase();
  if (!candles?.length) {
    return {
      symbol: sym,
      ready: false,
      layers: {},
      score: 0,
      allRequiredGreen: false,
      feeds: extras.feeds ?? buildMlctsFeedStatus({ symbol: sym }),
      weeklyLiquidity: extras.weeklyLiquidity ?? getCachedWeeklyLiquidity(sym),
    };
  }
  const opts = optsFromMlctsCfg(cfg);
  const idx = candles.length - 1;
  const pre = precomputeIntraday(candles);
  const weeklyLiquidity = extras.weeklyLiquidity ?? getCachedWeeklyLiquidity(sym);
  const ev = evaluateMlctsLayers(candles, idx, opts, { ...extras, pre, weeklyLiquidity, forDisplay: true });
  return {
    symbol: sym,
    updatedAt: Date.now(),
    ready: ev.ready,
    warmingUp: ev.warmingUp === true,
    barCount: candles.length,
    barsNeeded: ev.barsNeeded ?? MLCTS_WARMUP,
    score: ev.score,
    direction: ev.direction,
    displayDirection: ev.displayDirection ?? null,
    allRequiredGreen: ev.allRequiredGreen,
    signalOk: ev.signalOk,
    layersAllPass: ev.layersAllPass,
    hardVetoesOk: ev.hardVetoesOk,
    scoreOk: ev.scoreOk,
    scoreThreshold: opts.scoreThreshold,
    minLayerScore: opts.minLayerScore,
    layers: serializeLayersForUi(ev.layers, opts),
    featureVector: ev.featureVector,
    feeds: extras.feeds ?? buildMlctsFeedStatus({ symbol: sym }),
  };
}

function serializeLayersForUi(layers = {}, opts = {}) {
  const order = ["trend", "liquidity", "sweep", "structure", "orderflow", "positioning", "volatility"];
  const minLayerScore = Number(opts.minLayerScore) > 0 ? Number(opts.minLayerScore) : 50;
  const minPositioningScore =
    Number(opts.minPositioningScore) > 0 ? Number(opts.minPositioningScore) : 45;
  const labels = {
    trend: "L1 Trend (swings · EMA20/50/200 · ADX)",
    liquidity: "L2 Liquidity (PDH/PDL · weekly · EQH/EQL · VWAP)",
    sweep: "L3 Sweep (wick · reclaim · depth/ATR)",
    structure: "L4 BOS + displacement",
    orderflow: "L5 Order flow (Δ · CVD · absorption · book)",
    positioning: "L6 Positioning (OI class · funding)",
    volatility: "L7 Volatility gate (ATR · RVOL)",
  };
  const out = {};
  let prevPass = true;
  for (const key of order) {
    const row = layers[key] ?? { score: 0, pass: false, detail: {} };
    const pass = row.pass === true;
    const cleared = prevPass && pass;
    const blocked = !prevPass;
    const failed = prevPass && !pass;
    out[key] = {
      key,
      label: labels[key] ?? key,
      score: row.score ?? 0,
      pass,
      cleared,
      blocked,
      failed,
      active: prevPass,
      scoreMax: key === "volatility" ? 100 : 100,
      minScore:
        key === "volatility" ? null : key === "positioning" ? minPositioningScore : minLayerScore,
      required: key !== "positioning" || true,
      isGate: key === "volatility",
      detail: row.detail ?? {},
    };
    if (!pass) prevPass = false;
  }
  return out;
}

export function buildMlctsBacktestAdapter(candles, cfg = {}, _tf = "15m", marketCtx = {}) {
  const opts = optsFromMlctsCfg(cfg);
  const extras = {
    oiSeries: marketCtx.oiSeries ?? [],
    fundingSeries: marketCtx.fundingSeries ?? [],
    bookImbalanceSeries: marketCtx.bookImbalanceSeries ?? [],
  };
  const { series } = buildMlctsSeries(candles, opts, extras);
  let lastSignalIdx = -Infinity;
  let tradesToday = 0;
  let curDay = null;
  const dayLocal = { lastSignalIdx: -Infinity, tradesToday: 0, curDay: null };

  return function mlctsAdapter(bar, idx, ctx) {
    if (idx < MLCTS_WARMUP) return null;
    const dDay = dayStore(ctx, dayLocal);
    const day = utcDayId(bar.ts);
    if (day !== (ctx?.persisted ? dDay.curDay : curDay)) {
      if (ctx?.persisted) {
        dDay.curDay = day;
        dDay.tradesToday = 0;
      } else {
        curDay = day;
        tradesToday = 0;
      }
    }
    const sig = series[idx];
    if (!sig) return null;
    const tradesCount = ctx?.persisted ? dDay.tradesToday : tradesToday;
    if (tradesCount >= opts.maxTradesPerDay) return null;
    const lastIdx = ctx?.persisted ? dDay.lastSignalIdx : lastSignalIdx;
    if (idx - lastIdx < opts.minBarGap) return null;

    if (ctx?.persisted) {
      dDay.lastSignalIdx = idx;
      dDay.tradesToday = tradesCount + 1;
    } else {
      lastSignalIdx = idx;
      tradesToday += 1;
    }
    return {
      action: sig.action,
      reason: sig.reason,
      trigger: sig.trigger,
      playbook: sig.playbook,
      liqBrackets: sig.liqBrackets,
      mlctsContext: sig.mlctsContext,
      mlctsLayers: sig.mlctsLayers,
    };
  };
}

export function buildMlctsLiveSnapshotFromBot(state, feed, intelligenceCache = {}) {
  const sym = String(state?.symbol || "BTCUSDT").toUpperCase();
  const symKey = sym.replace(/[^A-Za-z0-9]/g, "");
  const candles =
    typeof feed?.getCandlesForSymbol === "function"
      ? feed.getCandlesForSymbol(sym)
      : feed?.getCandles?.() ?? [];
  const oi = intelligenceCache.openInterest?.[symKey] ?? intelligenceCache.openInterest?.[sym] ?? null;
  const funding = intelligenceCache.funding?.[symKey] ?? intelligenceCache.funding?.[sym] ?? null;
  const book = intelligenceCache.orderBook?.[symKey] ?? intelligenceCache.orderBook?.[sym] ?? null;

  // ts: 0 — "latest known value". lookupSeriesAt() only accepts rows with ts <= bar
  // open time, so stamping Date.now() would make live OI/funding invisible to L6.
  const oiSeries = oi
    ? [{ ts: 0, changePct: oi.change4hPct ?? 0, change4hPct: oi.change4hPct ?? 0 }]
    : [];
  const fundingSeries = funding
    ? [{ ts: 0, rate: funding.current ?? 0, current: funding.current ?? 0 }]
    : [];

  return buildMlctsLayerSnapshot(
    Array.isArray(candles) ? candles : [],
    { ...state, symbol: sym },
    {
      oiSeries,
      fundingSeries,
      orderBookImbalance: book?.imbalanceRatio ?? null,
      weeklyLiquidity: getCachedWeeklyLiquidity(sym),
      feeds: buildMlctsFeedStatus({ symbol: sym }),
    },
  );
}

export function signal({ candles, cfg, oiSeries, fundingSeries, orderBookImbalance } = {}) {
  if (!candles?.length) return { action: "HOLD", reason: "no_candles" };
  const opts = optsFromMlctsCfg(cfg || {});
  const idx = candles.length - 1;
  const pre = precomputeIntraday(candles);
  const ev = evaluateMlctsLayers(candles, idx, opts, {
    oiSeries: oiSeries ?? [],
    fundingSeries: fundingSeries ?? [],
    orderBookImbalance,
    pre,
  });
  if (!ev.signalOk || !ev.direction) {
    return {
      action: "HOLD",
      reason: `mlcts_incomplete_score_${ev.score}`,
      mlctsLayerStatus: buildMlctsLayerSnapshot(candles, cfg, {
        oiSeries,
        fundingSeries,
        orderBookImbalance,
      }),
    };
  }
  return {
    action: ev.direction,
    reason: `mlcts_score_${ev.score}`,
    trigger: "mlcts_confluence",
    playbook: "MLCTS",
    liqBrackets: ev.brackets,
    mlctsContext: ev.featureVector,
    mlctsLayers: ev.layers,
    mlctsLayerStatus: buildMlctsLayerSnapshot(candles, cfg, {
      oiSeries,
      fundingSeries,
      orderBookImbalance,
    }),
  };
}

export const MLCTS = {
  name: "MLCTS — multi-layer confluence (research)",
  signal,
};
