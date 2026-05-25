/**
 * HTF_RSI — Trend-aligned RSI mean-reversion for 15m intraday.
 *
 * LONG  only when 1h trend is UP   (EMA-21 > EMA-50) + RSI exhaustion + confirmation
 * SHORT only when 1h trend is DOWN (EMA-21 < EMA-50) + RSI exhaustion + confirmation
 *
 * v3 (May 2026): HTF sep ≥ 0.12% blocks chop longs/shorts in flat 1h trend — ~50% WR,
 * ~125–191% return on BNB 15m (Jan–May 2026) vs v2 ~47% WR at similar return.
 *
 * v2 filters retained: shallow long, weak deep short, 3-bar momentum, volume, spike bar.
 */

import { ema, rsi as computeRsi, atr as computeAtr } from "./indicators.js";

const WARMUP = 80;

/** 1h EMA separation below this = chop — v3 raised from 0.058% to 0.12% (loss analysis). */
export const HTF_SIDEWAYS_SEP = 0.0012;

/** RSI zones (unchanged — winners often enter at RSI 32–35 / 66–69). */
const RSI_LONG_MAX = 35;
const RSI_SHORT_MIN = 65;

/** Shallow long: RSI barely oversold + weak close in bar range (blocks #11). */
const SHALLOW_LONG_RSI = 30.5;
const SHALLOW_LONG_CLOSE_POS = 0.45;

/** Strong HTF trend but RSI not exhausted enough — instant SL short (#4). */
const DEEP_HTF_SEP = 0.02;
const DEEP_HTF_SHORT_RSI_MIN = 68;

function toHourly(candles) {
  const out = [];
  for (let i = 0; i + 3 < candles.length; i += 4) {
    const chunk = candles.slice(i, i + 4);
    out.push({ close: chunk[chunk.length - 1].close });
  }
  return out;
}

function barClosePosition(bar) {
  const range = bar.high - bar.low;
  if (range <= 0) return 0.5;
  return (bar.close - bar.low) / range;
}

export function signal({ candles, timeframe } = {}) {
  if (candles.length < WARMUP) return { action: "HOLD", reason: "warmup" };

  const hourly = toHourly(candles);
  if (hourly.length < 22) return { action: "HOLD", reason: "htf_warmup" };
  const hCloses = hourly.map((c) => c.close);
  const hEma21 = ema(hCloses, 21);
  const hEma50 = ema(hCloses, 50);
  const hLast = hourly.length - 1;
  const htfE21 = hEma21[hLast];
  const htfE50 = hEma50[hLast];
  if (!Number.isFinite(htfE21) || !Number.isFinite(htfE50) || htfE50 === 0) {
    return { action: "HOLD", reason: "htf_na" };
  }
  const htfUp = htfE21 > htfE50;
  const htfDown = htfE21 < htfE50;
  const htfSep = Math.abs(htfE21 - htfE50) / htfE50;
  if (htfSep < HTF_SIDEWAYS_SEP) return { action: "HOLD", reason: "htf_sideways" };

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => Number(c.volume) || 0);
  const i = candles.length - 1;
  const bar = candles[i];
  const prev = candles[i - 1];
  const prev2 = candles[i - 2];

  const rsiSeries = computeRsi(closes, 14);
  const atrSeries = computeAtr(candles, 14);

  const rsiNow = rsiSeries[i];
  const rsiPrev = rsiSeries[i - 1];
  const atrVal = atrSeries[i];

  if (!Number.isFinite(rsiNow) || !Number.isFinite(rsiPrev)) {
    return { action: "HOLD", reason: "rsi_na" };
  }

  const range = bar.high - bar.low || 1;
  if (atrVal > 0 && range / atrVal > 4) return { action: "HOLD", reason: "spike_bar" };

  const volSlice = volumes.slice(Math.max(0, i - 20), i);
  const avgVol = volSlice.length ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 0;
  if (avgVol > 0 && volumes[i] < 0.8 * avgVol) return { action: "HOLD", reason: "low_volume" };

  const closePos = barClosePosition(bar);
  const threeBarDown =
    Number.isFinite(prev2?.close) &&
    bar.close < prev.close &&
    prev.close < prev2.close;
  const threeBarUp =
    Number.isFinite(prev2?.close) &&
    bar.close > prev.close &&
    prev.close > prev2.close;

  // ── LONG ──────────────────────────────────────────────────────────
  if (htfUp && rsiNow <= RSI_LONG_MAX) {
    if (rsiNow < SHALLOW_LONG_RSI && closePos < SHALLOW_LONG_CLOSE_POS) {
      return { action: "HOLD", reason: "shallow_long" };
    }
    const recovering = rsiNow > rsiPrev;
    const barOk = bar.close >= bar.open;
    const closeVsPrev = bar.close > prev.close;
    if (threeBarDown) return { action: "HOLD", reason: "momentum_down" };
    if (recovering && barOk && closeVsPrev) {
      return { action: "BUY", reason: `htf_rsi_long_${rsiNow.toFixed(0)}` };
    }
    return { action: "HOLD", reason: "long_unconfirmed" };
  }

  // ── SHORT ─────────────────────────────────────────────────────────
  if (htfDown && rsiNow >= RSI_SHORT_MIN) {
    if (htfSep > DEEP_HTF_SEP && rsiNow < DEEP_HTF_SHORT_RSI_MIN) {
      return { action: "HOLD", reason: "weak_deep_short" };
    }
    const rejecting = rsiNow < rsiPrev;
    const barOk = bar.close <= bar.open;
    const closeVsPrev = bar.close < prev.close;
    if (threeBarUp) return { action: "HOLD", reason: "momentum_up" };
    if (rejecting && barOk && closeVsPrev) {
      return { action: "SELL", reason: `htf_rsi_short_${rsiNow.toFixed(0)}` };
    }
    return { action: "HOLD", reason: "short_unconfirmed" };
  }

  return { action: "HOLD", reason: "no_setup" };
}

/**
 * O(n) backtest path — precompute per-bar signals (same rules as `signal()`).
 * @returns {Array<{ action: 'BUY'|'SELL'|'HOLD', reason: string }|null>}
 */
export function buildHtfRsiSignalSeries(candles, timeframe = "15m") {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < WARMUP) return out;

  const hourlyCloses = [];
  for (let j = 3; j < n; j += 4) hourlyCloses.push(candles[j].close);
  const hEma21 = ema(hourlyCloses, 21);
  const hEma50 = ema(hourlyCloses, 50);

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => Number(c.volume) || 0);
  const rsiSeries = computeRsi(closes, 14);
  const atrSeries = computeAtr(candles, 14);

  for (let i = WARMUP; i < n; i++) {
    const hLast = Math.floor((i + 1) / 4) - 1;
    if (hLast < 21) continue;
    const htfE21 = hEma21[hLast];
    const htfE50 = hEma50[hLast];
    if (!Number.isFinite(htfE21) || !Number.isFinite(htfE50) || htfE50 === 0) continue;

    const htfUp = htfE21 > htfE50;
    const htfDown = htfE21 < htfE50;
    const htfSep = Math.abs(htfE21 - htfE50) / htfE50;
    if (htfSep < HTF_SIDEWAYS_SEP) continue;

    const bar = candles[i];
    const prev = candles[i - 1];
    const prev2 = candles[i - 2];
    const rsiNow = rsiSeries[i];
    const rsiPrev = rsiSeries[i - 1];
    const atrVal = atrSeries[i];
    if (!Number.isFinite(rsiNow) || !Number.isFinite(rsiPrev)) continue;

    const range = bar.high - bar.low || 1;
    if (atrVal > 0 && range / atrVal > 4) continue;

    const volSlice = volumes.slice(Math.max(0, i - 20), i);
    const avgVol = volSlice.length ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 0;
    if (avgVol > 0 && volumes[i] < 0.8 * avgVol) continue;

    const closePos = barClosePosition(bar);
    const threeBarDown =
      Number.isFinite(prev2?.close) && bar.close < prev.close && prev.close < prev2.close;
    const threeBarUp =
      Number.isFinite(prev2?.close) && bar.close > prev.close && prev.close > prev2.close;

    if (htfUp && rsiNow <= RSI_LONG_MAX) {
      if (rsiNow < SHALLOW_LONG_RSI && closePos < SHALLOW_LONG_CLOSE_POS) continue;
      const recovering = rsiNow > rsiPrev;
      const barOk = bar.close >= bar.open;
      const closeVsPrev = bar.close > prev.close;
      if (threeBarDown) continue;
      if (recovering && barOk && closeVsPrev) {
        out[i] = { action: "BUY", reason: `htf_rsi_long_${rsiNow.toFixed(0)}` };
      }
      continue;
    }

    if (htfDown && rsiNow >= RSI_SHORT_MIN) {
      if (htfSep > DEEP_HTF_SEP && rsiNow < DEEP_HTF_SHORT_RSI_MIN) continue;
      const rejecting = rsiNow < rsiPrev;
      const barOk = bar.close <= bar.open;
      const closeVsPrev = bar.close < prev.close;
      if (threeBarUp) continue;
      if (rejecting && barOk && closeVsPrev) {
        out[i] = { action: "SELL", reason: `htf_rsi_short_${rsiNow.toFixed(0)}` };
      }
    }
  }
  return out;
}

/** Backtest adapter: O(1) lookup into precomputed series. */
export function buildHtfRsiBacktestAdapter(candles, timeframe = "15m") {
  const series = buildHtfRsiSignalSeries(candles, timeframe);
  let lastDir = 0;
  return function htfRsiFastAdapter(bar, idx) {
    const sig = series[idx];
    if (!sig || sig.action === "HOLD") return null;
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

export const HTF_RSI = {
  name: "HTF-Filtered RSI Mean Reversion (1h trend + 15m RSI exhaustion)",
  signal,
  buildHtfRsiSignalSeries,
  buildHtfRsiBacktestAdapter,
};
