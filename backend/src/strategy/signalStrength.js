/**
 * Decision-engine style signal strength (ported from signal_strength.py).
 * Produces a 0–100 composite score + TRADE/WAIT/SKIP; does not place orders by itself.
 */

import { clamp } from "../lib/math.js";

/** @param {number} value @param {number} lo @param {number} hi */
function clampF(value, lo, hi) {
  return clamp(value, lo, hi);
}

/**
 * @typedef {Object} SignalStrengthInput
 * @property {number} price
 * @property {number} upperBand
 * @property {number} lowerBand
 * @property {number} atr
 * @property {number} atrMultiplier
 * @property {number} rsi
 * @property {number} volumeRatio
 * @property {number} candlesSinceFlip
 * @property {number} ema50
 * @property {number} [minScore]
 */

/**
 * @param {SignalStrengthInput} data
 * @param {number} [minScore]
 */
export function evaluateSignalStrength(data, minScore = 40) {
  const price = Number(data.price);
  const upperBand = Number(data.upperBand);
  const lowerBand = Number(data.lowerBand);
  const atr = Number(data.atr);
  const atrMultiplier = Math.max(0.01, Number(data.atrMultiplier) || 3);
  const rsi = Number(data.rsi);
  const volumeRatio = Number(data.volumeRatio);
  const candlesSinceFlip = Math.max(0, Math.floor(Number(data.candlesSinceFlip) || 0));
  const ema50 = Number(data.ema50);

  if (
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(upperBand) ||
    !Number.isFinite(lowerBand) ||
    !Number.isFinite(atr) ||
    atr <= 0 ||
    !Number.isFinite(rsi) ||
    !Number.isFinite(volumeRatio) ||
    volumeRatio < 0 ||
    !Number.isFinite(ema50) ||
    ema50 <= 0
  ) {
    return null;
  }

  const isBuy = price > lowerBand;
  const signal = isBuy ? "BUY" : "SELL";
  const activeBand = isBuy ? lowerBand : upperBand;

  const bandDist = Math.abs(price - activeBand);
  const bandScore = clampF((bandDist / atr) * (100 / (atrMultiplier * 2)), 0, 100);

  const volumeScore = clampF((volumeRatio / 2) * 100, 0, 100);

  let rsiScore;
  if (isBuy) {
    rsiScore = clampF(((rsi - 50) / 30) * 100, 0, 100);
  } else {
    rsiScore = clampF(((50 - rsi) / 30) * 100, 0, 100);
  }

  const recencyScore = Math.max(0, (10 - candlesSinceFlip) / 10) * 100;

  const emaPct = ((price - ema50) / ema50) * 100;
  let trendScore;
  if (isBuy) {
    trendScore = clampF((emaPct / 5) * 100, 0, 100);
  } else {
    trendScore = clampF((-emaPct / 5) * 100, 0, 100);
  }

  const strength =
    0.3 * bandScore +
    0.2 * volumeScore +
    0.2 * rsiScore +
    0.15 * recencyScore +
    0.15 * trendScore;

  const moveEstimatePct = ((atr * atrMultiplier) / price) * (strength / 100) * 0.5 * 100;

  const slDistance = atr * 1.5;
  let stopLoss;
  let tp1;
  let tp2;
  if (isBuy) {
    stopLoss = price - slDistance;
    tp1 = price + slDistance * 1.5;
    tp2 = price + slDistance * 2.5;
  } else {
    stopLoss = price + slDistance;
    tp1 = price - slDistance * 1.5;
    tp2 = price - slDistance * 2.5;
  }

  let action;
  let reason;
  if (strength >= 65) {
    action = "TRADE";
    reason = `Score ${strength.toFixed(1)} ≥ 65 — all key factors aligned`;
  } else if (strength >= minScore) {
    action = "WAIT";
    reason = `Score ${strength.toFixed(1)} in ${minScore}–65 zone — monitor next candle`;
  } else {
    action = "SKIP";
    reason = `Score ${strength.toFixed(1)} < ${minScore} — signal too weak`;
  }

  return {
    action,
    signal,
    strength: Math.round(strength * 100) / 100,
    moveEstimatePct: Math.round(moveEstimatePct * 100) / 100,
    stopLoss: Math.round(stopLoss * 1e4) / 1e4,
    takeProfit1: Math.round(tp1 * 1e4) / 1e4,
    takeProfit2: Math.round(tp2 * 1e4) / 1e4,
    componentScores: {
      band_distance: Math.round(bandScore * 10) / 10,
      volume: Math.round(volumeScore * 10) / 10,
      rsi: Math.round(rsiScore * 10) / 10,
      recency: Math.round(recencyScore * 10) / 10,
      trend: Math.round(trendScore * 10) / 10,
    },
    reason,
  };
}

/** Last bar index in series where a Supertrend flip occurred (buy or sell signal). */
export function lastSupertrendFlipIndex(series) {
  if (!Array.isArray(series) || !series.length) return -1;
  for (let i = series.length - 1; i >= 0; i--) {
    const r = series[i];
    if (!r?.ready) continue;
    if (r.buySignal || r.sellSignal) return i;
  }
  return -1;
}

function emaLast(values, period) {
  const p = Math.max(1, Math.floor(period));
  const k = 2 / (p + 1);
  let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    prev = i === 0 ? v : v * k + prev * (1 - k);
  }
  return prev;
}

/**
 * Build input from candles + indicators + supertrend series (last row must be ready).
 * @param {object} p
 * @param {Array<{ close: number, volume?: number }>} p.candles oldest-first (raw ok; use same as indicator pass)
 * @param {Record<string, number>} p.indicatorsLatest
 * @param {Array<object>} p.supertrendSeries from computeSupertrendSeries
 * @param {number} [p.atrMultiplier] Supertrend multiplier (e.g. state.supertrendMultiplier)
 */
export function buildSignalStrengthInput({ candles, indicatorsLatest, supertrendSeries, atrMultiplier = 3 }) {
  const series = supertrendSeries || [];
  const last = series[series.length - 1];
  if (!last?.ready || last.up == null || last.dn == null || last.atr == null) return null;

  const closes = candles.map((c) => Number(c.close));
  const price = closes.at(-1);
  if (!Number.isFinite(price) || price <= 0) return null;

  const flipIdx = lastSupertrendFlipIndex(series);
  const candlesSinceFlip =
    flipIdx < 0 ? 999 : Math.max(0, series.length - 1 - flipIdx);

  const ema50 =
    closes.length >= 50 ? emaLast(closes, 50) : emaLast(closes, Math.min(50, Math.max(2, closes.length)));

  const rsi = Number(indicatorsLatest?.rsi_14 ?? 50);
  const atr = Number(last.atr);
  const mult = Math.max(0.01, Number(atrMultiplier) || 3);

  const volSpike = Number(indicatorsLatest?.volume_spike ?? 1);
  const volumeRatio = Number.isFinite(volSpike) && volSpike >= 0 ? volSpike : 1;

  return {
    price,
    upperBand: Number(last.dn),
    lowerBand: Number(last.up),
    atr,
    atrMultiplier: mult,
    rsi,
    volumeRatio,
    candlesSinceFlip,
    ema50,
  };
}
