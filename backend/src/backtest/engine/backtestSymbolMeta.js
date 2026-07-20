/**
 * Cached USD-M tick size for backtest trailing SL rounding (live parity).
 */

import axios from "axios";

const cache = new Map();

function normalizeSymbol(symbol) {
  return String(symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function restBase() {
  const raw =
    process.env.BINANCE_LIVE_FUTURES_REST_BASE ||
    process.env.BINANCE_FUTURES_REST_BASE ||
    "https://fapi.binance.com";
  return String(raw).trim().replace(/\/+$/, "").replace(/\/fapi$/, "");
}

/**
 * @param {string} symbol
 * @param {number|null|undefined} [cfgTickSize] optional override from cfg.backtestTickSize
 * @returns {Promise<number|null>}
 */
export async function resolveBacktestTickSize(symbol, cfgTickSize) {
  const cfgVal = Number(cfgTickSize);
  if (Number.isFinite(cfgVal) && cfgVal > 0) return cfgVal;

  const sym = normalizeSymbol(symbol);
  if (!sym) return null;
  if (cache.has(sym)) return cache.get(sym);

  try {
    const { data } = await axios.get(`${restBase()}/fapi/v1/exchangeInfo`, { timeout: 12_000 });
    const info = Array.isArray(data?.symbols) ? data.symbols.find((s) => String(s.symbol) === sym) : null;
    const priceFilter = Array.isArray(info?.filters)
      ? info.filters.find((f) => f.filterType === "PRICE_FILTER")
      : null;
    const tick = Number(priceFilter?.tickSize);
    const out = Number.isFinite(tick) && tick > 0 ? tick : null;
    cache.set(sym, out);
    return out;
  } catch {
    cache.set(sym, null);
    return null;
  }
}

export function clearBacktestTickSizeCache() {
  cache.clear();
}
