import WebSocket from "ws";

const DEFAULT_WS_BASE = "wss://stream.binance.com:9443/ws";

function normalizeSymbol(symbol) {
  return String(symbol || "").toUpperCase();
}

/** Full stream name for Binance public WS (spot or USD-M): `btcusdt@aggTrade`. */
export function binancePublicAggTradeStreamName(symbol) {
  return `${normalizeSymbol(symbol).toLowerCase()}@aggTrade`;
}

function aggTradeStream(symbol) {
  return binancePublicAggTradeStreamName(symbol);
}

// Aggregates buy/sell volumes by candle openTime (ms).
export function createBinanceDeltaAggregator({
  log,
  symbol: initialSymbol,
  timeframe: initialTf,
  wsBase,
  onDelta,
  /** When true, no dedicated trades socket — parent multiplexes `symbol@aggTrade` on the kline connection. */
  multiplexed = false,
}) {
  let symbol = normalizeSymbol(initialSymbol);
  let timeframe = String(initialTf || "1m");
  let ws = null;
  let status = {
    ok: false,
    source: "BINANCE_TRADES",
    lastMsgAt: null,
    stream: null,
    error: null,
    multiplexed: Boolean(multiplexed),
  };
  let reconnectAttempt = 0;
  const reconnectMinMs = Math.max(500, Number(process.env.BINANCE_WS_RECONNECT_MIN_MS ?? 1500));
  const reconnectMaxMs = Math.max(reconnectMinMs, Number(process.env.BINANCE_WS_RECONNECT_MAX_MS ?? 60_000));

  function tfMs() {
    const tf = String(timeframe || "1m");
    if (tf.endsWith("m")) return Number(tf.slice(0, -1)) * 60_000;
    if (tf.endsWith("h")) return Number(tf.slice(0, -1)) * 60 * 60_000;
    if (tf.endsWith("d")) return Number(tf.slice(0, -1)) * 24 * 60 * 60_000;
    return 60_000;
  }

  const buckets = new Map(); // openTime -> { buy, sell }

  function bucketOpenTime(ts) {
    const w = tfMs();
    return Math.floor(Number(ts) / w) * w;
  }

  function flushOld(nowTs) {
    const w = tfMs();
    for (const [t] of buckets.entries()) {
      if (t < nowTs - 2 * w) buckets.delete(t);
    }
  }

  function applyAggTradePayload(msg) {
    const ts = Number(msg?.T);
    const qty = Number(msg?.q || 0);
    const isBuyerMaker = Boolean(msg?.m);
    const openTime = bucketOpenTime(ts);

    const cur = buckets.get(openTime) || { buy: 0, sell: 0 };
    if (isBuyerMaker) cur.sell += qty;
    else cur.buy += qty;
    buckets.set(openTime, cur);

    onDelta?.({ openTime, buy_volume: cur.buy, sell_volume: cur.sell, delta: cur.buy - cur.sell });
    flushOld(ts);
  }

  function connect() {
    if (multiplexed) return;
    const stream = aggTradeStream(symbol);
    status = {
      ...status,
      ok: false,
      source: "BINANCE_TRADES",
      lastMsgAt: status.lastMsgAt,
      stream,
      error: null,
      multiplexed: false,
    };
    const url = `${wsBase || DEFAULT_WS_BASE}/${stream}`;
    ws = new WebSocket(url);

    ws.on("open", () => {
      reconnectAttempt = 0;
      status = { ...status, ok: true, error: null, lastMsgAt: Date.now(), multiplexed: false };
      log.info("binance_trades_ws_open", { stream });
    });

    ws.on("message", (raw) => {
      status.lastMsgAt = Date.now();
      try {
        const msg = JSON.parse(String(raw));
        applyAggTradePayload(msg);
      } catch {
        // ignore
      }
    });

    ws.on("error", (err) => {
      status = { ...status, ok: false, error: String(err?.message || err) };
      log.warn("binance_trades_ws_error", { stream, error: status.error });
    });

    ws.on("close", () => {
      status = { ...status, ok: false };
      const exp = Math.min(reconnectMaxMs, reconnectMinMs * Math.pow(2, Math.min(8, reconnectAttempt)));
      const jitter = Math.floor(Math.random() * 400);
      const delay = exp + jitter;
      reconnectAttempt += 1;
      log.warn("binance_trades_ws_close", { stream, attempt: reconnectAttempt, delay });
      setTimeout(() => {
        try {
          connect();
        } catch (e) {
          status = { ...status, ok: false, error: String(e?.message || e) };
        }
      }, delay);
    });
  }

  if (multiplexed) {
    status = {
      ok: true,
      source: "BINANCE_TRADES",
      lastMsgAt: null,
      stream: binancePublicAggTradeStreamName(symbol),
      error: null,
      multiplexed: true,
    };
    log?.info?.("binance_aggtrade_multiplex", { stream: status.stream, note: "trades on kline WebSocket" });
  } else {
    connect();
  }

  return {
    getStatus() {
      return { ...status, symbol, timeframe };
    },
    /** Parent kline multiplex: feed parsed `aggTrade` payloads (after `stream`/`data` unwrap). */
    ingestMultiplexAggTrade(msg) {
      if (!multiplexed || !msg || msg.e !== "aggTrade") return;
      if (normalizeSymbol(msg.s) !== symbol) return;
      status.lastMsgAt = Date.now();
      try {
        applyAggTradePayload(msg);
      } catch {
        // ignore
      }
    },
    setSymbol(next) {
      symbol = normalizeSymbol(next);
      if (multiplexed) {
        buckets.clear();
        status = {
          ...status,
          stream: binancePublicAggTradeStreamName(symbol),
          lastMsgAt: null,
        };
        return;
      }
      try {
        ws?.terminate();
      } catch {
        // ignore
      }
      buckets.clear();
      connect();
    },
    setTimeframe(next) {
      timeframe = String(next || "1m");
      buckets.clear();
    },
  };
}
