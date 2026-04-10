/**
 * Guards against mixed-symbol / corrupt ticks (e.g. BTC chart showing ~587).
 * Keep in sync with `backend/src/lib/symbolPriceSanity.js` (feed ingest).
 */

const EXACT_CLOSE_RANGE: Record<string, readonly [number, number]> = {
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

function normalizeSym(s: string): string {
  return String(s ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** Returns null when there is no floor (unknown pair → only ratio / positivity checks). */
export function minPlausibleClose(symbol: string): number | null {
  const s = normalizeSym(symbol);
  const r = EXACT_CLOSE_RANGE[s];
  if (r) return r[0];
  if (s.includes("BTC")) return 100;
  if (s.includes("ETH")) return 10;
  if (s.includes("BNB")) return 3;
  if (s.includes("SOL")) return 0.3;
  if (s.includes("XRP")) return 0.01;
  if (s.includes("DOGE")) return 0.0001;
  return null;
}

export function isPlausibleCandleClose(
  symbol: string,
  close: number,
  low?: number,
  prevClose?: number | null,
): boolean {
  const s = normalizeSym(symbol);
  if (!Number.isFinite(close) || close <= 0) return false;

  const range = EXACT_CLOSE_RANGE[s];
  if (range) {
    const [lo, hi] = range;
    if (close < lo || close > hi) return false;
    if (low != null && Number.isFinite(low) && low < lo * 0.1) return false;
  } else {
    const min = minPlausibleClose(symbol);
    if (min != null && close < min * 0.2) return false;
    if (low != null && Number.isFinite(low) && min != null && low < min * 0.01) return false;
  }

  /** Listed majors: reject >~45% jump vs previous close (stops mixed-symbol / bad splice “cliffs” on 1m). */
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
