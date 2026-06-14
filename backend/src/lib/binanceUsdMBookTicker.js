/**
 * Public USD-M best bid/ask (no API key). Used for Supertrend entry slippage / LIMIT-IOC caps.
 */
import axios from "axios";

/** @param {string} mode Trading mode (e.g. BINANCE_LIVE). */
export function usdMFapiPublicBaseForTradingMode(mode) {
  const m = String(mode || "").toUpperCase();
  if (m === "BINANCE_TESTNET") {
    return process.env.BINANCE_FUTURES_TESTNET_REST_BASE || "https://testnet.binancefuture.com";
  }
  if (m === "BINANCE_DEMO_API") {
    return process.env.BINANCE_DEMO_FUTURES_REST_BASE || "https://demo-fapi.binance.com";
  }
  return process.env.BINANCE_LIVE_FUTURES_REST_BASE || "https://fapi.binance.com";
}

/**
 * @returns {Promise<{ bidPrice: number, askPrice: number, symbol: string } | null>}
 */
export async function fetchUsdMBookTicker(symbol, tradingMode) {
  const sym = String(symbol || "").toUpperCase();
  if (!sym) return null;
  const base = usdMFapiPublicBaseForTradingMode(tradingMode).replace(/\/$/, "");
  const url = `${base}/fapi/v1/ticker/bookTicker`;
  try {
    const { data } = await axios.get(url, { params: { symbol: sym }, timeout: 6000 });
    const bid = Number(data?.bidPrice);
    const ask = Number(data?.askPrice);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
    return { bidPrice: bid, askPrice: ask, symbol: sym };
  } catch {
    return null;
  }
}

/**
 * USD-M mark price from premium index (public, no API key). Complements book bid/ask for entry drift checks.
 *
 * @returns {Promise<{ markPrice: number, symbol: string } | null>}
 */
export async function fetchUsdMPremiumMark(symbol, tradingMode) {
  const sym = String(symbol || "").toUpperCase();
  if (!sym) return null;
  const base = usdMFapiPublicBaseForTradingMode(tradingMode).replace(/\/$/, "");
  const url = `${base}/fapi/v1/premiumIndex`;
  try {
    const { data } = await axios.get(url, { params: { symbol: sym }, timeout: 6000 });
    const mp = Number(data?.markPrice);
    if (!Number.isFinite(mp) || mp <= 0) return null;
    return { markPrice: mp, symbol: sym };
  } catch {
    return null;
  }
}

/**
 * Official bar close from REST for the kline starting at `openTimeMs` (matches feed `candle.ts`).
 * Used to anchor entry slippage vs book/mark when the WS buffer lags on unrouted endpoints.
 *
 * @returns {Promise<number | null>} close price or null
 */
/**
 * Partial depth book for liquidity guards (public, no API key).
 * @returns {Promise<{ symbol: string, bids: Array<[number, number]>, asks: Array<[number, number]> } | null>}
 */
export async function fetchUsdMDepthBook(symbol, tradingMode, limit = 20) {
  const sym = String(symbol || "").toUpperCase();
  const lim = Math.max(5, Math.min(100, Math.floor(Number(limit) || 20)));
  if (!sym) return null;
  const base = usdMFapiPublicBaseForTradingMode(tradingMode).replace(/\/$/, "");
  const url = `${base}/fapi/v1/depth`;
  try {
    const { data } = await axios.get(url, { params: { symbol: sym, limit: lim }, timeout: 6000 });
    const toLv = (arr) =>
      (Array.isArray(arr) ? arr : [])
        .map((x) => [Number(x?.[0]), Number(x?.[1])])
        .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && p > 0 && q > 0);
    const bids = toLv(data?.bids);
    const asks = toLv(data?.asks);
    if (!bids.length && !asks.length) return null;
    return { symbol: sym, bids, asks };
  } catch {
    return null;
  }
}

/** Single-level book from book ticker (spread guard when full depth unavailable). */
export function depthBookFromTicker(ticker) {
  if (!ticker) return null;
  const bid = Number(ticker.bidPrice);
  const ask = Number(ticker.askPrice);
  const bidQty = Number(ticker.bidQty ?? ticker.bidQuantity ?? 0);
  const askQty = Number(ticker.askQty ?? ticker.askQuantity ?? 0);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  const bids = bidQty > 0 ? [[bid, bidQty]] : [[bid, 1]];
  const asks = askQty > 0 ? [[ask, askQty]] : [[ask, 1]];
  return { symbol: String(ticker.symbol || "").toUpperCase(), bids, asks };
}

export async function fetchUsdMKlineCloseAtOpenTime(symbol, interval, openTimeMs, tradingMode) {
  const sym = String(symbol || "").toUpperCase();
  const ot = Number(openTimeMs);
  const intv = String(interval || "1m").trim();
  if (!sym || !Number.isFinite(ot) || ot <= 0 || !intv) return null;
  const base = usdMFapiPublicBaseForTradingMode(tradingMode).replace(/\/$/, "");
  const url = `${base}/fapi/v1/klines`;
  try {
    const { data } = await axios.get(url, {
      params: { symbol: sym, interval: intv, startTime: ot, limit: 1 },
      timeout: 6000,
    });
    if (!Array.isArray(data) || !data.length) return null;
    const row = data[0];
    const openT = Number(row?.[0]);
    const close = Number(row?.[4]);
    if (!Number.isFinite(close) || close <= 0) return null;
    if (Number.isFinite(openT) && Math.abs(openT - ot) > 2) return null;
    return close;
  } catch {
    return null;
  }
}
