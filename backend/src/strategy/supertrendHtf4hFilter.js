/**
 * Supertrend 4H Timeframe Confirmation Filter.
 *
 * When enabled, any Supertrend signal on the primary TF (e.g. 15m) is blocked
 * unless the 4H Supertrend direction agrees:
 *   - BUY signal → 4H ST must be bullish (+1)
 *   - SELL signal → 4H ST must be bearish (−1)
 *
 * The 4H series is built by aggregating primary-TF candles into 4H bars using
 * real timestamps (aligned to calendar hours), matching the same approach used
 * by trendHtfSt.js for its hourly aggregation. This is look-ahead-free: at bar
 * index i we only see the 4H bar whose open ≤ bar.ts.
 *
 * Config keys (all optional, safe defaults applied):
 *   supertrendHtf4hEnabled       boolean  — master toggle
 *   supertrendHtf4hPeriod        number   — ST period for 4H series (default 10)
 *   supertrendHtf4hMultiplier    number   — ST multiplier for 4H series (default 3)
 */

import { computeSupertrendSeries } from "./supertrend.js";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

/**
 * Aggregate primary-TF candles into 4-hour bars using real timestamps.
 * A 4H bucket is the floor(ts / 4h) * 4h.
 */
export function aggregateTo4h(candles) {
  if (!Array.isArray(candles) || !candles.length) return [];
  const out = [];
  let cur = null;
  for (const c of candles) {
    const bucketTs = Math.floor(c.ts / FOUR_HOURS_MS) * FOUR_HOURS_MS;
    if (!cur || cur.ts !== bucketTs) {
      if (cur) out.push(cur);
      cur = {
        ts: bucketTs,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: Number(c.volume) || 0,
      };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += Number(c.volume) || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Precompute the 4H Supertrend trend (+1 = bullish, -1 = bearish) series
 * from primary-TF candles. Returns a structure used by evaluate().
 *
 * @param {Array} candles  Primary TF candle array.
 * @param {{ period?: number, multiplier?: number }} opts
 * @returns {{ htf4hCandles: Array, htf4hTrend: Array<1|-1|0>, opts }}
 */
export function buildHtf4hContext(candles, opts = {}) {
  const period = Math.max(2, Math.round(Number(opts.period ?? 10)));
  const multiplier = Math.max(0.5, Number(opts.multiplier ?? 3));

  const htf4hCandles = aggregateTo4h(candles);
  const stSeries = computeSupertrendSeries(htf4hCandles, {
    period,
    multiplier,
    wilderAtr: true,
  });

  // Derive +1/−1 trend from Supertrend series using the same convention as the
  // primary series: if price > ST line → bullish (+1), else bearish (−1).
  const htf4hTrend = stSeries.map((s, i) => {
    if (!s || !htf4hCandles[i]) return 0;
    const close = Number(htf4hCandles[i].close);
    const line = Number(s.line ?? s.lower ?? s.upper ?? 0);
    if (!Number.isFinite(close) || !Number.isFinite(line) || line === 0) return 0;
    return close > line ? 1 : -1;
  });

  return { htf4hCandles, htf4hTrend, opts: { period, multiplier } };
}

/**
 * Find the 4H bar index whose timestamp is <= barTs (most recent completed 4H bar).
 * Binary search for O(log n).
 */
function find4hIdx(htf4hCandles, barTs) {
  let lo = 0;
  let hi = htf4hCandles.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (htf4hCandles[mid].ts <= barTs) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/**
 * Evaluate the 4H confirmation filter for a given primary bar.
 *
 * @param {object} ctx  Result from buildHtf4hContext().
 * @param {{ ts: number }} bar  Primary-TF bar being evaluated.
 * @param {"BUY"|"SELL"} side  Proposed entry side.
 * @returns {{ pass: boolean, reason: string, htf4hTrend: 1|-1|0 }}
 */
export function evaluateHtf4hFilter(ctx, bar, side) {
  if (!ctx || !bar) return { pass: false, reason: "no_context", htf4hTrend: 0 };

  const hi4 = find4hIdx(ctx.htf4hCandles, bar.ts);
  if (hi4 < 0) return { pass: false, reason: "htf_warmup", htf4hTrend: 0 };

  const trend = ctx.htf4hTrend[hi4];
  if (trend === 0) return { pass: false, reason: "htf_warmup", htf4hTrend: 0 };

  if (side === "BUY" && trend !== 1) {
    return { pass: false, reason: "htf4h_bearish_on_long", htf4hTrend: trend };
  }
  if (side === "SELL" && trend !== -1) {
    return { pass: false, reason: "htf4h_bullish_on_short", htf4hTrend: trend };
  }

  return { pass: true, reason: "pass", htf4hTrend: trend };
}

/**
 * Read 4H filter cfg from raw config. Returns null when disabled.
 */
export function readHtf4hFilterCfg(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  if (c.supertrendHtf4hEnabled !== true) return null;
  return {
    period: Math.max(2, Math.round(Number(c.supertrendHtf4hPeriod ?? 10))),
    multiplier: Math.max(0.5, Number(c.supertrendHtf4hMultiplier ?? 3)),
  };
}
