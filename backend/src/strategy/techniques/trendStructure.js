/**
 * Market structure state from confirmed swings (HH/HL vs LH/LL).
 */

import {
  getConfirmedSwings,
  lastSwingHighBefore,
  lastSwingLowBefore,
  prevSwingHighBefore,
  prevSwingLowBefore,
} from "./marketStructure.js";

/** @typedef {'BULLISH'|'BEARISH'|'RANGE'|'UNKNOWN'} TrendStructureState */

/**
 * @param {object[]} candles
 * @param {number} idx
 * @param {object} [opts]
 * @returns {{ state: TrendStructureState, lastHigh: number|null, lastLow: number|null, prevHigh: number|null, prevLow: number|null }}
 */
export function getTrendStructureAt(candles, idx, opts = {}) {
  const lastH = lastSwingHighBefore(candles, idx, opts);
  const lastL = lastSwingLowBefore(candles, idx, opts);
  const prevH = prevSwingHighBefore(candles, idx, opts);
  const prevL = prevSwingLowBefore(candles, idx, opts);

  if (!lastH || !lastL || !prevH || !prevL) {
    return {
      state: "UNKNOWN",
      lastHigh: lastH?.price ?? null,
      lastLow: lastL?.price ?? null,
      prevHigh: prevH?.price ?? null,
      prevLow: prevL?.price ?? null,
    };
  }

  const hh = lastH.price > prevH.price;
  const hl = lastL.price > prevL.price;
  const lh = lastH.price < prevH.price;
  const ll = lastL.price < prevL.price;

  let state = "RANGE";
  if (hh && hl) state = "BULLISH";
  else if (lh && ll) state = "BEARISH";

  return {
    state,
    lastHigh: lastH.price,
    lastLow: lastL.price,
    prevHigh: prevH.price,
    prevLow: prevL.price,
    lastHighPivot: lastH.pivotIdx,
    lastLowPivot: lastL.pivotIdx,
  };
}

/**
 * Last confirmed swing low before idx (for bearish CHoCH — break of HL).
 * @returns {number|null}
 */
export function lastHigherLowLevel(candles, idx, opts = {}) {
  const { lows } = getConfirmedSwings(candles, idx, opts);
  if (lows.length < 2) return lows.length === 1 ? lows[0].price : null;
  return lows[lows.length - 1].price;
}

/** Last confirmed swing high (for bullish CHoCH — break of LH). */
export function lastLowerHighLevel(candles, idx, opts = {}) {
  const { highs } = getConfirmedSwings(candles, idx, opts);
  if (highs.length < 2) return highs.length === 1 ? highs[0].price : null;
  return highs[highs.length - 1].price;
}
