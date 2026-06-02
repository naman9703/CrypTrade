/**
 * Structure shift (BOS) after liquidity sweep reclaim — micro structure break.
 */

/**
 * @param {object[]} candles
 * @param {{ reclaimIdx: number, sweepStartIdx: number, wick: number }} cycle
 * @param {'BUY'|'SELL'} side
 * @param {object} opts
 * @returns {{ ok: boolean, bosIdx: number, bosLevel: number }}
 */
export function detectStructureShift(candles, cycle, side, opts = {}) {
  const reclaimIdx = cycle.reclaimIdx;
  const sweepStart = Math.max(0, cycle.sweepStartIdx ?? reclaimIdx);
  const maxAfter = Math.max(0, Number(opts.intradaySrBosMaxBarsAfterReclaim ?? 3));
  const swingLb = Math.max(3, Number(opts.intradaySrBosSwingLookback ?? 12));

  if (reclaimIdx < 1 || reclaimIdx >= candles.length) {
    return { ok: false, bosIdx: -1, bosLevel: 0 };
  }

  const legLookback = Math.max(2, Number(opts.intradaySrBosLegLookback ?? 6));
  const legStart = Math.max(sweepStart, reclaimIdx - legLookback);
  let legHigh = -Infinity;
  let legLow = Infinity;
  for (let j = legStart; j < reclaimIdx; j++) {
    legHigh = Math.max(legHigh, candles[j].high);
    legLow = Math.min(legLow, candles[j].low);
  }

  let swingHigh = -Infinity;
  let swingLow = Infinity;
  const swStart = Math.max(0, reclaimIdx - swingLb);
  for (let j = swStart; j < reclaimIdx; j++) {
    swingHigh = Math.max(swingHigh, candles[j].high);
    swingLow = Math.min(swingLow, candles[j].low);
  }

  const endIdx = Math.min(candles.length - 1, reclaimIdx + maxAfter);

  if (side === "BUY") {
    const bosLevel = Number.isFinite(legHigh) && legHigh > -Infinity ? legHigh : swingHigh;
    if (!Number.isFinite(bosLevel) || bosLevel <= 0) {
      return { ok: false, bosIdx: -1, bosLevel: 0 };
    }
    for (let j = reclaimIdx; j <= endIdx; j++) {
      if (candles[j].high > bosLevel || candles[j].close > bosLevel) {
        return { ok: true, bosIdx: j, bosLevel: bosLevel };
      }
    }
  } else {
    const bosLevel = Number.isFinite(legLow) && legLow < Infinity ? legLow : swingLow;
    if (!Number.isFinite(bosLevel) || bosLevel <= 0) {
      return { ok: false, bosIdx: -1, bosLevel: 0 };
    }
    for (let j = reclaimIdx; j <= endIdx; j++) {
      if (candles[j].low < bosLevel || candles[j].close < bosLevel) {
        return { ok: true, bosIdx: j, bosLevel: bosLevel };
      }
    }
  }

  return { ok: false, bosIdx: -1, bosLevel: 0 };
}
