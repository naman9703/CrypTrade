import { createCandleBuffer } from "./marketBuffer.js";
import { createBinanceMarketFeed } from "./marketFeedBinance.js";

/** Plausible mid prices for synthetic feed when switching symbols (not market data). */
function syntheticBasePrice(symbol) {
  const s = String(symbol || "BTCUSDT").toUpperCase();
  const table = {
    BTCUSDT: 97_000,
    ETHUSDT: 3400,
    BNBUSDT: 650,
    SOLUSDT: 180,
    XRPUSDT: 2.1,
    DOGEUSDT: 0.15,
    ADAUSDT: 0.45,
    AVAXUSDT: 35,
    DOTUSDT: 6,
    LINKUSDT: 15,
    TAOUSDT: 380,
    LTCUSDT: 95,
    BCHUSDT: 450,
  };
  if (table[s]) return table[s];
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return Math.max(0.01, (Math.abs(h) % 50_000) / 100);
}

// Feed factory. Default: SYNTH. Optional: BINANCE (spot) or BINANCE_FUTURES (USDT-M public fapi + fstream).
export function createMarketFeed({ log, symbol, timeframe, onCandleClose = null }) {
  const kind = String(process.env.MARKET_FEED || "SYNTH").toUpperCase();
  if (kind === "BINANCE") {
    return createBinanceMarketFeed({
      log,
      symbol,
      timeframe,
      variant: "spot",
      restBase: process.env.BINANCE_REST_BASE || "https://api.binance.com",
      wsBase: process.env.BINANCE_WS_BASE || "wss://stream.binance.com:9443/ws",
      onCandleClose,
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
      onCandleClose,
    });
  }

  if (kind !== "SYNTH") {
    log.warn("market_feed_unrecognized_using_synthetic", {
      envValue: process.env.MARKET_FEED,
      kind,
      hint: "Use MARKET_FEED=SYNTH, BINANCE, or BINANCE_FUTURES. If BINANCE_FUTURES is set but you still see SYNTH, redeploy so the backend includes futures feed support.",
    });
  }

  const buf = createCandleBuffer({ max: 500 });
  let lastClose = syntheticBasePrice(symbol);

  function seed() {
    if (buf.size() > 0) return;
    const now = Date.now();
    const scale = Math.max(1, lastClose * 0.0005);
    for (let i = 200; i > 0; i--) {
      const t = now - i * 60_000;
      const drift = (Math.random() - 0.5) * scale * 2;
      const close = Math.max(lastClose * 0.001, lastClose + drift);
      const high = close + Math.random() * scale * 1.2;
      const low = close - Math.random() * scale * 1.2;
      const open = lastClose;
      const volume = 20 + Math.random() * 10;
      buf.push({ ts: t, open, high, low, close, volume });
      lastClose = close;
    }
  }

  function step() {
    seed();
    const t = Date.now();
    const scale = Math.max(1, lastClose * 0.0008);
    const drift = (Math.random() - 0.5) * scale * 2.5;
    const close = Math.max(lastClose * 0.0001, lastClose + drift);
    const high = Math.max(close, lastClose) + Math.random() * scale;
    const low = Math.min(close, lastClose) - Math.random() * scale;
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
      lastClose = syntheticBasePrice(symbol);
      buf.clear();
      log.info("feed_symbol_set", { symbol, syntheticBase: lastClose });
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

