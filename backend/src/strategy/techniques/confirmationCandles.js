/**
 * Reaction confirmation candles — do not enter without price confirmation.
 */

import { rejectionWickRatio } from "./liquidity.js";

function bodySize(bar) {
  return Math.abs(bar.close - bar.open);
}

function range(bar) {
  return Math.max(1e-12, bar.high - bar.low);
}

/** Bullish engulfing: current body engulfs prior bearish body. */
export function isBullishEngulfing(bar, prev) {
  if (!prev) return false;
  const prevBear = prev.close < prev.open;
  const currBull = bar.close > bar.open;
  if (!prevBear || !currBull) return false;
  return bar.close >= prev.open && bar.open <= prev.close;
}

/** Bearish engulfing */
export function isBearishEngulfing(bar, prev) {
  if (!prev) return false;
  const prevBull = prev.close > prev.open;
  const currBear = bar.close < bar.open;
  if (!prevBull || !currBear) return false;
  return bar.close <= prev.open && bar.open >= prev.close;
}

export function isHammer(bar, minWick = 0.38) {
  return rejectionWickRatio(bar, "BUY") >= minWick && bar.close >= bar.open * 0.999;
}

export function isShootingStar(bar, minWick = 0.38) {
  return rejectionWickRatio(bar, "SELL") >= minWick && bar.close <= bar.open * 1.001;
}

/**
 * @param {object} bar
 * @param {object|null} prevBar
 * @param {'BUY'|'SELL'} side
 * @param {object} opts
 */
export function passesConfirmationCandle(bar, prevBar, side, opts = {}) {
  const minWick = Number(opts.intradaySrMinConfirmWick ?? 0.38);
  const minBodyRatio = Number(opts.intradaySrMinConfirmBodyRatio ?? 0);

  if (minBodyRatio > 0) {
    const br = bodySize(bar) / range(bar);
    if (br < minBodyRatio) return false;
  }

  if (side === "BUY") {
    if (isBullishEngulfing(bar, prevBar)) return true;
    if (isHammer(bar, minWick)) return true;
    if (rejectionWickRatio(bar, "BUY") >= minWick && bar.close > bar.open) return true;
  } else {
    if (isBearishEngulfing(bar, prevBar)) return true;
    if (isShootingStar(bar, minWick)) return true;
    if (rejectionWickRatio(bar, "SELL") >= minWick && bar.close < bar.open) return true;
  }
  return false;
}
