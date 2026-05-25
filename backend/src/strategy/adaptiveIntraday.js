/**
 * Per-symbol adaptive brackets from recent ATR% (works across alts).
 */

import { atr as computeAtr } from "./indicators.js";

function median(arr) {
  const s = [...arr].filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * @param {object[]} candles
 * @param {object} [overrides]
 */
export function computeAdaptiveIntradayParams(candles, overrides = {}) {
  const n = candles.length;
  const lookback = Math.min(200, Math.max(80, n - 1));
  const atrSeries = computeAtr(candles, 14);
  const atrPcts = [];
  for (let i = Math.max(0, n - lookback); i < n; i++) {
    const c = candles[i];
    const a = atrSeries[i];
    if (c.close > 0 && Number.isFinite(a)) atrPcts.push(a / c.close);
  }
  const m = median(atrPcts) ?? 0.006;
  const volScale = m / 0.006;

  const slPct = Math.min(0.014, Math.max(0.004, m * 1.65 * (overrides.slMult ?? 1)));
  const tpPct = Math.min(0.035, Math.max(0.009, m * 3.4 * (overrides.tpMult ?? 1)));
  const sweepPct = Math.min(0.0012, Math.max(0.0004, m * 0.45));
  const minScore = Math.round(
    Math.min(13, Math.max(9, 10 + (volScale > 1.2 ? 1 : 0) + (overrides.minScoreBump ?? 0))),
  );

  return {
    atrPctMedian: m,
    sweepPct,
    slPct,
    tpPct,
    minScore,
    sessionNearPct: Math.min(0.0025, sweepPct * 2.2),
    volScale,
  };
}
