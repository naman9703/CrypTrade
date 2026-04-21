import type { RegimeSlice, RegimeType } from "./types";

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(100, Math.max(0, x));
}

/**
 * Classify a single bar into a regime slice + confidence.
 * Pure: no module-level state — safe for replay/backtest.
 */
export function computeRegimeSliceFromBar(args: {
  adx: number;
  price: number;
  ema: number;
  prevEma: number;
  atr: number;
  adxStrong: number;
  adxWeak: number;
  atrVolThreshold: number;
}): RegimeSlice {
  const { adx, price, ema, prevEma, atr, adxStrong, adxWeak, atrVolThreshold } = args;
  const p = Number(price);
  const emaSlope = Number(ema) - Number(prevEma);
  const atrN = Number(atr);
  const adxN = Number(adx);
  const atrRatio = Number.isFinite(p) && p > 0 && Number.isFinite(atrN) ? atrN / p : 0;

  let strength = Math.min(100, Math.max(0, adxN * 2.2));
  if (adxN > adxStrong + 10) strength = Math.min(100, strength + 8);

  let type: RegimeType = "UNCLEAR";

  if (atrRatio > atrVolThreshold) {
    type = "VOLATILE";
    strength = Math.max(strength, 40);
  } else if (adxN < adxWeak && atrRatio < atrVolThreshold * 0.6) {
    type = "SIDEWAYS";
    strength = Math.min(strength, 35);
  } else if (p > ema && emaSlope > 0) {
    type = "UPTREND";
  } else if (p < ema && emaSlope < 0) {
    type = "DOWNTREND";
  } else {
    type = "UNCLEAR";
  }

  // Confidence: ADX participation + EMA/price agreement
  let conf = 0;
  conf += clamp01(((adxN - 15) / 25) * 100) * 0.45;
  const aligned =
    (type === "UPTREND" && p >= ema) ||
    (type === "DOWNTREND" && p <= ema) ||
    type === "VOLATILE";
  if (aligned) conf += 25;
  if (Math.abs(emaSlope) / (p || 1) > 1e-6) conf += 15;
  if (type === "SIDEWAYS") conf *= 0.65;
  if (type === "UNCLEAR") conf *= 0.55;

  const confidence = clamp01(conf);

  return {
    type,
    strength: clamp01(strength),
    confidence,
    raw: {
      adx: adxN,
      atrRatio,
      emaSlope,
      price: p,
      ema: Number(ema),
    },
  };
}
