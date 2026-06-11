import axios from "axios";

function binanceKlinesHttp(feedKindOverride) {
  const mf = String(
    feedKindOverride != null && String(feedKindOverride).trim()
      ? feedKindOverride
      : process.env.MARKET_FEED || "SYNTH",
  ).toUpperCase();
  if (mf !== "BINANCE" && mf !== "BINANCE_FUTURES") return null;
  const isFut = mf === "BINANCE_FUTURES";
  const base = isFut
    ? process.env.BINANCE_FUTURES_REST_BASE || "https://fapi.binance.com"
    : process.env.BINANCE_REST_BASE || "https://api.binance.com";
  const path = isFut ? "/fapi/v1/klines" : "/api/v3/klines";
  return { base, path };
}

function mapKlineRow(k) {
  return {
    ts: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    taker_buy_volume: Number(k[9]) || 0,
  };
}

/** @returns {Array<{ ts: number, open: number, high: number, low: number, close: number, volume: number }>} */
export async function fetchBinanceKlinesRows({ symbol, interval, limit = 120, feedKind } = {}) {
  const h = binanceKlinesHttp(feedKind);
  if (!h) return [];
  const sym = String(symbol || "").toUpperCase();
  const lim = Math.min(1000, Math.max(10, Number(limit) || 120));
  const { data } = await axios.get(`${h.base}${h.path}`, {
    params: { symbol: sym, interval: String(interval || "1m"), limit: lim },
    timeout: 12_000,
  });
  if (!Array.isArray(data)) return [];
  return data.map(mapKlineRow);
}

/**
 * Paginated klines between startTime and endTime (both ms, Binance semantics).
 * Used to resolve signal-list verdicts over long histories.
 */
export async function fetchBinanceKlinesRange({ symbol, interval, startTime, endTime, maxRows = 50_000, feedKind } = {}) {
  const h = binanceKlinesHttp(feedKind);
  if (!h) return [];
  const sym = String(symbol || "").toUpperCase();
  const intv = String(interval || "1m");
  const start = Math.max(0, Number(startTime) || 0);
  const end = Math.max(start, Number(endTime) || 0);
  const page = 1000;
  const byTs = new Map();
  let cur = start;
  let guard = 0;
  while (cur <= end && byTs.size < maxRows && guard < 200) {
    guard += 1;
    const { data } = await axios.get(`${h.base}${h.path}`, {
      params: {
        symbol: sym,
        interval: intv,
        startTime: Math.floor(cur),
        endTime: Math.floor(end),
        limit: page,
      },
      timeout: 20_000,
    });
    if (!Array.isArray(data) || data.length === 0) break;
    for (const row of data) {
      const k = mapKlineRow(row);
      byTs.set(k.ts, k);
    }
    const lastOpen = Number(data[data.length - 1][0]);
    if (!Number.isFinite(lastOpen)) break;
    if (data.length < page) break;
    cur = lastOpen + 1;
    if (lastOpen >= end) break;
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}
