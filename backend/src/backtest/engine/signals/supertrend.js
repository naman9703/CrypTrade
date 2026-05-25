/**
 * Supertrend signal adapter for the backtest engine. Wraps the **same**
 * `computeSupertrendSeries` used by the live bot (backend/src/strategy/supertrend.js)
 * — re-implementing the indicator was the leading cause of "live ≠ backtest" drift.
 */
import { computeSupertrendSeries } from "../../../strategy/supertrend.js";

/**
 * @param {Array<{ts:number,open:number,high:number,low:number,close:number}>} candles
 * @param {{ period:number, multiplier:number, wilderAtr:boolean }} opts
 */
export function buildSupertrendSeries(candles, opts) {
  return computeSupertrendSeries(candles, {
    period: Number(opts.period ?? 10),
    multiplier: Number(opts.multiplier ?? 3),
    wilderAtr: opts.wilderAtr !== false,
  });
}

/**
 * Convert a Supertrend bar update into a buy/sell signal for the runner.
 * Returns null when no flip occurred, otherwise `{ action, reason }`.
 * @param {{ ready?: boolean, buySignal?: boolean, sellSignal?: boolean }} bar
 */
export function signalFromSupertrendBar(bar) {
  if (!bar?.ready) return null;
  if (bar.buySignal) return { action: "BUY", reason: "supertrend_flip_up" };
  if (bar.sellSignal) return { action: "SELL", reason: "supertrend_flip_down" };
  return null;
}
