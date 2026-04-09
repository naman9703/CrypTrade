import axios from "axios";

/** @returns {Array<{ ts: number, open: number, high: number, low: number, close: number, volume: number }>} */
export async function fetchBinanceKlinesRows({ symbol, interval, limit = 120 }) {
  const mf = String(process.env.MARKET_FEED || "SYNTH").toUpperCase();
  if (mf !== "BINANCE" && mf !== "BINANCE_FUTURES") return [];
  const isFut = mf === "BINANCE_FUTURES";
  const base = isFut
    ? process.env.BINANCE_FUTURES_REST_BASE || "https://fapi.binance.com"
    : process.env.BINANCE_REST_BASE || "https://api.binance.com";
  const path = isFut ? "/fapi/v1/klines" : "/api/v3/klines";
  const sym = String(symbol || "").toUpperCase();
  const lim = Math.min(1000, Math.max(10, Number(limit) || 120));
  const { data } = await axios.get(`${base}${path}`, {
    params: { symbol: sym, interval: String(interval || "1m"), limit: lim },
    timeout: 12_000,
  });
  if (!Array.isArray(data)) return [];
  return data.map((k) => ({
    ts: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}
