/**
 * Confirmed swing highs/lows — no repaint (swing at pivot P known at P + confirmBars).
 */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** @param {object} [opts] */
export function resolveSwingOpts(opts = {}) {
  const left = Math.max(1, Math.floor(Number(opts.intradaySmcSwingLeft ?? 2)));
  const right = Math.max(1, Math.floor(Number(opts.intradaySmcSwingRight ?? 2)));
  const confirmBars = Math.max(1, Math.floor(Number(opts.intradaySmcSwingConfirmBars ?? 2)));
  return { left, right, confirmBars };
}

/**
 * Raw pivot at index `p` (not yet confirmed at current bar).
 * @param {object[]} candles
 * @param {number} p
 * @param {{ left: number, right: number }} swingOpts
 */
function isPivotHighAt(candles, p, { left, right }) {
  if (p < left || p + right >= candles.length) return false;
  const h = num(candles[p].high);
  if (!Number.isFinite(h)) return false;
  for (let j = p - left; j <= p + right; j++) {
    if (j === p) continue;
    const hj = num(candles[j].high);
    if (!Number.isFinite(hj) || hj >= h) return false;
  }
  return true;
}

function isPivotLowAt(candles, p, { left, right }) {
  if (p < left || p + right >= candles.length) return false;
  const l = num(candles[p].low);
  if (!Number.isFinite(l)) return false;
  for (let j = p - left; j <= p + right; j++) {
    if (j === p) continue;
    const lj = num(candles[j].low);
    if (!Number.isFinite(lj) || lj <= l) return false;
  }
  return true;
}

/**
 * Swings confirmed as of bar index `idx` (pivot at P visible at P + confirmBars).
 * @returns {{ highs: { pivotIdx: number, price: number, confirmedAt: number }[], lows: { pivotIdx: number, price: number, confirmedAt: number }[] }}
 */
export function getConfirmedSwings(candles, idx, opts = {}) {
  const swingOpts = resolveSwingOpts(opts);
  const { confirmBars } = swingOpts;
  const highs = [];
  const lows = [];
  if (!candles?.length || idx < 0) return { highs, lows };

  const end = Math.min(idx, candles.length - 1);
  const maxPivot = end - confirmBars;
  const minPivot = swingOpts.left;

  for (let p = minPivot; p <= maxPivot; p++) {
    const confirmedAt = p + confirmBars;
    if (confirmedAt > idx) continue;

    if (isPivotHighAt(candles, p, swingOpts)) {
      highs.push({ pivotIdx: p, price: num(candles[p].high), confirmedAt });
    }
    if (isPivotLowAt(candles, p, swingOpts)) {
      lows.push({ pivotIdx: p, price: num(candles[p].low), confirmedAt });
    }
  }

  return { highs, lows };
}

/** @returns {{ pivotIdx: number, price: number, confirmedAt: number } | null} */
export function lastSwingHighBefore(candles, idx, opts = {}) {
  const { highs } = getConfirmedSwings(candles, idx, opts);
  if (!highs.length) return null;
  return highs[highs.length - 1];
}

/** @returns {{ pivotIdx: number, price: number, confirmedAt: number } | null} */
export function lastSwingLowBefore(candles, idx, opts = {}) {
  const { lows } = getConfirmedSwings(candles, idx, opts);
  if (!lows.length) return null;
  return lows[lows.length - 1];
}

/** Second-to-last confirmed swing high (for HH detection). */
export function prevSwingHighBefore(candles, idx, opts = {}) {
  const { highs } = getConfirmedSwings(candles, idx, opts);
  if (highs.length < 2) return null;
  return highs[highs.length - 2];
}

/**
 * Nearest confirmed intraday swing liquidity above (long) or below (short) entry,
 * with pivot at or after `minPivotIdx` (typically sweep reclaim).
 * @returns {number|null} price level
 */
export function nearestInternalLiquidityTarget(candles, idx, side, opts = {}, minPivotIdx = 0) {
  if (!candles?.length || idx < 0) return null;
  const entry = Number(candles[idx]?.close);
  if (!Number.isFinite(entry) || entry <= 0) return null;
  const lo = Math.max(0, Math.floor(minPivotIdx));
  const { highs, lows } = getConfirmedSwings(candles, idx, opts);

  if (side === "BUY" || side === "long") {
    const candidates = highs.filter((s) => s.pivotIdx >= lo && s.pivotIdx <= idx && s.price > entry);
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.price - b.price);
    return candidates[0].price;
  }
  const candidates = lows.filter((s) => s.pivotIdx >= lo && s.pivotIdx <= idx && s.price < entry);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.price - a.price);
  return candidates[0].price;
}

export function prevSwingLowBefore(candles, idx, opts = {}) {
  const { lows } = getConfirmedSwings(candles, idx, opts);
  if (lows.length < 2) return null;
  return lows[lows.length - 2];
}
