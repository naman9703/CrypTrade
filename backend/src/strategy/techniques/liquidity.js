/**
 * Liquidity sweep + session level helpers.
 */

export function liquiditySweep(candles, idx, side, lookback = 15) {
  const bar = candles[idx];
  const prior = candles.slice(Math.max(0, idx - lookback), idx);
  if (prior.length < 5) return false;
  if (side === "BUY") {
    const swingLow = Math.min(...prior.map((c) => c.low));
    return bar.low < swingLow && bar.close > swingLow;
  }
  const swingHigh = Math.max(...prior.map((c) => c.high));
  return bar.high > swingHigh && bar.close < swingHigh;
}

export function sweepReclaim(bar, level, side, sweepPct = 0.0006) {
  if (!Number.isFinite(level) || level <= 0) return false;
  if (side === "BUY") return bar.low < level * (1 - sweepPct) && bar.close > level;
  return bar.high > level * (1 + sweepPct) && bar.close < level;
}

export function rejectionWickRatio(bar, side) {
  const range = bar.high - bar.low || 1e-12;
  const bodyTop = Math.max(bar.open, bar.close);
  const bodyBot = Math.min(bar.open, bar.close);
  if (side === "BUY") return (bodyBot - bar.low) / range;
  return (bar.high - bodyTop) / range;
}
