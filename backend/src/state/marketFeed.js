import { routeBinanceUsdmWsBase } from "../lib/binanceUsdmWsRoute.js";
import { createCandleBuffer } from "./marketBuffer.js";
import { createBinanceCombinedMarketFeed } from "./marketFeedBinanceCombined.js";

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

/**
 * Strip trailing `/api` so `GET /api/v3/klines` joins correctly when env uses a `.../api` REST root.
 */
function normalizeBinanceSpotKlineRestRoot(raw, fallbackHost) {
  let s = String(raw || "").trim();
  if (!s) s = fallbackHost;
  s = s.replace(/\/$/, "");
  if (s.endsWith("/api")) s = s.slice(0, -4);
  return s || fallbackHost;
}

function resolveSpotRestBaseForFeed(tradingMode) {
  const tm = String(tradingMode || "").toUpperCase();
  if (tm === "BINANCE_DEMO_API") {
    return normalizeBinanceSpotKlineRestRoot(
      process.env.BINANCE_DEMO_SPOT_KLINE_REST_BASE || process.env.BINANCE_DEMO_REST_BASE,
      "https://demo-api.binance.com",
    );
  }
  if (tm === "BINANCE_LIVE") {
    return normalizeBinanceSpotKlineRestRoot(
      process.env.BINANCE_LIVE_SPOT_KLINE_REST_BASE || process.env.BINANCE_LIVE_REST_BASE,
      "https://api.binance.com",
    );
  }
  if (tm === "BINANCE_TESTNET") {
    return normalizeBinanceSpotKlineRestRoot(process.env.BINANCE_TESTNET_REST_BASE, "https://testnet.binance.vision");
  }
  return normalizeBinanceSpotKlineRestRoot(process.env.BINANCE_REST_BASE, "https://api.binance.com");
}

function resolveSpotWsBaseForFeed(tradingMode) {
  const tm = String(tradingMode || "").toUpperCase();
  if (tm === "BINANCE_DEMO_API") {
    return process.env.BINANCE_DEMO_WS_BASE || "wss://demo-stream.binance.com/ws";
  }
  if (tm === "BINANCE_LIVE") {
    return process.env.BINANCE_LIVE_WS_BASE || process.env.BINANCE_WS_BASE || "wss://stream.binance.com:9443/ws";
  }
  if (tm === "BINANCE_TESTNET") {
    return process.env.BINANCE_TESTNET_WS_BASE || "wss://testnet.binance.vision/ws";
  }
  return process.env.BINANCE_WS_BASE || "wss://stream.binance.com:9443/ws";
}

function resolveSpotCombinedBaseForFeed(tradingMode) {
  const tm = String(tradingMode || "").toUpperCase();
  if (tm === "BINANCE_DEMO_API") {
    return process.env.BINANCE_DEMO_COMBINED_BASE || "wss://demo-stream.binance.com/stream";
  }
  if (tm === "BINANCE_LIVE") {
    return (
      process.env.BINANCE_LIVE_COMBINED_BASE ||
      process.env.BINANCE_COMBINED_BASE ||
      "wss://stream.binance.com:9443/stream"
    );
  }
  if (tm === "BINANCE_TESTNET") {
    return process.env.BINANCE_TESTNET_COMBINED_BASE || "wss://testnet.binance.vision/stream";
  }
  return process.env.BINANCE_COMBINED_BASE || "wss://stream.binance.com:9443/stream";
}

/**
 * Strip trailing `/fapi` so `GET /fapi/v1/klines` joins correctly when env uses `https://fapi.binance.com/fapi`.
 * @see https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data
 */
function normalizeFuturesKlineRestRoot(raw, fallbackHost) {
  let s = String(raw || "").trim();
  if (!s) s = fallbackHost;
  s = s.replace(/\/$/, "");
  if (s.endsWith("/fapi")) s = s.slice(0, -5);
  return s || fallbackHost;
}

function resolveFuturesRestBaseForFeed(tradingMode) {
  const tm = String(tradingMode || "").toUpperCase();
  if (tm === "BINANCE_DEMO_API") {
    return normalizeFuturesKlineRestRoot(
      process.env.BINANCE_DEMO_FUTURES_REST_BASE,
      "https://demo-fapi.binance.com",
    );
  }
  if (tm === "BINANCE_TESTNET") {
    return normalizeFuturesKlineRestRoot(
      process.env.BINANCE_FUTURES_TESTNET_REST_BASE,
      "https://testnet.binancefuture.com",
    );
  }
  if (tm === "BINANCE_LIVE") {
    return normalizeFuturesKlineRestRoot(
      process.env.BINANCE_LIVE_FUTURES_REST_BASE ||
        process.env.BINANCE_FUTURES_REST_BASE ||
        "https://fapi.binance.com",
      "https://fapi.binance.com",
    );
  }
  return normalizeFuturesKlineRestRoot(process.env.BINANCE_FUTURES_REST_BASE, "https://fapi.binance.com");
}

/**
 * Futures public WS: `BINANCE_DEMO_API` uses the same USD-M **testnet** stream host as Binance documents for
 * demo-fapi (`demo-fapi.binance.com` + `wss://fstream.binancefuture.com`). Live mainnet stays on fstream.binance.com.
 * Override with BINANCE_DEMO_FUTURES_WS_BASE; alias BINANCE_FUTURES_TESTNET_WS_BASE if you set both modes together.
 */
function resolveFuturesWsBaseForFeed(tradingMode) {
  const tm = String(tradingMode || "").toUpperCase();
  let u;
  if (tm === "BINANCE_DEMO_API") {
    u =
      process.env.BINANCE_DEMO_FUTURES_WS_BASE ||
      process.env.BINANCE_FUTURES_TESTNET_WS_BASE ||
      "wss://fstream.binancefuture.com/market/ws";
  } else if (tm === "BINANCE_TESTNET") {
    u = process.env.BINANCE_FUTURES_TESTNET_WS_BASE || "wss://fstream.binancefuture.com/market/ws";
  } else if (tm === "BINANCE_LIVE") {
    u =
      process.env.BINANCE_LIVE_FUTURES_WS_BASE ||
      process.env.BINANCE_FUTURES_WS_BASE ||
      "wss://fstream.binance.com/market/ws";
  } else {
    u = process.env.BINANCE_FUTURES_WS_BASE || "wss://fstream.binance.com/market/ws";
  }
  return routeBinanceUsdmWsBase(u, "market");
}

function resolveFuturesCombinedBaseForFeed(tradingMode) {
  const tm = String(tradingMode || "").toUpperCase();
  let u;
  if (tm === "BINANCE_DEMO_API") {
    u =
      process.env.BINANCE_DEMO_FUTURES_COMBINED_BASE ||
      process.env.BINANCE_FUTURES_TESTNET_COMBINED_BASE ||
      "wss://fstream.binancefuture.com/market/stream";
  } else if (tm === "BINANCE_TESTNET") {
    u =
      process.env.BINANCE_FUTURES_TESTNET_COMBINED_BASE || "wss://fstream.binancefuture.com/market/stream";
  } else if (tm === "BINANCE_LIVE") {
    u =
      process.env.BINANCE_LIVE_FUTURES_COMBINED_BASE ||
      process.env.BINANCE_FUTURES_COMBINED_BASE ||
      "wss://fstream.binance.com/market/stream";
  } else {
    u = process.env.BINANCE_FUTURES_COMBINED_BASE || "wss://fstream.binance.com/market/stream";
  }
  return routeBinanceUsdmWsBase(u, "market");
}

// Feed factory. Default: SYNTH. Optional: BINANCE (spot) or BINANCE_FUTURES (USDT-M public fapi + fstream).
// `feedKind` lets PAPER use live public data while process.env.MARKET_FEED stays SYNTH for other modes.
// `tradingMode` routes demo vs live public WS + kline REST (BINANCE_DEMO_API / BINANCE_TESTNET / BINANCE_LIVE); PAPER keeps mainnet defaults.
export function createMarketFeed({
  log,
  symbol,
  timeframe,
  onCandleClose = null,
  feedKind,
  tradingMode,
  onPrimaryCandleLive = null,
} = {}) {
  const kind = String(
    feedKind != null && String(feedKind).trim() ? feedKind : process.env.MARKET_FEED || "SYNTH",
  ).toUpperCase();
  const tm = tradingMode != null && String(tradingMode).trim() !== "" ? String(tradingMode) : "";
  if (kind === "BINANCE") {
    return createBinanceCombinedMarketFeed({
      log,
      symbol,
      timeframe,
      variant: "spot",
      watchSymbols: [],
      restBase: resolveSpotRestBaseForFeed(tm),
      wsBase: resolveSpotWsBaseForFeed(tm),
      combinedStreamBase: resolveSpotCombinedBaseForFeed(tm),
      onCandleClose,
      onPrimaryCandleLive,
    });
  }
  if (kind === "BINANCE_FUTURES") {
    const tmU = String(tm || "").toUpperCase();
    const futuresStreamRealm =
      tmU === "BINANCE_DEMO_API" || tmU === "BINANCE_TESTNET" ? "demo_testnet" : "live";
    return createBinanceCombinedMarketFeed({
      log,
      symbol,
      timeframe,
      variant: "futures",
      futuresStreamRealm,
      watchSymbols: [],
      restBase: resolveFuturesRestBaseForFeed(tm),
      wsBase: resolveFuturesWsBaseForFeed(tm),
      combinedStreamBase: resolveFuturesCombinedBaseForFeed(tm),
      onCandleClose,
      onPrimaryCandleLive,
    });
  }

  if (kind !== "SYNTH") {
    log.warn("market_feed_unrecognized_using_synthetic", {
      envValue: feedKind != null ? feedKind : process.env.MARKET_FEED,
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
    if (typeof onPrimaryCandleLive === "function") {
      try {
        onPrimaryCandleLive({
          symbol: String(symbol || "").trim().toUpperCase(),
          timeframe: String(timeframe || "1m").trim(),
          candle: { ts: t, open, high, low, close, volume },
        });
      } catch {
        /* ignore */
      }
    }
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
    setWatchSymbols() {
      /* synthetic feed: no-op */
    },
    getCandles() {
      seed();
      return buf.toArray();
    },
    getCandlesForSymbol() {
      return [];
    },
  };
}

