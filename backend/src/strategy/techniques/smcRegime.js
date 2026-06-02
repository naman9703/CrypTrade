/**
 * SMC regime gate — ATR percentile vs rolling history.
 * Reversal sweeps tend to fail in low-vol chop and strong trend continuation;
 * this filter skips extremes using realized ATR% rank.
 */

/**
 * @param {object[]} candles
 * @param {object} pre precomputeIntraday
 * @param {number} idx
 * @param {number} lookbackBars
 * @returns {number|null} 0–100 percentile of current ATR% vs lookback window
 */
export function atrPercentileAt(candles, pre, idx, lookbackBars = 2880) {
  const atr = pre.atrSeries?.[idx];
  const close = candles[idx]?.close;
  if (!Number.isFinite(atr) || !Number.isFinite(close) || close <= 0) return null;
  const cur = atr / close;
  const start = Math.max(0, idx - lookbackBars);
  const samples = [];
  for (let i = start; i <= idx; i++) {
    const a = pre.atrSeries?.[i];
    const c = candles[i]?.close;
    if (!Number.isFinite(a) || !Number.isFinite(c) || c <= 0) continue;
    samples.push(a / c);
  }
  if (samples.length < 20) return null;
  const below = samples.filter((x) => x <= cur).length;
  return Math.round((below / samples.length) * 1000) / 10;
}

/**
 * @param {object[]} candles
 * @param {number} idx
 * @param {object} pre
 * @param {object} [opts]
 */
export function passesSmcRegimeFilter(candles, idx, pre, opts = {}) {
  if (opts.intradaySmcRegimeFilterEnabled !== true) return true;
  const lookback = Math.max(
    200,
    Number(opts.intradaySmcRegimeAtrLookbackBars ?? 2880),
  );
  const pct = atrPercentileAt(candles, pre, idx, lookback);
  if (pct == null) return true;
  const minPct = Number(opts.intradaySmcRegimeAtrPctMin ?? 35);
  const maxPct = Number(opts.intradaySmcRegimeAtrPctMax ?? 85);
  if (minPct > 0 && pct < minPct) return false;
  if (maxPct > 0 && pct > maxPct) return false;
  return true;
}
