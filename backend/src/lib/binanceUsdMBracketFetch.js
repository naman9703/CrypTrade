/**
 * Fetch Binance USD-M leverage brackets for position-cap simulation (paper / backtest).
 * Uses signed REST when API keys are available in env; otherwise returns null.
 */

import crypto from "crypto";
import axios from "axios";
import { notionalCapFromLeverageBrackets } from "./binanceUsdMPositionCap.js";
import { usdMFapiPublicBaseForTradingMode } from "./binanceUsdMBookTicker.js";

const bracketCache = new Map();
const BRACKET_CACHE_TTL_MS = 30 * 60 * 1000;

function pickCredentials(tradingMode) {
  const m = String(tradingMode || "").toUpperCase();
  if (m === "BINANCE_LIVE") {
    return {
      apiKey: process.env.BINANCE_LIVE_FUTURES_API_KEY || process.env.BINANCE_API_KEY || "",
      apiSecret: process.env.BINANCE_LIVE_FUTURES_API_SECRET || process.env.BINANCE_API_SECRET || "",
      base: process.env.BINANCE_LIVE_FUTURES_REST_BASE || "https://fapi.binance.com",
    };
  }
  if (m === "BINANCE_DEMO_API" || m === "BINANCE_DEMO_FUTURES") {
    return {
      apiKey: process.env.BINANCE_DEMO_FUTURES_API_KEY || process.env.BINANCE_DEMO_API_KEY || "",
      apiSecret: process.env.BINANCE_DEMO_FUTURES_API_SECRET || process.env.BINANCE_DEMO_API_SECRET || "",
      base: process.env.BINANCE_DEMO_FUTURES_REST_BASE || "https://demo-fapi.binance.com",
    };
  }
  if (m === "BINANCE_TESTNET") {
    return {
      apiKey: process.env.BINANCE_FUTURES_TESTNET_API_KEY || process.env.BINANCE_TESTNET_API_KEY || "",
      apiSecret: process.env.BINANCE_FUTURES_TESTNET_API_SECRET || process.env.BINANCE_TESTNET_API_SECRET || "",
      base: process.env.BINANCE_FUTURES_TESTNET_REST_BASE || "https://testnet.binancefuture.com",
    };
  }
  return {
    apiKey: process.env.BINANCE_DEMO_FUTURES_API_KEY || process.env.BINANCE_API_KEY || "",
    apiSecret: process.env.BINANCE_DEMO_FUTURES_API_SECRET || process.env.BINANCE_API_SECRET || "",
    base: usdMFapiPublicBaseForTradingMode("BINANCE_DEMO_API"),
  };
}

async function signedLeverageBracket(symbol, tradingMode) {
  const { apiKey, apiSecret, base } = pickCredentials(tradingMode);
  if (!apiKey || !apiSecret) return null;
  const sym = String(symbol || "").toUpperCase();
  const cacheKey = `${base}:${sym}`;
  const hit = bracketCache.get(cacheKey);
  if (hit && Date.now() - hit.at < BRACKET_CACHE_TTL_MS) return hit.brackets;

  const params = { symbol: sym, timestamp: Date.now() };
  const qs = new URLSearchParams(params).toString();
  const sig = crypto.createHmac("sha256", apiSecret).update(qs).digest("hex");
  const url = `${String(base).replace(/\/$/, "")}/fapi/v1/leverageBracket?${qs}&signature=${sig}`;
  try {
    const { data } = await axios.get(url, {
      headers: { "X-MBX-APIKEY": apiKey },
      timeout: 8000,
    });
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    const row = rows.find((r) => String(r?.symbol || "").toUpperCase() === sym) || rows[0];
    const brackets = Array.isArray(row?.brackets) ? row.brackets : [];
    bracketCache.set(cacheKey, { at: Date.now(), brackets });
    return brackets;
  } catch {
    return null;
  }
}

/**
 * @param {string} symbol
 * @param {number} leverage
 * @param {string} [tradingMode]
 * @returns {Promise<number | null>}
 */
export async function fetchLeverageBracketNotionalCap(symbol, leverage, tradingMode = "BINANCE_DEMO_API") {
  const envCap = Number(process.env.PAPER_FUTURES_BRACKET_CAP_USDT ?? process.env.BACKTEST_BRACKET_CAP_USDT ?? 0);
  if (envCap > 0) return envCap;
  const brackets = await signedLeverageBracket(symbol, tradingMode);
  if (!brackets?.length) return null;
  return notionalCapFromLeverageBrackets(brackets, leverage);
}
