/**
 * UTC-session VWAP (typical price × volume / cum vol per calendar day).
 * Guide: VWAP is a primary key level for OF entries.
 */

/** @param {object[]} candles @returns {number[]} */
export function buildSessionVwapSeries(candles) {
  const out = new Array(candles.length).fill(null);
  let day = null;
  let cumTpV = 0;
  let cumV = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = Math.floor(c.ts / 86_400_000);
    if (d !== day) {
      day = d;
      cumTpV = 0;
      cumV = 0;
    }
    const tp = (Number(c.high) + Number(c.low) + Number(c.close)) / 3;
    const v = Number(c.volume) || 0;
    cumTpV += tp * v;
    cumV += v;
    out[i] = cumV > 0 ? cumTpV / cumV : null;
  }
  return out;
}
