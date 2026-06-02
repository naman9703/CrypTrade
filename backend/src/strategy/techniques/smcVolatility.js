/**
 * SMC volatility / chop filters (ADX + ATR%).
 */

/**
 * @param {object[]} candles
 * @param {number} idx
 * @param {object} pre precomputeIntraday
 * @param {object} [opts]
 */
export function passesSmcVolatilityFilter(candles, idx, pre, opts = {}) {
  if (opts.intradaySmcVolFilterEnabled === false) return true;
  const minAdx = Number(opts.intradaySmcMinAdx ?? 18);
  const adx = pre.adxSeries?.[idx];
  if (Number.isFinite(minAdx) && minAdx > 0) {
    if (!Number.isFinite(adx) || adx < minAdx) return false;
  }

  const minAtrPct = Number(opts.intradaySmcMinAtrPct ?? 0);
  if (minAtrPct > 0) {
    const atr = pre.atrSeries?.[idx];
    const close = candles[idx]?.close;
    if (!Number.isFinite(atr) || !Number.isFinite(close) || close <= 0) return false;
    if (atr / close < minAtrPct) return false;
  }

  const maxAtrPct = Number(opts.intradaySmcMaxAtrPct ?? 0);
  if (maxAtrPct > 0) {
    const atr = pre.atrSeries?.[idx];
    const close = candles[idx]?.close;
    if (Number.isFinite(atr) && Number.isFinite(close) && close > 0 && atr / close > maxAtrPct) {
      return false;
    }
  }

  return true;
}
