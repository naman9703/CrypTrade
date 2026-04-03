import WebSocket from "ws";

const DEFAULT_WS_BASE = "wss://stream.binance.com:9443/ws";

function normalizeSymbol(symbol) {
  return String(symbol || "").toUpperCase();
}

function aggTradeStream(symbol) {
  return `${symbol.toLowerCase()}@aggTrade`;
}

// Aggregates buy/sell volumes by candle openTime (ms).
export function createBinanceDeltaAggregator({ log, symbol, timeframe, wsBase, onDelta }) {
  symbol = normalizeSymbol(symbol);
  let ws = null;
  let status = { ok: false, source: "BINANCE_TRADES", lastMsgAt: null, stream: null, error: null };

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
    for (const [t, v] of buckets.entries()) {
      if (t < nowTs - 2 * w) buckets.delete(t);
    }
  }

  function connect() {
    const stream = aggTradeStream(symbol);
    status = { ok: false, source: "BINANCE_TRADES", lastMsgAt: status.lastMsgAt, stream, error: null };
    const url = `${wsBase || DEFAULT_WS_BASE}/${stream}`;
    ws = new WebSocket(url);

    ws.on("open", () => {
      status = { ...status, ok: true, error: null };
      log.info("binance_trades_ws_open", { stream });
    });

    ws.on("message", (raw) => {
      status.lastMsgAt = Date.now();
      try {
        const msg = JSON.parse(String(raw));
        // aggTrade fields: T (trade time), q (quantity), m (is buyer maker)
        const ts = Number(msg?.T);
        const qty = Number(msg?.q || 0);
        const isBuyerMaker = Boolean(msg?.m);
        const openTime = bucketOpenTime(ts);

        const cur = buckets.get(openTime) || { buy: 0, sell: 0 };
        // if buyer is maker, then taker is seller => sell volume
        if (isBuyerMaker) cur.sell += qty;
        else cur.buy += qty;
        buckets.set(openTime, cur);

        onDelta?.({ openTime, buy_volume: cur.buy, sell_volume: cur.sell, delta: cur.buy - cur.sell });
        flushOld(ts);
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
      log.warn("binance_trades_ws_close", { stream });
      setTimeout(() => {
        try {
          connect();
        } catch (e) {
          status = { ...status, ok: false, error: String(e?.message || e) };
        }
      }, 1500);
    });
  }

  connect();

  return {
    getStatus() {
      return { ...status, symbol, timeframe };
    },
    setSymbol(next) {
      symbol = normalizeSymbol(next);
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

