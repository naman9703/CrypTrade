/**
 * Decision snapshot for UI + Supertrend context: composite signal strength (signal_strength-style engine)
 * plus legacy market features / expected-move helpers.
 */

import { clamp } from "../lib/math.js";
import { sanitizeCandlesForSt } from "../lib/supertrendChartAlign.js";
import { computeSupertrendSeries } from "./supertrend.js";
import { buildSignalStrengthInput, evaluateSignalStrength } from "./signalStrength.js";

const VOL_AVG_PERIOD = 20;
const SR_LOOKBACK = 20;
const SWING_LOOKBACK = 10;

function ema(values, period) {
  const k = 2 / (period + 1);
  let prev = values[0] ?? 0;
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    prev = i === 0 ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/**
 * @param {Array<{ high: number, low: number, close: number, volume?: number }>} candles oldest-first
 * @param {Record<string, number>} latest from computeIndicators().latest
 */
export function extractDecisionFeatures(candles, latest) {
  const n = candles?.length ?? 0;
  if (n < 2) return null;

  const closes = candles.map((c) => Number(c.close));
  const highs = candles.map((c) => Number(c.high ?? c.close));
  const lows = candles.map((c) => Number(c.low ?? c.close));
  const volumes = candles.map((c) => Number(c.volume ?? 0));

  const price = closes.at(-1);
  const startSr = Math.max(0, n - SR_LOOKBACK);
  let resistance = highs[startSr];
  let support = lows[startSr];
  for (let i = startSr; i < n; i++) {
    resistance = Math.max(resistance, highs[i]);
    support = Math.min(support, lows[i]);
  }

  const trendEmaPeriod = Math.min(200, Math.max(10, n));
  const emaTrendLast = ema(closes, trendEmaPeriod).at(-1);
  const ema200 = Number.isFinite(emaTrendLast) ? emaTrendLast : null;

  let avgVol = null;
  let sumV = 0;
  const vStart = Math.max(0, n - VOL_AVG_PERIOD);
  for (let i = vStart; i < n; i++) sumV += volumes[i] || 0;
  avgVol = n >= VOL_AVG_PERIOD ? sumV / Math.min(VOL_AVG_PERIOD, n - vStart) : null;
  const volume = volumes.at(-1) ?? 0;

  const atr = Number(latest?.atr_14 ?? 0);
  const rsi = Number(latest?.rsi_14 ?? 50);

  let avgBarRange = 0;
  let rc = 0;
  const rStart = Math.max(0, n - SWING_LOOKBACK);
  for (let i = rStart; i < n; i++) {
    avgBarRange += highs[i] - lows[i];
    rc++;
  }
  avgBarRange = rc > 0 ? avgBarRange / rc : 0;

  return {
    price: Number.isFinite(price) ? price : null,
    ema200: Number.isFinite(ema200) ? ema200 : null,
    rsi: Number.isFinite(rsi) ? rsi : 50,
    atr: Number.isFinite(atr) && atr > 0 ? atr : null,
    volume: Number.isFinite(volume) ? volume : 0,
    avgVolume: Number.isFinite(avgVol) && avgVol > 0 ? avgVol : null,
    resistance: Number.isFinite(resistance) ? resistance : null,
    support: Number.isFinite(support) ? support : null,
    avgBarRange: avgBarRange > 0 ? avgBarRange : null,
    htf5mTrend: Number(latest?.htf_5m_ema_trend ?? 0),
    htf15mTrend: Number(latest?.htf_15m_ema_trend ?? 0),
    emaTrendPeriod: trendEmaPeriod,
  };
}

/**
 * Expected favorable move in **price units** (not %): min(ATR, room to S/R, recent avg range).
 */
export function estimateExpectedMove(features, bias) {
  if (!features?.price || !features.atr) return null;
  const atr = features.atr;
  const swing = features.avgBarRange != null && features.avgBarRange > 0 ? features.avgBarRange : atr;

  if (bias === "long" && features.resistance != null) {
    const room = Math.max(0, features.resistance - features.price);
    return clamp(Math.min(atr, room, swing), 0, Number.POSITIVE_INFINITY);
  }
  if (bias === "short" && features.support != null) {
    const room = Math.max(0, features.price - features.support);
    return clamp(Math.min(atr, room, swing), 0, Number.POSITIVE_INFINITY);
  }
  return clamp(Math.min(atr, swing), 0, Number.POSITIVE_INFINITY);
}

function legacyLongShortSlots(signalStrength) {
  if (!signalStrength) {
    return { long: null, short: null };
  }
  const b = signalStrength.componentScores || {};
  const empty = { total: 0, max: 100, confidence: 0, breakdown: {} };
  const long =
    signalStrength.signal === "BUY"
      ? {
          total: signalStrength.strength,
          max: 100,
          confidence: clamp(signalStrength.strength / 100, 0, 1),
          breakdown: { ...b },
        }
      : { ...empty };
  const short =
    signalStrength.signal === "SELL"
      ? {
          total: signalStrength.strength,
          max: 100,
          confidence: clamp(signalStrength.strength / 100, 0, 1),
          breakdown: { ...b },
        }
      : { ...empty };
  return { long, short };
}

/**
 * @param {object} p
 * @param {Array} p.candles
 * @param {Record<string, number>} p.indicatorsLatest
 * @param {{ trend?: number, buySignal?: boolean, sellSignal?: boolean, up?: number, dn?: number } | null} [p.supertrendLastRow]
 * @param {{ period?: number, multiplier?: number, wilderAtr?: boolean } | null} [p.supertrendOpts]
 */
export function computeDecisionSnapshot({ candles, indicatorsLatest, supertrendLastRow: _unused, supertrendOpts }) {
  const features = extractDecisionFeatures(candles, indicatorsLatest);
  const period = Math.max(2, Math.floor(Number(supertrendOpts?.period ?? process.env.SUPERTREND_PERIOD ?? 10)));
  const mult = clamp(Number(supertrendOpts?.multiplier ?? process.env.SUPERTREND_MULTIPLIER ?? 3), 0.5, 20);
  const wilderAtr = supertrendOpts?.wilderAtr !== false;

  const clean = sanitizeCandlesForSt(candles);
  const series =
    clean.length >= period ? computeSupertrendSeries(clean, { period, multiplier: mult, wilderAtr }) : [];

  const minWait = clamp(Number(process.env.SIGNAL_STRENGTH_MIN_WAIT ?? 40), 0, 100);
  const input = buildSignalStrengthInput({
    candles,
    indicatorsLatest,
    supertrendSeries: series,
    atrMultiplier: mult,
  });
  const signalStrength = input ? evaluateSignalStrength(input, minWait) : null;

  const { long, short } = legacyLongShortSlots(signalStrength);

  return {
    ts: Date.now(),
    features: features
      ? {
          price: features.price,
          ema200: features.ema200,
          rsi: features.rsi,
          atr: features.atr,
          volumeRatio:
            features.avgVolume != null && features.avgVolume > 0
              ? Math.round((features.volume / features.avgVolume) * 1000) / 1000
              : null,
          resistance: features.resistance,
          support: features.support,
          htf15mTrend: features.htf15mTrend,
          htf5mTrend: features.htf5mTrend,
          emaTrendPeriod: features.emaTrendPeriod,
        }
      : null,
    long,
    short,
    signalStrength,
    expectedMoveLong: features ? estimateExpectedMove(features, "long") : null,
    expectedMoveShort: features ? estimateExpectedMove(features, "short") : null,
  };
}
