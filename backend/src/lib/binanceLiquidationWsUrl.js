/**
 * Binance USD-M forceOrder (`!forceOrder@arr`) WebSocket URL.
 * forceOrder is a **Market** stream — must use `/market/ws`, not legacy `/ws` or `/public/ws`.
 * @see https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Important-WebSocket-Change-Notice
 */
import { routeBinanceUsdmWsBase } from "./binanceUsdmWsRoute.js";

/**
 * @param {string} [tradingMode] PAPER | BINANCE_LIVE | BINANCE_DEMO_API | BINANCE_TESTNET
 * @returns {string}
 */
export function resolveBinanceForceOrderStreamUrl(tradingMode = "PAPER") {
  const override = String(process.env.BINANCE_FUTURES_LIQUIDATIONS_WS_URL || "").trim();
  if (override) return override;

  const tm = String(tradingMode || "PAPER").toUpperCase();
  const demo = tm === "BINANCE_DEMO_API" || tm === "BINANCE_TESTNET";

  let wsBase = demo
    ? String(
        process.env.BINANCE_FUTURES_TESTNET_WS_BASE ||
          process.env.BINANCE_DEMO_FUTURES_WS_BASE ||
          "wss://fstream.binancefuture.com/market/ws",
      ).trim()
    : String(
        process.env.BINANCE_FUTURES_WS_BASE ||
          process.env.BINANCE_LIVE_FUTURES_WS_BASE ||
          "wss://fstream.binance.com/market/ws",
      ).trim();

  wsBase = routeBinanceUsdmWsBase(wsBase, "market");
  wsBase = wsBase.replace(/\/$/, "");
  if (!/\/ws$/i.test(wsBase)) {
    wsBase = wsBase.replace(/\/stream$/i, "/ws");
    if (!/\/ws$/i.test(wsBase)) wsBase = `${wsBase}/ws`;
  }
  return `${wsBase}/!forceOrder@arr`;
}
