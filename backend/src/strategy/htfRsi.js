/**
 * HTF_RSI — Trend-aligned RSI mean-reversion for 15m intraday.
 *
 * Core idea: in a 1h trend, fade 15m RSI exhaustion *only* when price is still
 * on the right side of HTF structure (pullback, not reversal).
 *
 * v4 (Jun 2026): pullback-in-trend entries — price must hold HTF EMA21–50 band,
 * HTF EMA21 slope, RSI recovery (not triple bar confirm). Sweep-tuned BNB 15m.
 */

import { ema, rsi as computeRsi, atr as computeAtr } from "./indicators.js";
import { dirStore } from "./adapterPersisted.js";

const WARMUP = 80;

/** Defaults (v4 — BNB 15m train/OOS sweep Jun 2025–Jun 2026). */
export const HTF_RSI_DEFAULT_OPTS = {
  minHtfSep: 0.0008,
  rsiLongMax: 40,
  rsiShortMin: 60,
  shallowLongRsi: 30.5,
  shallowLongClosePos: 0.45,
  deepHtfSep: 0.02,
  deepHtfShortRsiMin: 68,
  spikeRangeAtrMult: 4,
  minVolRatio: 0.8,
  /** recovery_only: RSI turning; strict: + bar color + close vs prev */
  confirmMode: "recovery_only",
  /** ema21_zone: fade RSI only while price holds HTF EMA21–50 band */
  pullbackMode: "ema21_zone",
  sideMode: "both",
  requireHtfSlope: true,
  blockThreeBarMomentum: true,
};

/** @deprecated use minHtfSep in opts */
export const HTF_SIDEWAYS_SEP = HTF_RSI_DEFAULT_OPTS.minHtfSep;

function normalizeHtfRsiOpts(cfgOrOpts = {}) {
  const src = cfgOrOpts?.htfRsiOpts && typeof cfgOrOpts.htfRsiOpts === "object" ? cfgOrOpts.htfRsiOpts : cfgOrOpts;
  const out = { ...HTF_RSI_DEFAULT_OPTS };
  for (const k of Object.keys(HTF_RSI_DEFAULT_OPTS)) {
    if (src[k] !== undefined && src[k] !== null) out[k] = src[k];
  }
  if (src.minHtfSep == null && src.htfRsiMinSep != null) out.minHtfSep = Number(src.htfRsiMinSep);
  if (src.rsiLongMax == null && src.htfRsiLongMax != null) out.rsiLongMax = Number(src.htfRsiLongMax);
  if (src.rsiShortMin == null && src.htfRsiShortMin != null) out.rsiShortMin = Number(src.htfRsiShortMin);
  if (src.confirmMode == null && src.htfRsiConfirmMode != null) out.confirmMode = String(src.htfRsiConfirmMode);
  if (src.pullbackMode == null && src.htfRsiPullbackMode != null) out.pullbackMode = String(src.htfRsiPullbackMode);
  if (src.sideMode == null && src.htfRsiSideMode != null) out.sideMode = String(src.htfRsiSideMode);
  if (src.requireHtfSlope == null && src.htfRsiRequireHtfSlope != null) {
    out.requireHtfSlope = src.htfRsiRequireHtfSlope === true;
  }
  return out;
}

function aggregateToHourly(candles) {
  if (!candles.length) return [];
  const hourly = [];
  let cur = null;
  for (const c of candles) {
    const hourTs = Math.floor(c.ts / 3600000) * 3600000;
    if (!cur || cur.ts !== hourTs) {
      if (cur) hourly.push(cur);
      cur = {
        ts: hourTs,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: Number(c.volume) || 0,
      };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += Number(c.volume) || 0;
    }
  }
  if (cur) hourly.push(cur);
  return hourly;
}

function hourIndexForBar(barTs, hourly) {
  const hourTs = Math.floor(barTs / 3600000) * 3600000;
  let lo = 0;
  let hi = hourly.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (hourly[mid].ts <= hourTs) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function readHtfTrend(hEma21, hEma50, hIdx) {
  if (hIdx < 21) return null;
  const htfE21 = hEma21[hIdx];
  const htfE50 = hEma50[hIdx];
  const htfE21Prev = hIdx > 0 ? hEma21[hIdx - 1] : null;
  if (!Number.isFinite(htfE21) || !Number.isFinite(htfE50) || htfE50 === 0) return null;
  const htfSep = Math.abs(htfE21 - htfE50) / htfE50;
  return {
    htfE21,
    htfE50,
    htfUp: htfE21 > htfE50,
    htfDown: htfE21 < htfE50,
    htfSep,
    htfE21Rising: Number.isFinite(htfE21Prev) && htfE21 > htfE21Prev,
    htfE21Falling: Number.isFinite(htfE21Prev) && htfE21 < htfE21Prev,
  };
}

function barClosePosition(bar) {
  const range = bar.high - bar.low;
  if (range <= 0) return 0.5;
  return (bar.close - bar.low) / range;
}

function passesPullbackLong(bar, htf, opts) {
  if (opts.pullbackMode === "off") return true;
  if (opts.pullbackMode === "above_ema50") return bar.close >= htf.htfE50;
  if (opts.pullbackMode === "ema21_zone") {
    const lo = Math.min(htf.htfE21, htf.htfE50);
    const hi = Math.max(htf.htfE21, htf.htfE50);
    return bar.close >= lo * 0.998 && bar.close <= hi * 1.002;
  }
  return true;
}

function passesPullbackShort(bar, htf, opts) {
  if (opts.pullbackMode === "off") return true;
  if (opts.pullbackMode === "above_ema50") return bar.close <= htf.htfE50;
  if (opts.pullbackMode === "ema21_zone") {
    const lo = Math.min(htf.htfE21, htf.htfE50);
    const hi = Math.max(htf.htfE21, htf.htfE50);
    return bar.close <= hi * 1.002 && bar.close >= lo * 0.998;
  }
  return true;
}

function longConfirmed(rsiNow, rsiPrev, bar, prev, opts) {
  const recovering = rsiNow > rsiPrev;
  const barOk = bar.close >= bar.open;
  const closeVsPrev = bar.close > prev.close;
  const mode = String(opts.confirmMode ?? "strict");
  if (mode === "recovery_only") return recovering;
  if (mode === "rsi_turn") return recovering || (rsiPrev <= 32 && rsiNow > 32);
  return recovering && barOk && closeVsPrev;
}

function shortConfirmed(rsiNow, rsiPrev, bar, prev, opts) {
  const rejecting = rsiNow < rsiPrev;
  const barOk = bar.close <= bar.open;
  const closeVsPrev = bar.close < prev.close;
  const mode = String(opts.confirmMode ?? "strict");
  if (mode === "recovery_only") return rejecting;
  if (mode === "rsi_turn") return rejecting || (rsiPrev >= 68 && rsiNow < 68);
  return rejecting && barOk && closeVsPrev;
}

function evaluateBar(i, candles, hourly, hEma21, hEma50, rsiSeries, atrSeries, volumes, opts) {
  const hIdx = hourIndexForBar(candles[i].ts, hourly);
  const htf = readHtfTrend(hEma21, hEma50, hIdx);
  if (!htf || htf.htfSep < opts.minHtfSep) return null;

  const bar = candles[i];
  const prev = candles[i - 1];
  const prev2 = candles[i - 2];
  const rsiNow = rsiSeries[i];
  const rsiPrev = rsiSeries[i - 1];
  const atrVal = atrSeries[i];
  if (!Number.isFinite(rsiNow) || !Number.isFinite(rsiPrev)) return null;

  const range = bar.high - bar.low || 1;
  if (atrVal > 0 && range / atrVal > opts.spikeRangeAtrMult) return null;

  const volSlice = volumes.slice(Math.max(0, i - 20), i);
  const avgVol = volSlice.length ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 0;
  if (avgVol > 0 && volumes[i] < opts.minVolRatio * avgVol) return null;

  const sideMode = String(opts.sideMode ?? "both");
  const closePos = barClosePosition(bar);
  const threeBarDown =
    opts.blockThreeBarMomentum &&
    Number.isFinite(prev2?.close) &&
    bar.close < prev.close &&
    prev.close < prev2.close;
  const threeBarUp =
    opts.blockThreeBarMomentum &&
    Number.isFinite(prev2?.close) &&
    bar.close > prev.close &&
    prev.close > prev2.close;

  if (sideMode !== "short_only" && htf.htfUp && rsiNow <= opts.rsiLongMax) {
    if (opts.requireHtfSlope && !htf.htfE21Rising) return null;
    if (!passesPullbackLong(bar, htf, opts)) return null;
    if (rsiNow < opts.shallowLongRsi && closePos < opts.shallowLongClosePos) return null;
    if (threeBarDown) return null;
    if (longConfirmed(rsiNow, rsiPrev, bar, prev, opts)) {
      return { action: "BUY", reason: `htf_rsi_long_${rsiNow.toFixed(0)}` };
    }
  }

  if (sideMode !== "long_only" && htf.htfDown && rsiNow >= opts.rsiShortMin) {
    if (opts.requireHtfSlope && !htf.htfE21Falling) return null;
    if (!passesPullbackShort(bar, htf, opts)) return null;
    if (htf.htfSep > opts.deepHtfSep && rsiNow < opts.deepHtfShortRsiMin) return null;
    if (threeBarUp) return null;
    if (shortConfirmed(rsiNow, rsiPrev, bar, prev, opts)) {
      return { action: "SELL", reason: `htf_rsi_short_${rsiNow.toFixed(0)}` };
    }
  }

  return null;
}

export function buildHtfRsiSignalSeriesWithOpts(candles, timeframe = "15m", cfgOrOpts = {}) {
  const opts = normalizeHtfRsiOpts(cfgOrOpts);
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (String(timeframe ?? "15m").toLowerCase() !== "15m" || n < WARMUP) return out;

  const hourly = aggregateToHourly(candles);
  if (hourly.length < 22) return out;
  const hCloses = hourly.map((c) => c.close);
  const hEma21 = ema(hCloses, 21);
  const hEma50 = ema(hCloses, 50);

  const volumes = candles.map((c) => Number(c.volume) || 0);
  const rsiSeries = computeRsi(
    candles.map((c) => c.close),
    14,
  );
  const atrSeries = computeAtr(candles, 14);

  for (let i = WARMUP; i < n; i++) {
    out[i] = evaluateBar(i, candles, hourly, hEma21, hEma50, rsiSeries, atrSeries, volumes, opts);
  }
  return out;
}

export function buildHtfRsiSignalSeries(candles, timeframe = "15m", cfgOrOpts = {}) {
  return buildHtfRsiSignalSeriesWithOpts(candles, timeframe, cfgOrOpts);
}

export function signal({ candles, timeframe, cfg, ...rest } = {}) {
  if (String(timeframe ?? "15m").toLowerCase() !== "15m") {
    return { action: "HOLD", reason: "requires_15m" };
  }
  if (candles.length < WARMUP) return { action: "HOLD", reason: "warmup" };

  const opts = normalizeHtfRsiOpts(cfg ?? rest);
  const hourly = aggregateToHourly(candles);
  if (hourly.length < 22) return { action: "HOLD", reason: "htf_warmup" };
  const hCloses = hourly.map((c) => c.close);
  const hEma21 = ema(hCloses, 21);
  const hEma50 = ema(hCloses, 50);
  const volumes = candles.map((c) => Number(c.volume) || 0);
  const rsiSeries = computeRsi(
    candles.map((c) => c.close),
    14,
  );
  const atrSeries = computeAtr(candles, 14);
  const i = candles.length - 1;
  const sig = evaluateBar(i, candles, hourly, hEma21, hEma50, rsiSeries, atrSeries, volumes, opts);
  if (sig) return sig;
  return { action: "HOLD", reason: "no_setup" };
}

export function buildHtfRsiOptsFromCfg(cfg = {}) {
  return normalizeHtfRsiOpts(cfg);
}

/** Backtest adapter: O(1) lookup into precomputed series. */
export function buildHtfRsiBacktestAdapter(candles, timeframe = "15m", cfg = {}) {
  const series = buildHtfRsiSignalSeriesWithOpts(candles, timeframe, cfg);
  const local = { lastDir: 0 };
  return function htfRsiFastAdapter(bar, idx, ctx) {
    const sig = series[idx];
    if (!sig || sig.action === "HOLD") return null;
    const d = dirStore(ctx, local);
    if (sig.action === "BUY" && d.lastDir !== 1) {
      d.lastDir = 1;
      return { action: "BUY", reason: sig.reason };
    }
    if (sig.action === "SELL" && d.lastDir !== -1) {
      d.lastDir = -1;
      return { action: "SELL", reason: sig.reason };
    }
    return null;
  };
}

export const HTF_RSI = {
  name: "HTF-Filtered RSI Mean Reversion (1h trend + 15m RSI exhaustion)",
  signal,
  buildHtfRsiSignalSeries,
  buildHtfRsiSignalSeriesWithOpts,
  buildHtfRsiBacktestAdapter,
  buildHtfRsiOptsFromCfg,
  HTF_RSI_DEFAULT_OPTS,
};
