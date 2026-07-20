import axios from "axios";
import { tfToMs } from "../backtest/data/timeframe.js";

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

function normalizeRestRoot(url, fallback) {
  let s = String(url || fallback || "").trim().replace(/\/+$/, "");
  if (s.endsWith("/api")) s = s.slice(0, -4);
  if (s.endsWith("/fapi")) s = s.slice(0, -5);
  return s || fallback;
}

/** Public chart OHLC: mainnet first (read-only), then configured/demo bases. */
function chartKlineRestCandidates(feedKind) {
  const isFut = String(feedKind || "").toUpperCase() === "BINANCE_FUTURES";
  const futBases = [
    process.env.BINANCE_LIVE_FUTURES_REST_BASE,
    process.env.BINANCE_FUTURES_REST_BASE,
    "https://fapi.binance.com",
    process.env.BINANCE_DEMO_FUTURES_REST_BASE,
    process.env.BINANCE_FUTURES_TESTNET_REST_BASE,
  ]
    .map((u) => normalizeRestRoot(u, ""))
    .filter(Boolean);
  const spotBases = [
    process.env.BINANCE_LIVE_REST_BASE,
    process.env.BINANCE_REST_BASE,
    "https://api.binance.com",
    process.env.BINANCE_DEMO_REST_BASE,
    process.env.BINANCE_TESTNET_REST_BASE,
  ]
    .map((u) => normalizeRestRoot(u, ""))
    .filter(Boolean);
  const ordered = isFut ? [...futBases, ...spotBases] : [...spotBases, ...futBases];
  return [...new Set(ordered)];
}

async function fetchKlinesFromBases(bases, path, params, timeoutMs) {
  let lastErr = null;
  for (const base of bases) {
    try {
      const { data } = await axios.get(`${base}${path}`, {
        params,
        timeout: timeoutMs,
      });
      if (Array.isArray(data) && data.length) return data.map(mapKlineRow);
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

/** @returns {Array<{ ts: number, open: number, high: number, low: number, close: number, volume: number }>} */
export async function fetchBinanceKlinesRows({
  symbol,
  interval,
  limit = 120,
  feedKind,
  /** UI chart tiles: try multiple public REST hosts (demo trading API can be slow). */
  chartPublic = false,
} = {}) {
  const sym = String(symbol || "").toUpperCase();
  const lim = Math.min(1000, Math.max(10, Number(limit) || 120));
  const params = { symbol: sym, interval: String(interval || "1m"), limit: lim };

  if (chartPublic) {
    const bases = chartKlineRestCandidates(feedKind);
    const timeoutMs = Math.max(4000, Math.min(12_000, Number(process.env.CHART_KLINES_TIMEOUT_MS ?? 8000)));
    const isFuturesRest = (base) =>
      /fapi|binancefuture/i.test(String(base || ""));
    for (const base of bases) {
      const path = isFuturesRest(base) ? "/fapi/v1/klines" : "/api/v3/klines";
      try {
        const rows = await fetchKlinesFromBases([base], path, params, timeoutMs);
        if (rows.length) return rows;
      } catch {
        /* try next host */
      }
    }
    return [];
  }

  const h = binanceKlinesHttp(feedKind);
  if (!h) return [];
  try {
    const { data } = await axios.get(`${h.base}${h.path}`, {
      params,
      timeout: 12_000,
    });
    if (!Array.isArray(data)) return [];
    return data.map(mapKlineRow);
  } catch {
    return [];
  }
}

function rowCapForRange(start, end, stepMs, maxRows) {
  if (maxRows != null && Number.isFinite(Number(maxRows))) return Number(maxRows);
  return Math.max(1, Math.ceil((end - start) / stepMs) + 2);
}

/**
 * Paginated klines between startTime and endTime (both ms, Binance semantics).
 * Used to resolve signal-list verdicts over long histories.
 */
export async function fetchBinanceKlinesRange({ symbol, interval, startTime, endTime, maxRows, feedKind } = {}) {
  const h = binanceKlinesHttp(feedKind);
  if (!h) return [];
  const sym = String(symbol || "").toUpperCase();
  const intv = String(interval || "1m");
  const stepMs = tfToMs(intv);
  const start = Math.max(0, Number(startTime) || 0);
  const end = Math.max(start, Number(endTime) || 0);
  const page = 1000;
  const rowCap = rowCapForRange(start, end, stepMs, maxRows);
  const pageGuard = Math.max(200, Math.ceil(rowCap / page) + 10);
  const byTs = new Map();
  let cur = start;
  let guard = 0;
  while (cur <= end && byTs.size < rowCap && guard < pageGuard) {
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
