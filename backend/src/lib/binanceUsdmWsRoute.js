/**
 * Binance USD-M WebSocket routing (see "Important WebSocket Change Notice"):
 * Unrouted `wss://fstream.binance.com/ws` only receives **Public** streams. Kline, aggTrade, and
 * markPrice are **Market** streams and must use `/market/ws` or `/market/stream`. Partial depth and
 * bookTicker are **Public** → `/public/ws` or `/public/stream`.
 *
 * @param {string} url
 * @param {"market" | "public"} route
 * @returns {string}
 */
export function routeBinanceUsdmWsBase(url, route) {
  const r = route === "public" ? "public" : "market";
  let s = String(url || "").trim();
  if (!s) return s;
  if (!/fstream\.binance\.com/i.test(s) && !/fstream\.binancefuture\.com/i.test(s)) return s;
  if (/\/(public|market|private)\b/i.test(s)) return s;
  s = s.replace(/\/$/, "");
  if (/\/stream$/i.test(s)) return s.replace(/\/stream$/i, `/${r}/stream`);
  if (/\/ws$/i.test(s)) return s.replace(/\/ws$/i, `/${r}/ws`);
  return s;
}

/**
 * @param {string} wsBase ending in `.../market/ws` or legacy `.../ws`
 * @returns {string} combined-stream base `.../market/stream`
 */
export function binanceUsdmMarketCombinedBaseFromWsBase(wsBase) {
  const b = String(wsBase || "").trim().replace(/\/$/, "");
  if (!b) return b;
  if (/\/market\/ws$/i.test(b)) return b.replace(/\/market\/ws$/i, "/market/stream");
  if (/\/public\/ws$/i.test(b)) return b.replace(/\/public\/ws$/i, "/public/stream");
  if (/\/ws$/i.test(b)) return b.replace(/\/ws$/i, "/stream");
  return b;
}
