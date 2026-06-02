/**
 * Market-structure BOS and CHoCH from confirmed swings (no repaint).
 */

import { getConfirmedSwings, lastSwingHighBefore, lastSwingLowBefore } from "./marketStructure.js";
import { getTrendStructureAt } from "./trendStructure.js";
import { passesDisplacementAt } from "./displacement.js";

/**
 * Bullish BOS: close breaks above last confirmed swing high.
 * Bearish BOS: close breaks below last confirmed swing low.
 * @param {object[]} candles
 * @param {number} idx
 * @param {'BUY'|'SELL'} side
 * @param {object} [opts]
 */
export function detectMarketBos(candles, idx, side, opts = {}) {
  if (idx < 0 || idx >= candles.length) {
    return { ok: false, bosIdx: -1, bosLevel: 0, type: null };
  }
  const bar = candles[idx];
  const close = Number(bar.close);
  if (!Number.isFinite(close)) {
    return { ok: false, bosIdx: -1, bosLevel: 0, type: null };
  }

  if (side === "BUY") {
    const sh = lastSwingHighBefore(candles, idx - 1, opts);
    if (!sh || !Number.isFinite(sh.price)) {
      return { ok: false, bosIdx: -1, bosLevel: 0, type: null };
    }
    if (close > sh.price) {
      return { ok: true, bosIdx: idx, bosLevel: sh.price, type: "bullish_bos", swingPivot: sh.pivotIdx };
    }
  } else {
    const sl = lastSwingLowBefore(candles, idx - 1, opts);
    if (!sl || !Number.isFinite(sl.price)) {
      return { ok: false, bosIdx: -1, bosLevel: 0, type: null };
    }
    if (close < sl.price) {
      return { ok: true, bosIdx: idx, bosLevel: sl.price, type: "bearish_bos", swingPivot: sl.pivotIdx };
    }
  }

  return { ok: false, bosIdx: -1, bosLevel: 0, type: null };
}

/**
 * CHoCH: structure was trending one way, then close breaks key internal level.
 * Bearish CHoCH (after bullish structure): close < last HL (last confirmed swing low).
 * Bullish CHoCH (after bearish structure): close > last LH (last confirmed swing high).
 */
export function detectMarketChoch(candles, idx, side, opts = {}) {
  if (idx < 0 || idx >= candles.length) {
    return { ok: false, chochIdx: -1, chochLevel: 0, type: null };
  }
  const trend = getTrendStructureAt(candles, idx - 1, opts);
  const bar = candles[idx];
  const close = Number(bar.close);
  if (!Number.isFinite(close)) {
    return { ok: false, chochIdx: -1, chochLevel: 0, type: null };
  }

  const { lows, highs } = getConfirmedSwings(candles, idx - 1, opts);

  if (side === "SELL") {
    if (trend.state !== "BULLISH" && opts.intradaySmcChochRequireTrend !== false) {
      return { ok: false, chochIdx: -1, chochLevel: 0, type: null, reason: "not_bullish_prior" };
    }
    const hl = lows.length ? lows[lows.length - 1].price : trend.lastLow;
    if (!Number.isFinite(hl)) {
      return { ok: false, chochIdx: -1, chochLevel: 0, type: null };
    }
    if (close < hl) {
      return { ok: true, chochIdx: idx, chochLevel: hl, type: "bearish_choch" };
    }
  } else {
    if (trend.state !== "BEARISH" && opts.intradaySmcChochRequireTrend !== false) {
      return { ok: false, chochIdx: -1, chochLevel: 0, type: null, reason: "not_bearish_prior" };
    }
    const lh = highs.length ? highs[highs.length - 1].price : trend.lastHigh;
    if (!Number.isFinite(lh)) {
      return { ok: false, chochIdx: -1, chochLevel: 0, type: null };
    }
    if (close > lh) {
      return { ok: true, chochIdx: idx, chochLevel: lh, type: "bullish_choch" };
    }
  }

  return { ok: false, chochIdx: -1, chochLevel: 0, type: null };
}

/**
 * BOS within N bars after a reference index (e.g. after CHoCH or sweep reclaim).
 */
export function detectBosAfterBar(candles, fromIdx, side, opts = {}) {
  const maxBars = Math.max(1, Number(opts.intradaySmcBosMaxBars ?? 5));
  const end = Math.min(candles.length - 1, fromIdx + maxBars);
  for (let j = fromIdx; j <= end; j++) {
    const r = detectMarketBos(candles, j, side, opts);
    if (r.ok) return r;
  }
  return { ok: false, bosIdx: -1, bosLevel: 0, type: null };
}

/**
 * CHoCH within N bars after sweep reclaim index.
 */
export function detectChochAfterBar(candles, fromIdx, side, opts = {}) {
  const maxBars = Math.max(1, Number(opts.intradaySmcChochMaxBars ?? 8));
  const end = Math.min(candles.length - 1, fromIdx + maxBars);
  for (let j = fromIdx; j <= end; j++) {
    const r = detectMarketChoch(candles, j, side, opts);
    if (r.ok) return r;
  }
  return { ok: false, chochIdx: -1, chochLevel: 0, type: null };
}

/**
 * Market Structure Shift (MSS): a *displacement* candle that breaks confirmed
 * structure in the trade direction, occurring within the closed window
 * `[fromIdx, toIdx]`. Searches backward (most recent first) and never reads bars
 * after `toIdx`, so callers evaluating at the entry bar incur no lookahead.
 *
 * @param {object[]} candles
 * @param {number} fromIdx earliest bar to consider (e.g. the sweep reclaim)
 * @param {number} toIdx latest bar to consider (e.g. the current/entry bar)
 * @param {'BUY'|'SELL'} side
 * @param {object} [opts]
 * @param {object} [pre] precomputeIntraday (for ATR-aware displacement)
 */
/**
 * Most recent CHoCH in [fromIdx, toIdx] (backward search, no lookahead past toIdx).
 */
export function detectChochInRange(candles, fromIdx, toIdx, side, opts = {}) {
  const lo = Math.max(0, Math.floor(fromIdx));
  const hi = Math.min(candles.length - 1, Math.floor(toIdx));
  const preferFirst = opts.intradaySmcPreferFirstStructure !== false;
  if (preferFirst) {
    for (let m = lo; m <= hi; m++) {
      const r = detectMarketChoch(candles, m, side, opts);
      if (r.ok) {
        return { ok: true, chochIdx: m, chochLevel: r.chochLevel, type: r.type };
      }
    }
    return { ok: false, chochIdx: -1, chochLevel: 0, type: null };
  }
  for (let m = hi; m >= lo; m--) {
    const r = detectMarketChoch(candles, m, side, opts);
    if (r.ok) {
      return { ok: true, chochIdx: m, chochLevel: r.chochLevel, type: r.type };
    }
  }
  return { ok: false, chochIdx: -1, chochLevel: 0, type: null };
}

/**
 * Most recent BOS in [fromIdx, toIdx] (backward search).
 */
export function detectBosInRange(candles, fromIdx, toIdx, side, opts = {}) {
  const lo = Math.max(0, Math.floor(fromIdx));
  const hi = Math.min(candles.length - 1, Math.floor(toIdx));
  for (let m = hi; m >= lo; m--) {
    const r = detectMarketBos(candles, m, side, opts);
    if (r.ok) {
      return {
        ok: true,
        bosIdx: m,
        bosLevel: r.bosLevel,
        type: r.type,
        swingPivot: r.swingPivot,
      };
    }
  }
  return { ok: false, bosIdx: -1, bosLevel: 0, type: null };
}

export function detectMssInRange(candles, fromIdx, toIdx, side, opts = {}, pre = null) {
  const lo = Math.max(1, Math.floor(fromIdx));
  const hi = Math.min(candles.length - 1, Math.floor(toIdx));
  const requireDisplacement = opts.intradaySmcMssRequireDisplacement !== false;
  const preferFirst = opts.intradaySmcPreferFirstStructure !== false;

  const tryBar = (m) => {
    const bos = detectMarketBos(candles, m, side, opts);
    if (!bos.ok) return null;
    if (requireDisplacement && !passesDisplacementAt(candles, m, side, opts, pre)) return null;
    return {
      ok: true,
      mssIdx: m,
      mssLevel: bos.bosLevel,
      type: side === "BUY" ? "bullish_mss" : "bearish_mss",
      swingPivot: bos.swingPivot,
    };
  };

  if (preferFirst) {
    for (let m = lo; m <= hi; m++) {
      const hit = tryBar(m);
      if (hit) return hit;
    }
    return { ok: false, mssIdx: -1, mssLevel: 0, type: null };
  }

  for (let m = hi; m >= lo; m--) {
    const hit = tryBar(m);
    if (hit) return hit;
  }
  return { ok: false, mssIdx: -1, mssLevel: 0, type: null };
}
