/**
 * Order-flow proxy from OHLCV: bar delta + cumulative volume delta (CVD).
 */

export function barDelta(bar) {
  const vol = Number(bar.volume) || 0;
  const range = bar.high - bar.low || 1e-12;
  const buyPct = (bar.close - bar.low) / range;
  const delta = vol * (2 * buyPct - 1);
  return delta;
}

export function buildCvdSeries(candles) {
  const out = new Array(candles.length).fill(0);
  let cvd = 0;
  for (let i = 0; i < candles.length; i++) {
    cvd += barDelta(candles[i]);
    out[i] = cvd;
  }
  return out;
}

/** Bullish: CVD rising over lookback; bearish: falling */
export function cvdMomentum(cvdSeries, idx, lookback = 6) {
  if (idx < lookback) return { bullish: false, bearish: false, slope: 0 };
  const now = cvdSeries[idx];
  const prev = cvdSeries[idx - lookback];
  const slope = now - prev;
  return {
    bullish: slope > 0,
    bearish: slope < 0,
    slope,
  };
}

export function deltaImbalance(candles, idx, lookback = 5) {
  let buy = 0;
  let sell = 0;
  for (let i = Math.max(0, idx - lookback + 1); i <= idx; i++) {
    const d = barDelta(candles[i]);
    if (d >= 0) buy += d;
    else sell += Math.abs(d);
  }
  const total = buy + sell || 1;
  return { buyPct: buy / total, sellPct: sell / total };
}
