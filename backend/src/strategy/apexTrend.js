/**
 * APEX_TREND v2 — Triple-TF trend + Supertrend flip + **strict** RSI pullback zone.
 *
 * v1 bug (fixed): "pullback" fired at RSI 67–73 (chasing). Cause: `rsiNow >= 48` with any
 * bar ≤45 in the prior 5 bars — not a true pullback entry.
 *
 * v2 entry RSI (LONG): min RSI in last 8 bars ≤ 38, current RSI 40–52, rising vs prior bar.
 * v2 entry RSI (SHORT): max RSI in last 8 bars ≥ 62, current RSI 48–60, falling vs prior bar.
 *
 * ST signal uses fixed period 7 / mult 2.5 (ignores bot supertrendPeriod/Multiplier).
 *
 * BNB 15m validated path: pair with SL 0.6% / TP 1.8% / RISK_AT_SL 5–7%.
 * BTC: trend-following underperforms vs BNB — prefer HTF_LEG_RIDER or HTF_RSI filters.
 */

import { ema, rsi as computeRsi, atr as computeAtr, adx as computeAdx } from "./indicators.js";
import { computeSupertrendSeries } from "./supertrend.js";

export const WARMUP = 120;

/** Fixed Supertrend for APEX entries (do not inherit bot ST 10/6). */
export const APEX_ST_PERIOD = 7;
export const APEX_ST_MULT = 2.5;

const HTF4H_SEP_MIN = 0.0008;
const HTF1H_SEP_MIN = 0.0012;
const ADX_MIN = 22;
const ATR_PCT_MIN = 0.002;
const VOL_MULT = 1.25;
const RSI_LOOKBACK = 8;

/** Long: dipped then recovering in zone — NOT extended. */
const RSI_LONG_DIP_MAX = 38;
const RSI_LONG_ENTRY_MIN = 40;
const RSI_LONG_ENTRY_MAX = 52;

/** Short: rallied then rejecting in zone. */
const RSI_SHORT_SPIKE_MIN = 62;
const RSI_SHORT_ENTRY_MIN = 48;
const RSI_SHORT_ENTRY_MAX = 60;

function aggregate(candles, factor) {
  const out = [];
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const chunk = candles.slice(i, i + factor);
    out.push({
      ts: chunk[0].ts,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + (Number(c.volume) || 0), 0),
    });
  }
  return out;
}

function detectBarsPerHour(candles) {
  if (candles.length < 3) return 4;
  const diffs = [];
  for (let i = 1; i < Math.min(10, candles.length); i++) {
    const d = candles[i].ts - candles[i - 1].ts;
    if (d > 0) diffs.push(d);
  }
  if (!diffs.length) return 4;
  const medMs = diffs.sort((a, b) => a - b)[Math.floor(diffs.length / 2)];
  const medMin = medMs / 60000;
  if (medMin <= 1.5) return 60;
  if (medMin <= 3.5) return 20;
  if (medMin <= 6) return 12;
  if (medMin <= 16) return 4;
  if (medMin <= 35) return 2;
  return 1;
}

/**
 * @param {Array} candles
 * @param {object} [opts]
 * @param {number} [opts.adxMin]
 * @param {number} [opts.htf1hSep]
 * @param {number} [opts.htf4hSep]
 * @param {boolean} [opts.flipOnly] — if true, only ST flip entries (no continuation)
 */
export function buildApexTrendSignalSeries(candles, opts = {}) {
  const adxMin = Number(opts.adxMin ?? ADX_MIN);
  const htf1hSep = Number(opts.htf1hSep ?? HTF1H_SEP_MIN);
  const htf4hSep = Number(opts.htf4hSep ?? HTF4H_SEP_MIN);
  const flipOnly = opts.flipOnly !== false;

  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < WARMUP) return out;

  const bph = detectBarsPerHour(candles);
  const factor1h = bph;
  const factor4h = bph * 4;

  const h1Candles = factor1h > 1 ? aggregate(candles, factor1h) : candles;
  const h4Candles = aggregate(candles, factor4h);

  const h1E21 = ema(h1Candles.map((c) => c.close), 21);
  const h1E50 = ema(h1Candles.map((c) => c.close), 50);
  const h4E21 = ema(h4Candles.map((c) => c.close), 21);
  const h4E50 = ema(h4Candles.map((c) => c.close), 50);

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => Number(c.volume) || 0);
  const rsiSeries = computeRsi(closes, 14);
  const atrSeries = computeAtr(candles, 14);
  const adxSeries = computeAdx(candles, 14);
  const ema9Series = ema(closes, 9);
  const stSeries = computeSupertrendSeries(candles, {
    period: APEX_ST_PERIOD,
    multiplier: APEX_ST_MULT,
    wilderAtr: true,
  });
  const volEma = ema(volumes, 20);

  for (let i = WARMUP; i < n; i++) {
    const bar = candles[i];
    const stBar = stSeries[i];
    if (!stBar?.ready) continue;

    const atrVal = atrSeries[i];
    const range = (bar.high - bar.low) || 0.0001;
    if (atrVal > 0 && range / atrVal > 4) continue;
    if (atrVal / bar.close < ATR_PCT_MIN) continue;

    const adxVal = adxSeries[i];
    if (Number.isFinite(adxVal) && adxVal < adxMin) continue;

    const h4idx = Math.floor(i / factor4h);
    if (h4idx < 21) continue;
    const h4e21 = h4E21[h4idx];
    const h4e50 = h4E50[h4idx];
    if (!Number.isFinite(h4e21) || !Number.isFinite(h4e50) || h4e50 === 0) continue;
    const h4sep = Math.abs(h4e21 - h4e50) / h4e50;
    if (h4sep < htf4hSep) continue;
    const h4up = h4e21 > h4e50;
    const h4down = h4e21 < h4e50;

    const h1idx = factor1h > 1 ? Math.floor(i / factor1h) : i;
    if (h1idx < 50) continue;
    const h1e21 = h1E21[h1idx];
    const h1e50 = h1E50[h1idx];
    if (!Number.isFinite(h1e21) || !Number.isFinite(h1e50) || h1e50 === 0) continue;
    const h1sep = Math.abs(h1e21 - h1e50) / h1e50;
    if (h1sep < htf1hSep) continue;
    const h1up = h1e21 > h1e50;
    const h1down = h1e21 < h1e50;

    if (!((h4up && h1up) || (h4down && h1down))) continue;

    const volAvg = volEma[i];
    if (volAvg > 0 && volumes[i] < VOL_MULT * volAvg) continue;

    const rsiNow = rsiSeries[i];
    const rsiPrev = rsiSeries[i - 1];
    if (!Number.isFinite(rsiNow) || !Number.isFinite(rsiPrev)) continue;

    const rsiWindow = rsiSeries.slice(Math.max(0, i - RSI_LOOKBACK), i);
    const rsiMin = rsiWindow.length ? Math.min(...rsiWindow) : rsiNow;
    const rsiMax = rsiWindow.length ? Math.max(...rsiWindow) : rsiNow;

    const barPos = (bar.close - bar.low) / range;
    const e9 = ema9Series[i];

    const stFlipBuy = stBar.buySignal;
    const stFlipSell = stBar.sellSignal;
    const stBullish = stBar.trend === 1;
    const stBearish = stBar.trend === -1;

    if (h4up && h1up) {
      const inZone =
        rsiNow >= RSI_LONG_ENTRY_MIN &&
        rsiNow <= RSI_LONG_ENTRY_MAX &&
        rsiMin <= RSI_LONG_DIP_MAX &&
        rsiNow > rsiMin + 4 &&
        rsiNow > rsiPrev;
      const strongBar = bar.close >= bar.open && barPos >= 0.55 && bar.close > e9;

      if (!inZone || !strongBar) continue;

      if (stFlipBuy) {
        out[i] = { action: "BUY", reason: `apex_v2_flip_long_rsi${rsiNow.toFixed(0)}` };
        continue;
      }
      if (!flipOnly && !stFlipSell && stBullish) {
        out[i] = { action: "BUY", reason: `apex_v2_pull_long_rsi${rsiNow.toFixed(0)}` };
      }
    }

    if (h4down && h1down) {
      const inZone =
        rsiNow >= RSI_SHORT_ENTRY_MIN &&
        rsiNow <= RSI_SHORT_ENTRY_MAX &&
        rsiMax >= RSI_SHORT_SPIKE_MIN &&
        rsiMax - rsiNow >= 4 &&
        rsiNow < rsiPrev;
      const strongBar = bar.close <= bar.open && barPos <= 0.45 && bar.close < e9;

      if (!inZone || !strongBar) continue;

      if (stFlipSell) {
        out[i] = { action: "SELL", reason: `apex_v2_flip_short_rsi${rsiNow.toFixed(0)}` };
        continue;
      }
      if (!flipOnly && !stFlipBuy && stBearish) {
        out[i] = { action: "SELL", reason: `apex_v2_pull_short_rsi${rsiNow.toFixed(0)}` };
      }
    }
  }

  return out;
}

export function buildApexTrendBacktestAdapter(candles, opts = {}) {
  const series = buildApexTrendSignalSeries(candles, opts);
  let lastDir = 0;
  return function apexTrendAdapter(bar, idx) {
    const sig = series[idx];
    if (!sig) return null;
    if (sig.action === "BUY" && lastDir !== 1) {
      lastDir = 1;
      return { action: "BUY", reason: sig.reason };
    }
    if (sig.action === "SELL" && lastDir !== -1) {
      lastDir = -1;
      return { action: "SELL", reason: sig.reason };
    }
    return null;
  };
}

export function signal({ candles } = {}) {
  if (!candles || candles.length < WARMUP) return { action: "HOLD", reason: "warmup" };
  const series = buildApexTrendSignalSeries(candles);
  return series[series.length - 1] ?? { action: "HOLD", reason: "no_setup" };
}

export const APEX_TREND = {
  name: "Apex Trend v2 (3-TF + ST flip + strict RSI pullback zone)",
  signal,
  buildApexTrendSignalSeries,
  buildApexTrendBacktestAdapter,
};
