// Uses candle data already in memory from the market feed cache
// No external API calls — pure computation on existing data

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];

export const confluenceProcessor = {
  async compute(symbol, cache) {
    const breakdown  = {};
    const primary    = cache.candles?.[symbol]?.['15m'];
    const primaryDir = primary ? getSupertrendDir(primary) : null;

    let agreeing = 0, defined = 0;

    for (const tf of TIMEFRAMES) {
      const candles = cache.candles?.[symbol]?.[tf];
      if (!candles || candles.length < 20) {
        breakdown[tf] = null;
        continue;
      }
      const dir     = getSupertrendDir(candles);
      breakdown[tf] = dir;
      defined++;
      if (dir && dir === primaryDir) agreeing++;
    }

    const score = defined > 0 ? Math.round((agreeing / defined) * 100) : 50;

    return {
      score,
      /** Timeframes that had enough bars and matched the 15m primary direction */
      agreeing,
      /** Timeframes with ≥20 bars (eligible for direction) */
      defined,
      breakdown,
      primaryDir,
      bias:
        defined <= 0
          ? 'insufficient_data'
          : score >= 70
            ? 'strong_agree'
            : score >= 55
              ? 'mild_agree'
              : score <= 30
                ? 'strong_conflict'
                : 'mixed',
    };
  }
};

function getSupertrendDir(candles) {
  if (candles.length < 14) return null;
  try {
    const mult = 3.0;
    const period = 10;

    const trValues = candles.slice(-period - 1).map((c, i, arr) => {
      if (i === 0) return parseFloat(c.high) - parseFloat(c.low);
      const prev = arr[i - 1];
      return Math.max(
        parseFloat(c.high) - parseFloat(c.low),
        Math.abs(parseFloat(c.high) - parseFloat(prev.close)),
        Math.abs(parseFloat(c.low)  - parseFloat(prev.close))
      );
    });
    const atr   = trValues.reduce((a, b) => a + b, 0) / trValues.length;
    const last  = candles[candles.length - 1];
    const mid   = (parseFloat(last.high) + parseFloat(last.low)) / 2;
    const upper = mid + mult * atr;
    const lower = mid - mult * atr;
    const close = parseFloat(last.close);

    return close > upper ? 'up' :
           close < lower ? 'down' : null;
  } catch {
    return null;
  }
}
