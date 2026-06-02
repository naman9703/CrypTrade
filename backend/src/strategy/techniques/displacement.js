/**
 * Displacement candle — a forceful momentum candle relative to recent volatility.
 *
 * ICT displacement is the energetic move that breaks structure (the MSS leg) and
 * leaves an imbalance/FVG behind. A meaningful displacement must be large versus
 * the *recent* body distribution and versus ATR — not merely bigger than the one
 * candle before it.
 */

/** Average candle body over the `lookback` bars immediately before `idx`. */
export function rollingAvgBody(candles, idx, lookback = 14) {
  const start = Math.max(0, idx - lookback);
  let sum = 0;
  let n = 0;
  for (let j = start; j < idx; j++) {
    const b = candles[j];
    if (!b) continue;
    sum += Math.abs(Number(b.close) - Number(b.open));
    n += 1;
  }
  return n ? sum / n : 0;
}

/**
 * Legacy single-bar displacement check (kept for backward compatibility / fallback
 * when neither a rolling body average nor ATR is available).
 * @param {object} bar
 * @param {object} [prev]
 * @param {'BUY'|'SELL'} side
 * @param {object} [opts]
 */
export function isDisplacementCandle(bar, prev, side, opts = {}) {
  const mult = Number(opts.intradaySmcDisplacementBodyMult ?? 1.5);
  const body = Math.abs(bar.close - bar.open);
  const prevBody = prev ? Math.abs(prev.close - prev.open) : body;
  if (prevBody > 0 && body < prevBody * mult) return false;
  if (side === "BUY") return bar.close > bar.open;
  return bar.close < bar.open;
}

/**
 * Displacement at bar `idx`: directional candle whose body clearly exceeds the
 * recent average body and (when available) a fraction of ATR.
 * @param {object[]} candles
 * @param {number} idx
 * @param {'BUY'|'SELL'} side
 * @param {object} [opts]
 * @param {object} [pre] precomputeIntraday result (for atrSeries)
 */
export function passesDisplacementAt(candles, idx, side, opts = {}, pre = null) {
  if (idx < 0 || idx >= candles.length) return false;
  const bar = candles[idx];
  if (!bar) return false;

  // Direction must match the trade side.
  if (side === "BUY" && !(bar.close > bar.open)) return false;
  if (side === "SELL" && !(bar.close < bar.open)) return false;

  const body = Math.abs(Number(bar.close) - Number(bar.open));
  if (!(body > 0)) return false;

  const mult = Number(opts.intradaySmcDisplacementBodyMult ?? 1.5);
  const lookback = Math.max(3, Number(opts.intradaySmcDisplacementLookback ?? 14));
  const avgBody = rollingAvgBody(candles, idx, lookback);
  const atr = Number(pre?.atrSeries?.[idx] ?? 0);

  let checked = false;

  // Body must clearly beat the recent average body.
  if (avgBody > 0) {
    checked = true;
    if (body < avgBody * mult) return false;
  }

  // Body must be a meaningful fraction of ATR (true expansion, not a thin candle).
  const atrMult = Number(opts.intradaySmcDisplacementAtrMult ?? 0.8);
  if (atr > 0 && atrMult > 0) {
    checked = true;
    if (body < atr * atrMult) return false;
  }

  // No volatility reference available — fall back to the single-bar heuristic.
  if (!checked) {
    const prev = idx > 0 ? candles[idx - 1] : null;
    return isDisplacementCandle(bar, prev, side, opts);
  }

  return true;
}
