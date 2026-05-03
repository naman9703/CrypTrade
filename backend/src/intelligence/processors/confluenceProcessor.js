// Uses candle data already in memory from the market feed cache
// No external API calls — pure computation on existing data

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"];

/** @param {{ period?: number, multiplier?: number, wilder?: boolean }} stParams */
export const confluenceProcessor = {
  async compute(symbol, cache, stParams = {}) {
    const period = Math.max(2, Math.min(100, Math.floor(Number(stParams.period) || 10)));
    const multiplier = Math.max(0.5, Math.min(50, Number(stParams.multiplier) || 3));
    const wilder = Boolean(stParams.wilder);
    const p = { period, multiplier, wilder };

    const breakdown = {};
    const primary = cache.candles?.[symbol]?.["15m"];
    const primaryDir = primary ? getSupertrendDir(primary, p) : null;

    let agreeing = 0;
    let defined = 0;

    for (const tf of TIMEFRAMES) {
      const candles = cache.candles?.[symbol]?.[tf];
      const minBars = Math.max(20, period + 8);
      if (!candles || candles.length < minBars) {
        breakdown[tf] = null;
        continue;
      }
      const dir = getSupertrendDir(candles, p);
      breakdown[tf] = dir;
      defined++;
      if (dir && dir === primaryDir) agreeing++;
    }

    const score = defined > 0 ? Math.round((agreeing / defined) * 100) : 50;

    return {
      score,
      agreeing,
      defined,
      breakdown,
      primaryDir,
      bias:
        defined <= 0
          ? "insufficient_data"
          : score >= 70
            ? "strong_agree"
            : score >= 55
              ? "mild_agree"
              : score <= 30
                ? "strong_conflict"
                : "mixed",
      supertrendParamsUsed: { period, multiplier, wilder },
    };
  },
};

/**
 * Direction from simplified Supertrend-style bands — parameters aligned with active bot ST config when passed.
 * @param {unknown[]} candles
 * @param {{ period: number, multiplier: number, wilder: boolean }} stParams
 */
function getSupertrendDir(candles, stParams) {
  const period = stParams.period;
  const mult = stParams.multiplier;
  const useWilder = stParams.wilder;
  const minLen = Math.max(14, period + 8);
  if (!Array.isArray(candles) || candles.length < minLen) return null;
  try {
    const tr = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i];
      const prev = candles[i - 1];
      const h = parseFloat(c.high);
      const l = parseFloat(c.low);
      const pc = parseFloat(prev.close);
      tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    if (tr.length < period) return null;

    let atr;
    if (useWilder) {
      atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
      for (let i = period; i < tr.length; i++) {
        atr = (atr * (period - 1) + tr[i]) / period;
      }
    } else {
      const slice = tr.slice(-period);
      atr = slice.reduce((a, b) => a + b, 0) / period;
    }

    const last = candles[candles.length - 1];
    const mid = (parseFloat(last.high) + parseFloat(last.low)) / 2;
    const upper = mid + mult * atr;
    const lower = mid - mult * atr;
    const close = parseFloat(last.close);

    return close > upper ? "up" : close < lower ? "down" : null;
  } catch {
    return null;
  }
}
