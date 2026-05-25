/**
 * Swing-based Fibonacci retracement levels.
 */

const LEVELS = [0.382, 0.5, 0.618, 0.786];

export function swingHighLow(candles, endIdx, lookback = 48) {
  const start = Math.max(0, endIdx - lookback + 1);
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = start; i <= endIdx; i++) {
    hi = Math.max(hi, candles[i].high);
    lo = Math.min(lo, candles[i].low);
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) return null;
  return { high: hi, low: lo, range: hi - lo };
}

/** Uptrend pullback: levels from swing low → high. Downtrend: high → low. */
export function fibLevels(swing, direction = "up") {
  if (!swing) return [];
  const { high, low, range } = swing;
  if (direction === "up") {
    return LEVELS.map((r) => ({ ratio: r, price: high - range * r, kind: "retrace_up" }));
  }
  return LEVELS.map((r) => ({ ratio: r, price: low + range * r, kind: "retrace_down" }));
}

export function nearFibLevel(price, levels, tolPct = 0.0022) {
  if (!levels?.length || !Number.isFinite(price)) return null;
  for (const lv of levels) {
    if (lv.price > 0 && Math.abs(price - lv.price) / lv.price <= tolPct) {
      return lv;
    }
  }
  return null;
}
