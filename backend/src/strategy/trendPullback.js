/**
 * Trend-Pullback Scalper — high win-rate intraday strategy for 1m/5m.
 *
 * Entry logic:
 *   - HTF trend confirmed (1h EMA-21 > EMA-50 for longs)
 *   - RSI dips below 25 (genuine oversold, not just 30)
 *   - RSI recovers to 35+ on the signal bar (confirmed recovery, not just noise)
 *   - Bullish bar closing in upper portion of range (strong bounce bar)
 *   - Bar close > EMA-9 (momentum returned)
 *
 * Exit via stateful adapter (RSI mean-reversion to ~45 or bounce-failed exit).
 *
 * Signal contract: { action: 'BUY'|'SELL'|'HOLD', reason: string }
 */

import { ema, rsi as computeRsi, atr as computeAtr } from "./indicators.js";

const WARMUP = 80;

function aggregateToHourly(candles) {
  if (!candles.length) return [];
  const hourly = [];
  let cur = null;
  for (const c of candles) {
    const hourTs = Math.floor(c.ts / 3600000) * 3600000;
    if (!cur || cur.ts !== hourTs) {
      if (cur) hourly.push(cur);
      cur = { ts: hourTs, open: c.open, high: c.high, low: c.low, close: c.close, volume: Number(c.volume) || 0 };
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

/** @param {{ candles: unknown[], timeframe?: string, cfg?: Record<string, unknown> }} ctx */
export function signal({ candles, timeframe, cfg } = {}) {
  if (candles.length < WARMUP) return { action: "HOLD", reason: "warmup" };

  const tf = String(timeframe || cfg?.timeframe || "5m").toLowerCase();
  const is1m = tf === "1m";
  const longOnly = cfg?.trendPullbackLongOnly === true;

  // ── HTF (1h) trend ──────────────────────────────────────────────────
  const hourly = aggregateToHourly(candles);
  if (hourly.length < 30) return { action: "HOLD", reason: "htf_warmup" };

  const htfCloses = hourly.map((c) => c.close);
  const htfEma21 = ema(htfCloses, 21);
  const htfEma50 = ema(htfCloses, 50);
  const hi = hourly.length - 1;
  const htfE21 = htfEma21[hi];
  const htfE50 = htfEma50[hi];

  if (!Number.isFinite(htfE21) || !Number.isFinite(htfE50)) {
    return { action: "HOLD", reason: "htf_ema_na" };
  }

  const htfTrendUp = htfE21 > htfE50;
  const htfTrendDown = htfE21 < htfE50;
  if (!htfTrendUp && !htfTrendDown) return { action: "HOLD", reason: "htf_flat" };

  // ── LTF analysis ────────────────────────────────────────────────────
  const closes = candles.map((c) => c.close);
  const ema9 = ema(closes, 9);
  const rsiSeries = computeRsi(closes, 14);
  const atrSeries = computeAtr(candles, 14);

  const i = candles.length - 1;
  const bar = candles[i];
  const rsiNow = rsiSeries[i];
  const e9 = ema9[i];
  const atrVal = atrSeries[i];

  if (!Number.isFinite(rsiNow)) {
    return { action: "HOLD", reason: "rsi_na" };
  }

  // Bar quality
  const body = Math.abs(bar.close - bar.open);
  const range = bar.high - bar.low;
  if (range > 0 && body / range < 0.25) return { action: "HOLD", reason: "doji" };
  if (atrVal > 0 && range / atrVal > 3) return { action: "HOLD", reason: "extreme_bar" };

  // Volume check
  const volumes = candles.map((c) => Number(c.volume) || 0);
  const volSlice = volumes.slice(Math.max(0, i - 20), i);
  const avgVol = volSlice.length ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 1;
  const volOk = avgVol <= 0 || volumes[i] >= 0.5 * avgVol;

  // Check if RSI was deeply oversold/overbought recently (within last 5 bars).
  // 1m: stricter thresholds — shorts were firing on noise (WR ~24% on SELL in live runs).
  const oversoldExtreme = Number(cfg?.trendPullbackRsiOversold) || (is1m ? 22 : 25);
  const overboughtExtreme = Number(cfg?.trendPullbackRsiOverbought) || (is1m ? 80 : 75);
  const recentRsi = rsiSeries.slice(Math.max(0, i - 5), i);
  const wasDeepOversold = recentRsi.some((r) => r <= oversoldExtreme);
  const wasDeepOverbought = recentRsi.some((r) => r >= overboughtExtreme);

  // ── LONG ──────────────────────────────────────────────────────────────
  if (htfTrendUp) {
    const recoverMin = Number(cfg?.trendPullbackRsiRecoverMin) || (is1m ? 38 : 35);
    const rsiRecovered = wasDeepOversold && rsiNow >= recoverMin;
    const bullishBar = bar.close > bar.open;
    const strongClose = range > 0 && (bar.close - bar.low) / range >= 0.6;
    const aboveEma9 = bar.close > e9;

    if (rsiRecovered && bullishBar && strongClose && aboveEma9 && volOk) {
      return { action: "BUY", reason: "rsi_oversold_bounce" };
    }
  }

  // ── SHORT ─────────────────────────────────────────────────────────────
  if (htfTrendDown && !longOnly) {
    const rejectMax = Number(cfg?.trendPullbackRsiRejectMax) || (is1m ? 55 : 65);
    const rsiRejected = wasDeepOverbought && rsiNow <= rejectMax;
    const bearishBar = bar.close < bar.open;
    const strongClose = range > 0 && (bar.high - bar.close) / range >= 0.6;
    const belowEma9 = bar.close < e9;

    if (rsiRejected && bearishBar && strongClose && belowEma9 && volOk) {
      return { action: "SELL", reason: "rsi_overbought_reject" };
    }
  }

  return { action: "HOLD", reason: "no_setup" };
}

export const TREND_PULLBACK = {
  name: "Trend-Pullback Scalper (HTF trend + RSI oversold bounce)",
  signal,
};
