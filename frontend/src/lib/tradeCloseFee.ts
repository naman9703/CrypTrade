/** Match backend `TRADE_CLOSE_FEE_RATE` default (4 bps on close notional). */
export const TRADE_CLOSE_FEE_RATE = 0.0004;

/** Same bounds as backend `clampFeeRate` in `trailingStopLoss.js`. */
export function clampTradeCloseFeeRate(r?: number): number {
  const x = Number(r ?? TRADE_CLOSE_FEE_RATE);
  if (!Number.isFinite(x) || x < 0) return TRADE_CLOSE_FEE_RATE;
  return Math.min(0.01, Math.max(0, x));
}

export function estimatedCloseFeeUsdt(
  qty: number | null | undefined,
  priceUsdt: number | null | undefined,
  rate = TRADE_CLOSE_FEE_RATE,
): number | null {
  const q = Number(qty);
  const px = Number(priceUsdt);
  if (!Number.isFinite(q) || !Number.isFinite(px) || q <= 0 || px <= 0) return null;
  return Math.round(q * px * rate * 1e6) / 1e6;
}

/** Opening leg: same notional × rate shape as close; pass `trailOpenFeeRate` for the rate. */
export function estimatedOpenFeeUsdt(
  qty: number | null | undefined,
  priceUsdt: number | null | undefined,
  rate = TRADE_CLOSE_FEE_RATE,
): number | null {
  return estimatedCloseFeeUsdt(qty, priceUsdt, rate);
}
