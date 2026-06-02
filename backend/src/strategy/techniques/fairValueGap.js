/**
 * Fair value gaps (3-candle imbalance).
 */

/**
 * @param {object[]} candles
 * @param {number} idx center bar (gap completes here)
 * @param {'BUY'|'SELL'} side
 * @param {object} [opts]
 */
export function detectFvgAt(candles, idx, side, opts = {}) {
  if (idx < 2) return null;
  const c0 = candles[idx - 2];
  const c2 = candles[idx];
  if (!c0 || !c2) return null;

  const minGapPct = Number(opts.intradaySmcFvgMinGapPct ?? 0.0001);

  if (side === "BUY") {
    const top = c0.high;
    const bottom = c2.low;
    if (!(bottom > top)) return null;
    const mid = (top + bottom) / 2;
    const gapPct = (bottom - top) / mid;
    if (gapPct < minGapPct) return null;
    return {
      side: "BUY",
      top: bottom,
      bottom: top,
      mid,
      gapPct,
      formedIdx: idx,
      type: "bullish_fvg",
    };
  }

  const top = c2.high;
  const bottom = c0.low;
  if (!(top < bottom)) return null;
  const mid = (top + bottom) / 2;
  const gapPct = (bottom - top) / mid;
  if (Math.abs(gapPct) < minGapPct) return null;
  return {
    side: "SELL",
    top: bottom,
    bottom: top,
    mid,
    gapPct: Math.abs(gapPct),
    formedIdx: idx,
    type: "bearish_fvg",
  };
}

/**
 * Find most recent active FVG before/at idx (not fully mitigated).
 */
export function findActiveFvg(candles, idx, side, opts = {}) {
  const maxAge = Math.max(3, Number(opts.intradaySmcFvgMaxAgeBars ?? 24));
  const start = Math.max(2, idx - maxAge);
  let best = null;
  for (let i = idx; i >= start; i--) {
    const fvg = detectFvgAt(candles, i, side, opts);
    if (!fvg) continue;
    if (!isFvgMitigated(candles, fvg, idx, side)) {
      best = fvg;
      break;
    }
  }
  return best;
}

function isFvgMitigated(candles, fvg, idx, side) {
  for (let j = fvg.formedIdx + 1; j <= idx; j++) {
    const b = candles[j];
    if (side === "BUY" && b.low <= fvg.bottom) return true;
    if (side === "SELL" && b.high >= fvg.top) return true;
  }
  return false;
}

/**
 * ICT CE entry — bar touched FVG midpoint and closed on the trade side of CE.
 * Tighter than full-zone retrace; avoids OB-deep pullbacks.
 */
export function priceAtFvgMidpoint(candles, idx, fvg, side, opts = {}) {
  if (!fvg || idx < 0) return false;
  const b = candles[idx];
  if (!b) return false;
  const mid = Number(fvg.mid ?? (fvg.top + fvg.bottom) / 2);
  if (!Number.isFinite(mid)) return false;
  const tolPct = Number(opts.intradaySmcFvgMidTolPct ?? 0.0005);
  const tol = mid * tolPct;
  const touched = b.low - tol <= mid && mid <= b.high + tol;
  if (!touched) return false;
  if (side === "BUY") return b.close >= mid - tol;
  return b.close <= mid + tol;
}

/** Price retraced into FVG zone on bar idx. */
export function priceInFvgZone(candles, idx, fvg, side, opts = {}) {
  if (!fvg) return false;
  const b = candles[idx];
  const strict = opts.intradaySmcStrictPdZone !== false;
  if (side === "BUY") {
    if (!(b.low <= fvg.top && b.close >= fvg.bottom)) return false;
    if (!strict) return true;
    const mid = (fvg.top + fvg.bottom) / 2;
    return b.close >= mid;
  }
  if (!(b.high >= fvg.bottom && b.close <= fvg.top)) return false;
  if (!strict) return true;
  const mid = (fvg.top + fvg.bottom) / 2;
  return b.close <= mid;
}

/**
 * FVG from the displacement leg (MSS bar), not arbitrary recent gaps.
 * @param {number} [minFormedIdx] reject gaps formed before sweep reclaim
 */
export function findFvgFromDisplacement(candles, mssIdx, side, opts = {}, minFormedIdx = 0) {
  if (mssIdx < 2) return null;
  const minIdx = Math.max(2, minFormedIdx);
  for (let i = mssIdx; i >= Math.max(2, mssIdx - 2); i--) {
    if (i < minIdx) continue;
    const fvg = detectFvgAt(candles, i, side, opts);
    if (!fvg) continue;
    if (!isFvgMitigated(candles, fvg, mssIdx, side)) return fvg;
  }
  return null;
}
