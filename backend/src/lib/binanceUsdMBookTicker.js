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
