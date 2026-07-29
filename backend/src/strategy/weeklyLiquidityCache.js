/**
 * Previous completed UTC-week high/low from Binance 1w klines.
 * Timeframe-independent — works for 1m/5m/15m intraday without holding weeks of micro bars.
 */
import { fetchBinanceKlinesRows } from "../lib/binanceKlinesRest.js";

/** @type {Record<string, { high: number, low: number, weekTs: number, fetchedAt: number, source: string }>} */
const cache = {};

const TTL_MS = 60 * 60_000;

export function getCachedWeeklyLiquidity(symbol) {
  const sym = String(symbol || "")
    .trim()
    .toUpperCase();
  if (!sym) return null;
  const row = cache[sym];
  if (!row) return null;
  if (Date.now() - row.fetchedAt > TTL_MS) return null;
  return row;
}

/**
 * Fetch last completed weekly candle H/L (Binance 1w; penultimate row = prev closed week).
 * @param {string} symbol
 * @param {string} [feedKind]
 */
export async function ensureWeeklyLiquidityForSymbol(symbol, feedKind) {
  const sym = String(symbol || "")
    .trim()
    .toUpperCase();
  if (!sym) return null;

  const hit = getCachedWeeklyLiquidity(sym);
  if (hit) return hit;

  try {
    const rows = await fetchBinanceKlinesRows({
      symbol: sym,
      interval: "1w",
      limit: 3,
      feedKind,
      chartPublic: true,
    });
    if (!Array.isArray(rows) || rows.length < 2) return null;

    const prev = rows[rows.length - 2];
    const high = Number(prev?.high);
    const low = Number(prev?.low);
    if (!(high > 0 && low > 0)) return null;

    cache[sym] = {
      high,
      low,
      weekTs: Number(prev?.ts) || 0,
      fetchedAt: Date.now(),
      source: "binance_1w",
    };
    return cache[sym];
  } catch {
    return null;
  }
}
