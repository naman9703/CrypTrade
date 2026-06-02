/**
 * SMC entry brackets — liquidity SL + partial TP + opposing/internal liquidity TP2.
 */

import { computeLiquidityBrackets } from "./liquidity.js";
import { lastSwingHighBefore, lastSwingLowBefore, nearestInternalLiquidityTarget } from "./marketStructure.js";

/**
 * @param {'BUY'|'SELL'} side
 * @param {number} entry
 * @param {number} opposing PDH/PDL pool
 * @param {number|null} internal nearest swing liquidity after reclaim
 * @param {object} [opts]
 * @returns {number} TP2 price level
 */
export function resolveSmcTp2Level(side, entry, opposing, internal, opts = {}) {
  const mode = String(opts.intradaySmcTp2Mode ?? "opposing").toLowerCase();
  const fill = Number(entry);
  const opp = Number(opposing);
  const int = internal != null ? Number(internal) : 0;

  if (mode === "internal") {
    if (side === "BUY" && int > fill) return int;
    if (side === "SELL" && int > 0 && int < fill) return int;
    return opp;
  }

  if (mode === "tiered") {
    // Primary: nearest internal swing; fall back to opposing only if no valid internal.
    if (side === "BUY" && int > fill) return int;
    if (side === "SELL" && int > 0 && int < fill) return int;
    return opp;
  }

  return opp;
}

/**
 * @param {'BUY'|'SELL'} side
 * @param {number} entry
 * @param {object} setup liquidity setup with wick, opposing, reclaimIdx
 * @param {object[]} candles
 * @param {number} idx
 * @param {object} [opts]
 */
export function buildSmcBrackets(side, entry, setup, candles, idx, opts = {}) {
  const slMode = String(opts.intradaySmcSlMode ?? "sweep").toLowerCase();
  let sweepWick = setup.wick;

  if (slMode === "structure") {
    if (side === "BUY") {
      const sl = lastSwingLowBefore(candles, idx, opts);
      if (sl?.price) sweepWick = Math.min(sweepWick, sl.price);
    } else {
      const sh = lastSwingHighBefore(candles, idx, opts);
      if (sh?.price) sweepWick = Math.max(sweepWick, sh.price);
    }
  }

  const opposing = setup.opposing ?? setup.opposingLevel;
  const reclaimIdx = setup.reclaimIdx ?? setup.sweepReclaimIdx ?? idx;
  const internal = nearestInternalLiquidityTarget(candles, idx, side, opts, reclaimIdx);
  const tp2Target = resolveSmcTp2Level(side, entry, opposing, internal, opts);
  const tp2Mode = String(opts.intradaySmcTp2Mode ?? "opposing").toLowerCase();

  // SMC path owns min R:R via intradaySmcMinRr — do not inherit liquidity gate filter.
  const br = computeLiquidityBrackets(side, entry, sweepWick, tp2Target, {
    ...opts,
    intradayLiqMinRr: 0,
  });
  if (!br) return null;

  const minRr = Number(opts.intradaySmcMinRr ?? 1.5);
  if (minRr > 0 && br.rr != null && br.rr < minRr) return null;

  return {
    ...br,
    sweepWick,
    smcSlMode: slMode,
    tp2Mode,
    internalTpLevel: internal ?? null,
    sessionOpposingLevel: opposing,
  };
}
