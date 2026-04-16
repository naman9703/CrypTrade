/**
 * Post-signal move quality: ATR-based expected move vs SL, ADX trend strength, ATR expansion,
 * candle body vs average, RSI slope — composite 0–1 score + hard gates (optional trade filter).
 */
import { clamp } from "../lib/math.js";
import { atr } from "./indicators.js";

function smaArrayTail(values, period) {
  const n = values.length;
  if (n < period) return null;
  let s = 0;
  for (let i = n - period; i < n; i++) s += values[i];
  return s / period;
}

function avgBodyRatio(candles, lookback = 10) {
  const n = candles?.length ?? 0;
  if (n < 2) return { lastBody: null, avgBody: null, ratio: null };
  const last = candles[n - 1];
  const lo = Number(last?.low ?? last?.close);
  const hi = Number(last?.high ?? last?.close);
  const op = Number(last?.open ?? last?.close);
  const cl = Number(last?.close);
  const range = Math.max(1e-12, hi - lo);
  const lastBody = Math.abs(cl - op) / range;
  let sum = 0;
  let c = 0;
  const start = Math.max(0, n - lookback);
  for (let i = start; i < n; i++) {
    const b = candles[i];
    const blo = Number(b?.low ?? b?.close);
    const bhi = Number(b?.high ?? b?.close);
    const bop = Number(b?.open ?? b?.close);
    const bcl = Number(b?.close);
    const br = Math.max(1e-12, bhi - blo);
    sum += Math.abs(bcl - bop) / br;
    c++;
  }
  const avgBody = c > 0 ? sum / c : null;
  const ratio = lastBody != null && avgBody != null && avgBody > 0 ? lastBody / avgBody : null;
  return { lastBody, avgBody, ratio };
}

function volumeVsAvgRatio(candles, lookback = 20) {
  const n = candles?.length ?? 0;
  if (n < 1) return { ratio: null };
  const lastVol = Number(candles[n - 1]?.volume);
  const start = Math.max(0, n - lookback);
  let sum = 0;
  let c = 0;
  for (let i = start; i < n; i++) {
    const v = Number(candles[i]?.volume);
    if (Number.isFinite(v) && v >= 0) {
      sum += v;
      c++;
    }
  }
  const avg = c > 0 ? sum / c : null;
  const ratio =
    Number.isFinite(lastVol) && lastVol >= 0 && avg != null && avg > 0 ? lastVol / avg : null;
  return { ratio };
}

/**
 * @param {object} p
 * @param {Array<{ open:number, high:number, low:number, close:number, volume?: number }>} p.candles oldest-first
 * @param {object} p.latest computeIndicators().latest
 * @param {"BUY"|"SELL"} p.openingSide
 * @param {number} p.slDistancePct positive fraction (e.g. 0.002 = 0.2% SL distance)
 * @param {object} [p.options]
 * @returns {{
 *   score: number,
 *   verdict: "PASS"|"BORDER"|"WEAK",
 *   pass: boolean,
 *   hardFails: string[],
 *   detail: Record<string, unknown>
 * }}
 */
export function evaluateSupertrendMoveQuality({ candles, latest, openingSide, slDistancePct, options = {} }) {
  const minScore = clamp(Number(options.minScore ?? 0.5), 0, 1);
  const minAdx = clamp(Number(options.minAdx ?? 18), 0, 100);
  const minMoveToSlRatio = Math.max(0.5, Number(options.minMoveToSlRatio ?? 1.5));
  const expectedMoveAtrMult = Math.max(0.1, Number(options.expectedMoveAtrMult ?? 1.5));
  /** 0 = skip ATR expansion check */
  const minAtrExpansion = Math.max(0, Number(options.minAtrExpansion ?? 0));
  const minBodyVsAvg = clamp(Number(options.minBodyVsAvg ?? 0.55), 0.1, 1);
  /** 0 = off. Else BUY needs (close−open)/range ≥ this; SELL needs ≤ −this. */
  const minDirectionalBody = clamp(Number(options.minDirectionalBody ?? 0), 0, 1);
  /** 0 = off. Else last volume must be ≥ SMA(volume)×this (e.g. 1.2). */
  const minVolumeVsAvgRatio = Math.max(0, Number(options.minVolumeVsAvgRatio ?? 0));

  const adx = Number(latest?.adx_14 ?? 0);
  const atrPct = Number(latest?.atr_pct ?? 0);
  const rsi = Number(latest?.rsi_14 ?? 50);
  const rsiPrev = latest?.rsi_14_prev != null && Number.isFinite(Number(latest.rsi_14_prev)) ? Number(latest.rsi_14_prev) : null;

  const expectedMovePct = Number.isFinite(atrPct) && atrPct > 0 ? atrPct * expectedMoveAtrMult : 0;
  const slPct = Number(slDistancePct);
  const moveToSlRatio = Number.isFinite(slPct) && slPct > 0 && expectedMovePct > 0 ? expectedMovePct / slPct : 0;

  let atrExpansion = 1;
  try {
    const atrSer = atr(candles, 14);
    const atrNow = atrSer.length ? atrSer[atrSer.length - 1] : 0;
    const atrAvg20 = smaArrayTail(atrSer.filter((x) => Number.isFinite(x) && x > 0), 20);
    if (Number.isFinite(atrNow) && atrNow > 0 && atrAvg20 != null && atrAvg20 > 0) {
      atrExpansion = atrNow / atrAvg20;
    }
  } catch {
    /* keep 1 */
  }

  const { lastBody, avgBody, ratio: bodyRatio } = avgBodyRatio(candles, 10);

  const last = candles?.length ? candles[candles.length - 1] : null;
  const lo0 = Number(last?.low ?? last?.close);
  const hi0 = Number(last?.high ?? last?.close);
  const op0 = Number(last?.open ?? last?.close);
  const cl0 = Number(last?.close);
  const range0 = Math.max(1e-12, hi0 - lo0);
  const directionalBody = Number.isFinite(cl0) && Number.isFinite(op0) ? (cl0 - op0) / range0 : null;

  const { ratio: volRatio } = volumeVsAvgRatio(candles, 20);

  const rsiSlope = rsiPrev != null && Number.isFinite(rsiPrev) ? rsi - rsiPrev : 0;

  const hardFails = [];
  if (Number.isFinite(slPct) && slPct > 0 && expectedMovePct < slPct * minMoveToSlRatio) {
    hardFails.push("expected_move_below_sl_ratio");
  }
  if (Number.isFinite(adx) && adx < minAdx) {
    hardFails.push("adx_below_min");
  }
  if (minAtrExpansion > 0 && atrExpansion < minAtrExpansion) {
    hardFails.push("atr_not_expanding");
  }
  if (bodyRatio != null && bodyRatio < minBodyVsAvg) {
    hardFails.push("weak_candle_body");
  }
  if (minDirectionalBody > 0 && directionalBody != null && Number.isFinite(directionalBody)) {
    if (openingSide === "BUY" && directionalBody < minDirectionalBody) {
      hardFails.push("directional_body_weak");
    }
    if (openingSide === "SELL" && directionalBody > -minDirectionalBody) {
      hardFails.push("directional_body_weak");
    }
  }
  if (minVolumeVsAvgRatio > 0) {
    if (volRatio == null || !Number.isFinite(volRatio) || volRatio < minVolumeVsAvgRatio) {
      hardFails.push("volume_below_avg_ratio");
    }
  }

  const adxScore = clamp((adx - 14) / 36, 0, 1);
  const moveSlScore = clamp(moveToSlRatio / minMoveToSlRatio, 0, 1);
  const expScore =
    minAtrExpansion <= 0
      ? 1
      : clamp((atrExpansion - 1) / Math.max(0.15, minAtrExpansion - 1), 0, 1);
  const bodyScore = bodyRatio != null ? clamp(bodyRatio / Math.max(minBodyVsAvg, 0.05), 0, 1) : 0.5;
  const rsiScore = clamp((2 + rsiSlope * (openingSide === "BUY" ? 1 : -1)) / 8, 0, 1);

  const score = clamp(
    (adxScore * 0.25 + moveSlScore * 0.3 + expScore * 0.15 + bodyScore * 0.2 + rsiScore * 0.1) /
      (0.25 + 0.3 + 0.15 + 0.2 + 0.1),
    0,
    1,
  );

  let verdict = "WEAK";
  if (score >= 0.62) verdict = "PASS";
  else if (score >= 0.42) verdict = "BORDER";

  const pass = hardFails.length === 0 && score >= minScore;

  return {
    score: round4(score),
    verdict,
    pass,
    hardFails,
    detail: {
      adx: round4(adx),
      atrPct: round4(atrPct),
      expectedMovePct: round4(expectedMovePct),
      slDistancePct: round4(slPct),
      moveToSlRatio: round4(moveToSlRatio),
      atrExpansion: round4(atrExpansion),
      lastBody: lastBody != null ? round4(lastBody) : null,
      avgBody: avgBody != null ? round4(avgBody) : null,
      bodyRatio: bodyRatio != null ? round4(bodyRatio) : null,
      directionalBody: directionalBody != null ? round4(directionalBody) : null,
      volumeVsAvgRatio: volRatio != null ? round4(volRatio) : null,
      rsiSlope: round4(rsiSlope),
      minMoveToSlRatio,
      expectedMoveAtrMult,
    },
  };
}

function round4(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 10000) / 10000;
}

/**
 * Estimate SL distance % for gate comparison when exact SL not yet computed.
 * @param {object} botState slice: supertrendFuturesAiConfidenceFilter, supertrendFuturesFixedSlPct
 * @param {"SPOT"|"FUTURES"} [venue]
 */
export function estimateSlDistancePctForMoveQualityGate(botState, latest, venue = "FUTURES") {
  const atrPct = Number(latest?.atr_pct ?? 0);
  if (venue === "SPOT") {
    return Number.isFinite(atrPct) && atrPct > 0 ? clamp(atrPct * 1.2, 0.0005, 0.04) : 0.002;
  }
  const fixedSl = clamp(Number(botState?.supertrendFuturesFixedSlPct ?? 0.002), 0.00005, 0.2);
  const aiOn = botState?.supertrendFuturesAiConfidenceFilter !== false;
  if (!aiOn) return fixedSl;
  /** Rough ATR-proportional SL width when AI tiers apply (order of magnitude for ratio test). */
  const fromAtr = Number.isFinite(atrPct) && atrPct > 0 ? clamp(atrPct * 1.25, 0.0008, 0.06) : fixedSl;
  return fromAtr;
}
