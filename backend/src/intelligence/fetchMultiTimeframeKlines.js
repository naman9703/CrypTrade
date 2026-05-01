/**
 * Public Binance USD-M klines for intelligence processors that need multiple intervals.
 * Bot WS feed only fills one timeframe; this fills 1m–1d so confluence / volatility can run.
 */
import axios from "axios";

const FAPI = String(process.env.BINANCE_INTELLIGENCE_FAPI_BASE || "https://fapi.binance.com").replace(/\/$/, "");

export const INTELLIGENCE_MTF_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"];

/** @type {Record<string, number>} */
const lastMtfFetchAt = {};
const DEFAULT_MT_TTL_MS = Math.max(30_000, Number(process.env.INTELLIGENCE_MTF_REFRESH_MS || 120_000));

function normalizeSym(symbol) {
  return String(symbol || "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

/**
 * Merge Binance USD-M candles into `cache.candles[symbol][interval]` for each interval.
 * Throttled per symbol to avoid hammering REST (default 120s).
 */
export async function refreshMultiTimeframeCandles(symbol, cache, ttlMs = DEFAULT_MT_TTL_MS) {
  const sym = normalizeSym(symbol);
  if (!sym || sym.length < 5) return;

  const now = Date.now();
  if (lastMtfFetchAt[sym] && now - lastMtfFetchAt[sym] < ttlMs) return;

  if (!cache.candles[sym]) cache.candles[sym] = {};

  await Promise.all(
    INTELLIGENCE_MTF_INTERVALS.map(async (interval) => {
      try {
        const { data } = await axios.get(`${FAPI}/fapi/v1/klines`, {
          params: { symbol: sym, interval, limit: 150 },
          timeout: 15_000,
          validateStatus: (s) => s === 200,
        });
        if (!Array.isArray(data) || data.length < 15) return;
        cache.candles[sym][interval] = data.map((k) => ({
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4]),
        }));
      } catch (err) {
        console.warn(`[intelligence] mtf ${sym} ${interval}:`, err?.message || err);
      }
    }),
  );

  lastMtfFetchAt[sym] = Date.now();
}
