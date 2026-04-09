/** Match backend `TRADE_CLOSE_FEE_RATE` default (4 bps on close notional). */
export const TRADE_CLOSE_FEE_RATE = 0.0004;

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
