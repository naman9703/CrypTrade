import { createCandleBuffer } from "./marketBuffer.js";
import { createBinanceMarketFeed } from "./marketFeedBinance.js";

// Feed factory. Default: SYNTH. Optional: BINANCE (spot) or BINANCE_FUTURES (USDT-M public fapi + fstream).
export function createMarketFeed({ log, symbol, timeframe }) {
  const kind = String(process.env.MARKET_FEED || "SYNTH").toUpperCase();
  if (kind === "BINANCE") {
    return createBinanceMarketFeed({
      log,
      symbol,
      timeframe,
      variant: "spot",
      restBase: process.env.BINANCE_REST_BASE || "https://api.binance.com",
      wsBase: process.env.BINANCE_WS_BASE || "wss://stream.binance.com:9443/ws",
    });
  }
  if (kind === "BINANCE_FUTURES") {
    return createBinanceMarketFeed({
      log,
      symbol,
      timeframe,
      variant: "futures",
      restBase: process.env.BINANCE_FUTURES_REST_BASE || "https://fapi.binance.com",
      wsBase: process.env.BINANCE_FUTURES_WS_BASE || "wss://fstream.binance.com/ws",
    });
  }

  const buf = createCandleBuffer({ max: 500 });
  let lastClose = 60_000;

  function seed() {
    if (buf.size() > 0) return;
    const now = Date.now();
    for (let i = 200; i > 0; i--) {
      const t = now - i * 60_000;
      const drift = (Math.random() - 0.5) * 50;
      const close = Math.max(100, lastClose + drift);
      const high = close + Math.random() * 30;
      const low = close - Math.random() * 30;
      const open = lastClose;
      const volume = 20 + Math.random() * 10;
      buf.push({ ts: t, open, high, low, close, volume });
      lastClose = close;
    }
  }

  function step() {
    seed();
    const t = Date.now();
    const drift = (Math.random() - 0.5) * 80;
    const close = Math.max(100, lastClose + drift);
    const high = Math.max(close, lastClose) + Math.random() * 20;
    const low = Math.min(close, lastClose) - Math.random() * 20;
    const open = lastClose;
    const volume = 20 + Math.random() * 25;
    buf.push({ ts: t, open, high, low, close, volume });
    lastClose = close;
  }

  // drive synthetic candles
  setInterval(() => {
    step();
  }, 1000);

  return {
    getStatus() {
      return { ok: true, source: "SYNTH", lastMsgAt: Date.now(), symbol, timeframe, buffer: buf.size() };
    },
    setSymbol(next) {
      symbol = next;
      log.info("feed_symbol_set", { symbol });
    },
    setTimeframe(next) {
      timeframe = next;
      log.info("feed_timeframe_set", { timeframe });
    },
    getCandles() {
      seed();
      return buf.toArray();
    },
  };
}

