/**
 * Binance USD-M mark-price klines (public REST).
 * Used for live-parity trailing replay in backtests.
 */

import axios from "axios";
import { tfToMs } from "../backtest/data/timeframe.js";

function normalizeRestRoot(url, fallback) {
  let s = String(url || fallback || "").trim().replace(/\/+$/, "");
  if (s.endsWith("/api")) s = s.slice(0, -4);
  if (s.endsWith("/fapi")) s = s.slice(0, -5);
  return s || fallback;
}

function futuresRestBases() {
  return [
    process.env.BINANCE_LIVE_FUTURES_REST_BASE,
    process.env.BINANCE_FUTURES_REST_BASE,
    "https://fapi.binance.com",
    process.env.BINANCE_DEMO_FUTURES_REST_BASE,
    process.env.BINANCE_FUTURES_TESTNET_REST_BASE,
  ]
    .map((u) => normalizeRestRoot(u, ""))
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);
}

function mapMarkKlineRow(k) {
  return {
    ts: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: 0,
  };
}

function rowCapForRange(start, end, stepMs, maxRows) {
  if (maxRows != null && Number.isFinite(Number(maxRows))) return Number(maxRows);
  return Math.max(1, Math.ceil((end - start) / stepMs) + 2);
}

/**
 * Paginated mark-price klines between startTime and endTime (ms).
 * @returns {Array<{ ts:number, open:number, high:number, low:number, close:number, volume:number }>}
 */
export async function fetchBinanceMarkPriceKlinesRange({
  symbol,
  interval = "1m",
  startTime,
  endTime,
  maxRows,
} = {}) {
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
  const bases = futuresRestBases();
  let lastErr = null;

  while (cur <= end && byTs.size < rowCap && guard < pageGuard) {
    guard += 1;
    const params = {
      symbol: sym,
      interval: intv,
      startTime: Math.floor(cur),
      endTime: Math.floor(end),
      limit: page,
    };
    let pageRows = null;
    for (const base of bases) {
      try {
        const { data } = await axios.get(`${base}/fapi/v1/markPriceKlines`, {
          params,
          timeout: 20_000,
        });
        if (Array.isArray(data) && data.length) {
          pageRows = data;
          break;
        }
      } catch (e) {
        lastErr = e;
      }
    }
    if (!pageRows?.length) {
      if (lastErr && guard === 1) throw lastErr;
      break;
    }
    for (const row of pageRows) {
      const k = mapMarkKlineRow(row);
      byTs.set(k.ts, k);
    }
    const lastOpen = Number(pageRows[pageRows.length - 1][0]);
    if (!Number.isFinite(lastOpen)) break;
    if (pageRows.length < page) break;
    cur = lastOpen + 1;
    if (lastOpen >= end) break;
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}
