/**
 * When the live Binance WS buffer has a fresh tail but only a few bars, `/market/candles`
 * must backfill from REST — otherwise the UI chart shows a single candle on load (all modes).
 */

export function chartMinBarsForSnapshot(supertrendPeriod = 10) {
  return Math.max(30, Number(supertrendPeriod ?? 10) + 2);
}

/**
 * @param {unknown[]} candles
 * @param {{ supertrendPeriod?: number, tailStale?: boolean }} opts
 */
export function chartSnapshotNeedsRestRepair(candles, opts = {}) {
  const minBars = chartMinBarsForSnapshot(opts.supertrendPeriod ?? 10);
  if (!Array.isArray(candles) || candles.length < minBars) return true;
  if (opts.tailStale === true) return true;
  return false;
}
