/**
 * Per-trade technical features for backtest CSV export.
 * Fetches candles once per symbol; vectorized indicators; O(1) entry lookup per trade.
 */
import { readCandles } from "../data/klineIngest.js";
import { ema, atr, adx, rsi } from "../../strategy/indicators.js";
import { swingHighLow } from "../../strategy/techniques/fibonacci.js";
import { barIndexContainingMs, chartTfToMs, isoToMs } from "./tradeCsvTime.js";

const WARMUP_BARS = 220;
const SWING_LOOKBACK = 48;
const ATR_PCT_LOOKBACK = 100;

function sma(values, period) {
  const out = new Array(values.length).fill(0);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] ?? 0;
    if (i >= period) sum -= values[i - period] ?? 0;
    out[i] = i >= period - 1 ? sum / period : sum / (i + 1);
  }
  return out;
}

function rollingPercentileRank(series, idx, lookback) {
  const v = series[idx];
  if (v == null || !Number.isFinite(v)) return null;
  const start = Math.max(0, idx - lookback + 1);
  const window = [];
  for (let i = start; i <= idx; i++) {
    const x = series[i];
    if (x != null && Number.isFinite(x)) window.push(x);
  }
  if (window.length < 2) return null;
  const below = window.filter((x) => x < v).length;
  return (below / window.length) * 100;
}

function distPct(price, level) {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(level)) return null;
  return ((price - level) / price) * 100;
}

function emaStackLabel(e20, e50, e200) {
  if (!Number.isFinite(e20) || !Number.isFinite(e50) || !Number.isFinite(e200)) return "";
  if (e20 > e50 && e50 > e200) return "bullish";
  if (e20 < e50 && e50 < e200) return "bearish";
  return "mixed";
}

function candleAnatomy(c) {
  if (!c) return { bodyPct: null, upperWickPct: null, lowerWickPct: null };
  const range = c.high - c.low;
  if (!Number.isFinite(range) || range <= 0) {
    return { bodyPct: 0, upperWickPct: 0, lowerWickPct: 0 };
  }
  const body = Math.abs(c.close - c.open);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  return {
    bodyPct: (body / range) * 100,
    upperWickPct: (upper / range) * 100,
    lowerWickPct: (lower / range) * 100,
  };
}

/** UTC hour → session bucket (coarse, for ML categoricals). */
export function sessionFromUtcHour(hourUtc) {
  if (hourUtc == null || !Number.isFinite(hourUtc)) return "";
  const h = ((Math.floor(hourUtc) % 24) + 24) % 24;
  const asia = h >= 0 && h < 8;
  const london = h >= 7 && h < 16;
  const ny = h >= 13 && h < 22;
  if (london && ny) return "Overlap";
  if (asia && london) return "AsiaLondon";
  if (asia) return "Asia";
  if (london) return "London";
  if (ny) return "NY";
  return "Off";
}

function weekdayLabel(ms) {
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

function hourUtc(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).getUTCHours();
}

function hourIst(ms) {
  if (!Number.isFinite(ms)) return null;
  const s = new Date(ms).toLocaleString("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    hour12: false,
  });
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function resolveInitialSl(trade) {
  const initial = Number(trade.initialSlPrice);
  if (Number.isFinite(initial) && initial > 0) return initial;
  const sl = Number(trade.slPrice);
  const entry = Number(trade.entryPrice);
  if (Number.isFinite(sl) && sl > 0 && Number.isFinite(entry) && entry > 0) {
    if (Math.abs(entry - sl) / entry > 1e-5) return sl;
  }
  return null;
}

/**
 * Walk bars from entry until SL touch or exit.
 * BUY → max high before SL (Range highest price); SELL → min low before SL (Range lowest price).
 *
 * SL-touch detection skips the entry bar unless `entrySameBar` is true — entry-bar wicks often
 * pierce the eventual stop before the position is live in next-bar fills, which falsely zeros
 * `barsToSlTouch` on winners and multi-bar losers.
 */
export function computeRangeBeforeSl(candles, entryIdx, exitIdx, trade) {
  if (!candles.length || entryIdx < 0 || exitIdx < entryIdx) {
    return { rangeLowestPrice: null, rangeHighestPrice: null, barsToSlTouch: null };
  }
  const sl = resolveInitialSl(trade);
  const isLong = String(trade.direction ?? "BUY").toUpperCase() === "BUY";
  const end = Math.min(exitIdx, candles.length - 1);
  const slCheckFrom = trade.entrySameBar === true ? entryIdx : entryIdx + 1;
  let rangeLow = Infinity;
  let rangeHigh = -Infinity;
  let barsToSl = null;

  for (let i = entryIdx; i <= end; i++) {
    const c = candles[i];
    if (!c) continue;
    rangeLow = Math.min(rangeLow, c.low);
    rangeHigh = Math.max(rangeHigh, c.high);

    if (sl != null && barsToSl == null && i >= slCheckFrom) {
      const touched = isLong ? c.low <= sl : c.high >= sl;
      if (touched) {
        barsToSl = i - entryIdx;
        break;
      }
    }
  }

  return {
    rangeLowestPrice: isLong ? null : Number.isFinite(rangeLow) ? rangeLow : null,
    rangeHighestPrice: isLong ? (Number.isFinite(rangeHigh) ? rangeHigh : null) : null,
    barsToSlTouch: barsToSl,
  };
}

function flattenLiqContext(trade) {
  const ctx = trade.liqContext;
  if (!ctx || typeof ctx !== "object") {
    return { liqAdx: null, liqAtrPct: null, liqRegime: null, liqConfidence: null };
  }
  const features = ctx.features && typeof ctx.features === "object" ? ctx.features : ctx;
  const ms =
    features.marketState && typeof features.marketState === "object" ? features.marketState : features;
  return {
    liqAdx: ms.adx != null && Number.isFinite(Number(ms.adx)) ? Number(ms.adx) : null,
    liqAtrPct: ms.atrPct != null && Number.isFinite(Number(ms.atrPct)) ? Number(ms.atrPct) : null,
    liqRegime: ms.regime != null ? String(ms.regime) : null,
    liqConfidence:
      ms.confidence != null && Number.isFinite(Number(ms.confidence)) ? Number(ms.confidence) : null,
  };
}

export function featuresAtBar(candles, series, idx) {
  const c = candles[idx];
  const close = c?.close ?? 0;
  const atr14 = series.atr14[idx] ?? null;
  const atr14Pct = atr14 != null && close > 0 ? (atr14 / close) * 100 : null;
  const e20 = series.ema20[idx] ?? null;
  const e50 = series.ema50[idx] ?? null;
  const e200 = series.ema200[idx] ?? null;
  const vol = c?.volume ?? null;
  const volAvg = series.volSma20[idx] ?? null;
  const anatomy = candleAnatomy(c);
  const swing = swingHighLow(candles, idx, SWING_LOOKBACK);

  return {
    atr14,
    atr14Pct,
    atrPercentile: rollingPercentileRank(series.atr14Pct, idx, ATR_PCT_LOOKBACK),
    adx14: series.adx14[idx] ?? null,
    rsi14: series.rsi14[idx] ?? null,
    ema20: e20,
    ema50: e50,
    ema200: e200,
    distToEma20Pct: distPct(close, e20),
    distToEma50Pct: distPct(close, e50),
    distToEma200Pct: distPct(close, e200),
    emaStack: emaStackLabel(e20, e50, e200),
    volume: vol,
    volVsAvg20: vol != null && volAvg != null && volAvg > 0 ? vol / volAvg : null,
    bodyPct: anatomy.bodyPct,
    upperWickPct: anatomy.upperWickPct,
    lowerWickPct: anatomy.lowerWickPct,
    swingHigh: swing?.high ?? null,
    distToSwingHighPct: swing?.high != null ? distPct(close, swing.high) : null,
    swingLow: swing?.low ?? null,
    distToSwingLowPct: swing?.low != null ? distPct(close, swing.low) : null,
  };
}

export function buildIndicatorSeries(candles) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume ?? 0);
  const atr14 = atr(candles, 14);
  const atr14Pct = atr14.map((a, i) => {
    const close = closes[i];
    return close > 0 && a != null ? (a / close) * 100 : 0;
  });
  return {
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    atr14,
    atr14Pct,
    adx14: adx(candles, 14),
    rsi14: rsi(closes, 14),
    volSma20: sma(volumes, 20),
  };
}

function tradeSymbol(trade, fallbackSymbol) {
  const s = trade.symbol != null ? String(trade.symbol).trim().toUpperCase() : "";
  return s || String(fallbackSymbol || "BTCUSDT").toUpperCase();
}

async function featuresForSymbolGroup(symbolTrades, { symbol, timeframe, market, fallbackSymbol }) {
  const sym = tradeSymbol(symbolTrades[0], symbol || fallbackSymbol);
  const tfMs = chartTfToMs(timeframe);
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const t of symbolTrades) {
    const entryMs = isoToMs(t.entryBarTs ?? t.entryTs);
    const exitMs = isoToMs(t.exitTs);
    if (entryMs != null) minMs = Math.min(minMs, entryMs);
    if (exitMs != null) maxMs = Math.max(maxMs, exitMs + tfMs);
  }
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) {
    return Object.fromEntries(symbolTrades.map((t) => [t.tradeNumber, emptyFeatures(t)]));
  }

  const fromMs = minMs - WARMUP_BARS * tfMs;
  const toMs = maxMs + tfMs;
  let candles = [];
  try {
    candles = await readCandles(sym, timeframe, fromMs, toMs, { market });
  } catch {
    candles = [];
  }

  if (candles.length < 30) {
    return Object.fromEntries(symbolTrades.map((t) => [t.tradeNumber, emptyFeatures(t)]));
  }

  const series = buildIndicatorSeries(candles);
  const out = {};

  for (const t of symbolTrades) {
    const entryBarMs = isoToMs(t.entryBarTs ?? t.entryTs);
    const exitBarMs = isoToMs(t.exitTs);
    const entryIdx = barIndexContainingMs(candles, entryBarMs ?? 0, tfMs);
    const exitIdx = exitBarMs != null ? barIndexContainingMs(candles, exitBarMs, tfMs) : entryIdx;
    const barFeatures = featuresAtBar(candles, series, entryIdx);
    const range = computeRangeBeforeSl(candles, entryIdx, exitIdx, t);
    const entryMs = entryBarMs ?? isoToMs(t.entryTs);
    const liq = flattenLiqContext(t);

    out[t.tradeNumber] = {
      ...barFeatures,
      ...range,
      entryHourUtc: hourUtc(entryMs),
      entryHourIst: hourIst(entryMs),
      entryWeekday: weekdayLabel(entryMs),
      session: sessionFromUtcHour(hourUtc(entryMs)),
      ...liq,
    };
  }
  return out;
}

function emptyFeatures(trade) {
  return {
    atr14: null,
    atr14Pct: null,
    atrPercentile: null,
    adx14: null,
    rsi14: null,
    ema20: null,
    ema50: null,
    ema200: null,
    distToEma20Pct: null,
    distToEma50Pct: null,
    distToEma200Pct: null,
    emaStack: "",
    volume: null,
    volVsAvg20: null,
    bodyPct: null,
    upperWickPct: null,
    lowerWickPct: null,
    swingHigh: null,
    distToSwingHighPct: null,
    swingLow: null,
    distToSwingLowPct: null,
    entryHourUtc: null,
    entryHourIst: null,
    entryWeekday: "",
    session: "",
    rangeLowestPrice: null,
    rangeHighestPrice: null,
    barsToSlTouch: null,
    ...flattenLiqContext(trade),
  };
}

/**
 * @param {Array<Record<string, unknown>>} trades — mapped API trade rows
 * @param {{ timeframe: string, market?: "futures"|"spot", symbol?: string }} opts
 * @returns {Promise<Record<number, Record<string, unknown>>>} tradeNumber → features
 */
export async function computeFeaturesForTrades(trades, opts = {}) {
  if (!Array.isArray(trades) || trades.length === 0) return {};
  const timeframe = String(opts.timeframe || "1h");
  const market = opts.market === "spot" ? "spot" : "futures";
  const fallbackSymbol = String(opts.symbol || "BTCUSDT").toUpperCase();

  const bySymbol = new Map();
  for (const t of trades) {
    const sym = tradeSymbol(t, fallbackSymbol);
    if (!bySymbol.has(sym)) bySymbol.set(sym, []);
    bySymbol.get(sym).push(t);
  }

  const merged = {};
  for (const [sym, group] of bySymbol) {
    const part = await featuresForSymbolGroup(group, { symbol: sym, timeframe, market, fallbackSymbol });
    Object.assign(merged, part);
  }
  return merged;
}
