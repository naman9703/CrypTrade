/**
 * Order block — last opposing candle before displacement.
 */

/**
 * @param {object[]} candles
 * @param {number} idx
 * @param {'BUY'|'SELL'} side
 * @param {object} pre
 * @param {object} [opts]
 */
export function findOrderBlock(candles, idx, side, pre, opts = {}) {
  const lookback = Math.max(5, Number(opts.intradaySmcObLookback ?? 20));
  const atrMult = Number(opts.intradaySmcObMinDisplacementAtr ?? 1.2);
  const start = Math.max(0, idx - lookback);
  const atr = pre.atrSeries?.[idx] ?? 0;

  for (let j = idx; j >= start + 1; j--) {
    const b = candles[j];
    const body = Math.abs(b.close - b.open);
    if (!Number.isFinite(atr) || atr <= 0 || body < atr * atrMult) continue;

    const prev = candles[j - 1];
    if (side === "BUY" && prev.close < prev.open && b.close > b.open) {
      return {
        side: "BUY",
        top: prev.high,
        bottom: prev.low,
        obIdx: j - 1,
        displacementIdx: j,
      };
    }
    if (side === "SELL" && prev.close > prev.open && b.close < b.open) {
      return {
        side: "SELL",
        top: prev.high,
        bottom: prev.low,
        obIdx: j - 1,
        displacementIdx: j,
      };
    }
  }
  return null;
}

export function priceInObZone(candles, idx, ob, side, opts = {}) {
  if (!ob) return false;
  const b = candles[idx];
  const strict = opts.intradaySmcStrictPdZone !== false;
  if (side === "BUY") {
    if (!(b.low <= ob.top && b.close >= ob.bottom)) return false;
    if (!strict) return true;
    const mid = (ob.top + ob.bottom) / 2;
    return b.close >= mid;
  }
  if (!(b.high >= ob.bottom && b.close <= ob.top)) return false;
  if (!strict) return true;
  const mid = (ob.top + ob.bottom) / 2;
  return b.close <= mid;
}

/**
 * OB anchored at displacement (MSS bar or bar before).
 * @param {number} [minObIdx] reject OB before sweep reclaim
 */
export function findObFromDisplacement(candles, mssIdx, side, pre, opts = {}, minObIdx = 0) {
  const atrMult = Number(opts.intradaySmcObMinDisplacementAtr ?? 1.2);
  const atr = pre?.atrSeries?.[mssIdx] ?? 0;
  if (mssIdx < 1) return null;

  const tryPair = (obIdx, dispIdx) => {
    if (obIdx < minObIdx) return null;
    const b = candles[dispIdx];
    const body = Math.abs(b.close - b.open);
    if (Number.isFinite(atr) && atr > 0 && body < atr * atrMult) return null;
    const prev = candles[obIdx];
    if (side === "BUY" && prev.close < prev.open && b.close > b.open) {
      return { side: "BUY", top: prev.high, bottom: prev.low, obIdx, displacementIdx: dispIdx };
    }
    if (side === "SELL" && prev.close > prev.open && b.close < b.open) {
      return { side: "SELL", top: prev.high, bottom: prev.low, obIdx, displacementIdx: dispIdx };
    }
    return null;
  };

  if (mssIdx >= 1) {
    const ob = tryPair(mssIdx - 1, mssIdx);
    if (ob) return ob;
  }
  return tryPair(mssIdx, mssIdx);
}
