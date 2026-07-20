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

/** Uppercase + strip punctuation — aligns UI symbols (e.g. DOGE/USDT) with Binance wire `s`. */
export function normalizeSym(s) {
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

const DROP_LOG_LAST_AT = new Map();
const DROP_LOG_INTERVAL_MS = Math.max(1_000, Number(process.env.KLINE_SANITY_DROP_LOG_INTERVAL_MS || 60_000));

/**
 * If the kline update fails sanity vs the buffer, drop it (return null). Never rewrite OHLC to
 * "match" the prior close — artificial flat bars desync Supertrend, skip real flips, and invite
 * bogus follow-on signals once the stream recovers.
 */
export function sanitizeKlineCandle(symbol, candle, prev, log) {
  const sym = normalizeSym(symbol);
  const cl = Number(candle.close);
  const lo = Number(candle.low);
  const prevC = prev && Number.isFinite(Number(prev.close)) ? Number(prev.close) : null;
  const ts = Number(candle?.ts);
  const prevTs = prev && Number.isFinite(Number(prev.ts)) ? Number(prev.ts) : null;
  const gapMs = Number.isFinite(ts) && Number.isFinite(prevTs) ? Math.abs(ts - prevTs) : 0;

  // The step-ratio guard is meant for adjacent live bars. During REST repair/backfill a stale
  // tail can be hours or days behind; a valid move over that gap must not poison the whole series.
  if (prevC != null && gapMs > 6 * 60 * 60 * 1000 && isPlausibleCandleClose(sym, cl, lo, null)) return candle;

  if (isPlausibleCandleClose(sym, cl, lo, prevC)) return candle;

  const now = Date.now();
  const logKey = `${sym}:implausible`;
  const lastAt = DROP_LOG_LAST_AT.get(logKey) || 0;
  if (now - lastAt >= DROP_LOG_INTERVAL_MS) {
    DROP_LOG_LAST_AT.set(logKey, now);
    log?.warn?.("kline_tick_dropped_implausible", {
      symbol: sym,
      close: cl,
      prevClose: prevC,
      ts: candle?.ts,
      prevTs,
      gapMs,
    });
  }
  return null;
}
