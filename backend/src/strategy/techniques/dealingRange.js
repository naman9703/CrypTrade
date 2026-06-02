/**
 * ICT dealing-range premium / discount filter (no lookahead).
 *
 * Range = swing high/low over a lookback ending at the entry bar.
 * Equilibrium = 50% of range.
 * Longs: price in discount (at/below equilibrium); shorts: premium (at/above).
 * Optional OTE band (62–79% retracement from range extreme).
 */

function isFullProfile(opts) {
  const p = String(opts.intradaySmcIctProfile ?? "").toLowerCase();
  return p === "full" || p === "ict2022";
}

export function resolveRequirePremiumDiscount(opts = {}) {
  if (opts.intradaySmcRequirePremiumDiscount === false) return false;
  if (opts.intradaySmcRequirePremiumDiscount === true) return true;
  return isFullProfile(opts);
}

/**
 * @param {object[]} candles
 * @param {number} idx entry bar (inclusive)
 * @param {object} [opts]
 * @returns {{ high: number, low: number, equilibrium: number, range: number } | null}
 */
export function findDealingRange(candles, idx, opts = {}) {
  if (!candles?.length || idx < 0) return null;
  const lookback = Math.max(10, Math.round(Number(opts.intradaySmcDealingRangeLookback ?? 48)));
  const start = Math.max(0, idx - lookback);
  let high = -Infinity;
  let low = Infinity;
  for (let i = start; i <= idx; i++) {
    const b = candles[i];
    if (!b) continue;
    high = Math.max(high, Number(b.high));
    low = Math.min(low, Number(b.low));
  }
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) return null;
  const range = high - low;
  return { high, low, equilibrium: (high + low) / 2, range };
}

/**
 * @param {'BUY'|'SELL'} side
 * @param {number} price
 * @param {{ high: number, low: number, equilibrium: number, range: number }} dr
 * @param {object} [opts]
 */
export function passesPremiumDiscount(side, price, dr, opts = {}) {
  if (!dr || !Number.isFinite(price)) return false;
  const { high, low, equilibrium, range } = dr;
  if (range <= 0) return false;

  const useOte = opts.intradaySmcPremiumDiscountOte === true;
  const oteMin = Math.max(0.5, Math.min(0.9, Number(opts.intradaySmcOteMin ?? 0.62)));
  const oteMax = Math.max(oteMin, Math.min(0.95, Number(opts.intradaySmcOteMax ?? 0.79)));
  const tolPct = Math.max(0, Number(opts.intradaySmcPremiumDiscountTolPct ?? 0));

  if (useOte) {
    if (side === "BUY") {
      const oteTop = low + range * (1 - oteMin);
      const oteBottom = low + range * (1 - oteMax);
      return price <= equilibrium && price >= oteBottom - range * tolPct && price <= oteTop + range * tolPct;
    }
    const oteBottom = high - range * (1 - oteMin);
    const oteTop = high - range * (1 - oteMax);
    return price >= equilibrium && price >= oteBottom - range * tolPct && price <= oteTop + range * tolPct;
  }

  const tol = tolPct * range;
  if (side === "BUY") return price <= equilibrium + tol;
  return price >= equilibrium - tol;
}

export function getDealingRangeMeta(dr) {
  if (!dr) return null;
  return {
    dealingRangeHigh: dr.high,
    dealingRangeLow: dr.low,
    dealingRangeEquilibrium: dr.equilibrium,
    dealingRangeSize: dr.range,
  };
}
