/**
 * Reject corrupt / cross-symbol klines (e.g. BTC header showing ~587).
 * Used at Binance WS ingest before the candle buffer mutates downstream chart + bot.
 */

/** Exact [min, max] close for liquid USDT/USDC pairs (wide enough for years of data). */
const EXACT_CLOSE_RANGE = {
  BTCUSDT: [3_000, 2_000_000],
  BTCUSDC: [3_000, 2_000_000],
  WBTCUSDT: [3_000, 2_000_000],
  ETHUSDT: [200, 100_000],
  ETHUSDC: [200, 100_000],
  BNBUSDT: [5, 5_000],
  BNBUSDC: [5, 5_000],
  SOLUSDT: [1, 10_000],
  XRPUSDT: [0.01, 100],
  DOGEUSDT: [0.0001, 10],
  ADAUSDT: [0.01, 10],
  AVAXUSDT: [1, 10_000],
  DOTUSDT: [0.1, 500],
  LINKUSDT: [0.1, 500],
  LTCUSDT: [10, 5_000],
  BCHUSDT: [20, 10_000],
  TAOUSDT: [1, 10_000],
};

function normalizeSym(s) {
  return String(s ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function isPlausibleCandleClose(symbol, close, low, prevClose) {
  const s = normalizeSym(symbol);
  if (!Number.isFinite(close) || close <= 0) return false;

  const range = EXACT_CLOSE_RANGE[s];
  if (range) {
    const [lo, hi] = range;
    if (close < lo || close > hi) return false;
    if (low != null && Number.isFinite(low) && low < lo * 0.1) return false;
  } else {
    if (s.includes("BTC") && close < 100) return false;
    if (s.includes("ETH") && !s.includes("BETH") && close < 10) return false;
  }

  /** Listed majors: reject >~45% jump vs previous close (mixed stream / bad buffer splices). */
  const MAJOR_MAX_STEP_RATIO = 1.45;
  const MAJOR_MIN_STEP_RATIO = 1 / MAJOR_MAX_STEP_RATIO;

  if (prevClose != null && Number.isFinite(prevClose) && prevClose > 0) {
    const r = close / prevClose;
    if (range) {
      if (r < MAJOR_MIN_STEP_RATIO || r > MAJOR_MAX_STEP_RATIO) return false;
    } else if (prevClose > 50 && (r < 0.2 || r > 5.0)) return false;
  }

  return true;
}

/**
 * If the tick fails sanity, snap OHLC to previous bar's close (keeps one stream, discards corrupt print).
 * Returns null → caller should skip this WS message entirely.
 */
export function sanitizeKlineCandle(symbol, candle, prev, log) {
  const sym = normalizeSym(symbol);
  const cl = Number(candle.close);
  const lo = Number(candle.low);
  const prevC = prev && Number.isFinite(Number(prev.close)) ? Number(prev.close) : null;

  if (isPlausibleCandleClose(sym, cl, lo, prevC)) return candle;

  if (prevC != null && Number.isFinite(prevC) && prevC > 0) {
    log?.warn?.("kline_close_sanitized", { symbol: sym, corruptClose: cl, anchor: prevC });
    // Flat bar at the anchor: mixing corrupt high/low with a repaired close draws huge fake wicks
    // and collapses the chart scale (TradingView-style vertical "breaks").
    return {
      ...candle,
      open: prevC,
      high: prevC,
      low: prevC,
      close: prevC,
    };
  }

  const range = EXACT_CLOSE_RANGE[sym];
  if (range && (cl < range[0] || cl > range[1])) {
    log?.warn?.("kline_tick_dropped_no_anchor", { symbol: sym, close: cl });
    return null;
  }

  return candle;
}
