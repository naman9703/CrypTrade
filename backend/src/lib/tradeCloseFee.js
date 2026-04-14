import { roundTo } from "./math.js";

/** Taker-style fee on USDT quote notional when exchange breakdown is missing (4 bps). Override with TRADE_CLOSE_FEE_RATE. */
export const DEFAULT_TRADE_CLOSE_FEE_RATE = 0.0004;

/** Taker fee for opening a position (same default as close). Override with TRADE_OPEN_FEE_RATE. */
export const DEFAULT_TRADE_OPEN_FEE_RATE = 0.0004;

export function tradeCloseFeeRate() {
  const r = Number(process.env.TRADE_CLOSE_FEE_RATE ?? DEFAULT_TRADE_CLOSE_FEE_RATE);
  return Number.isFinite(r) && r >= 0 ? r : DEFAULT_TRADE_CLOSE_FEE_RATE;
}

export function tradeOpenFeeRate() {
  const r = Number(process.env.TRADE_OPEN_FEE_RATE ?? process.env.TRADE_CLOSE_FEE_RATE ?? DEFAULT_TRADE_OPEN_FEE_RATE);
  return Number.isFinite(r) && r >= 0 ? r : DEFAULT_TRADE_OPEN_FEE_RATE;
}

/** True round-trip fee = open fee + close fee (what you need to break even). */
export function tradeRoundTripFeeRate() {
  return tradeOpenFeeRate() + tradeCloseFeeRate();
}

/**
 * Fee in USDT for one close leg: (qty × price in USDT) × rate.
 * @returns {number | null} null if inputs invalid
 */
export function tradeCloseFeeUsdtFromNotional(qty, priceUsdt, rate = tradeCloseFeeRate()) {
  const q = Number(qty);
  const px = Number(priceUsdt);
  if (!Number.isFinite(q) || !Number.isFinite(px) || q <= 0 || px <= 0) return null;
  return roundTo(q * px * rate, 6);
}
