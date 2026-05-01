/**
 * RV: annualized % from ~24h of 1h log returns (same scale as before).
 * IV: Deribit ATM mark_iv when present in cache.options[symbol].impliedVol — documented as annualized %.
 * ivRvRatio = IV/RV when both are comparable positive percentages.
 */

const IV_RICH_RATIO = 1.15;
const IV_CHEAP_RATIO = 0.85;

export const volatilityProcessor = {
  compute(symbol, cache) {
    const sym = String(symbol || '').trim().toUpperCase();
    const atmIvRaw =
      cache.options?.[sym]?.impliedVol != null ? Number(cache.options[sym].impliedVol) : null;
    /** Deribit mark_iv is typically a percentage number e.g. 55 → 55% annualized */
    const impliedVolAnnualPct =
      atmIvRaw != null && Number.isFinite(atmIvRaw) && atmIvRaw > 0 ? atmIvRaw : null;

    const candles = cache.candles?.[symbol]?.['1h'];
    if (!candles || candles.length < 24) {
      return baseVol(null, impliedVolAnnualPct, cache.adx?.[symbol] ?? 25);
    }

    const returns = [];
    for (let i = 1; i < Math.min(candles.length, 25); i++) {
      const prev = parseFloat(candles[candles.length - i - 1].close);
      const curr = parseFloat(candles[candles.length - i].close);
      if (prev > 0) returns.push(Math.log(curr / prev));
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
    /** Annualized realised vol as percentage (aligned with typical IV quote style). */
    const rv24h = Math.sqrt(variance * 24 * 365) * 100;

    return baseVol(rv24h, impliedVolAnnualPct, cache.adx?.[symbol] ?? 25);
  },
};

/**
 * @param {number | null} rv24h
 * @param {number | null} impliedVolAnnualPct
 * @param {number} adxValue
 */
function baseVol(rv24h, impliedVolAnnualPct, adxValue) {
  let ivRvRatio = null;
  if (
    impliedVolAnnualPct != null &&
    rv24h != null &&
    Number.isFinite(rv24h) &&
    rv24h > 1e-6
  ) {
    ivRvRatio = impliedVolAnnualPct / rv24h;
  }

  let ivRelativeRegime = 'unknown';
  if (impliedVolAnnualPct == null || rv24h == null || ivRvRatio == null) {
    ivRelativeRegime = 'unknown';
  } else if (ivRvRatio >= IV_RICH_RATIO) {
    ivRelativeRegime = 'iv_rich';
  } else if (ivRvRatio <= IV_CHEAP_RATIO) {
    ivRelativeRegime = 'iv_cheap';
  } else {
    ivRelativeRegime = 'balanced';
  }

  const volRegime =
    rv24h == null ? 'unknown' : rv24h > 80 ? 'high' : rv24h > 40 ? 'medium' : 'low';
  const adxRegime = adxValue > 30 ? 'trending' : adxValue > 20 ? 'weak_trend' : 'choppy';

  const combined =
    rv24h == null
      ? 'unknown'
      : volRegime === 'high' && adxRegime === 'trending'
        ? 'high_vol_trending'
        : volRegime === 'high' && adxRegime === 'choppy'
          ? 'high_vol_choppy'
          : volRegime === 'low' && adxRegime === 'trending'
            ? 'low_vol_trending'
            : volRegime === 'low' && adxRegime === 'choppy'
              ? 'low_vol_choppy'
              : 'medium_vol_weak_trend';

  return {
    realisedVol24h: rv24h,
    impliedVolAnnualPct,
    ivRvRatio,
    ivRelativeRegime,
    volRegime,
    adxRegime,
    combined,
  };
}
