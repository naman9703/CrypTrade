import WebSocket from "ws";

const DEFAULT_WS_BASE = "wss://stream.binance.com:9443/ws";

function normalizeSymbol(symbol) {
  return String(symbol || "").toUpperCase();
}

function depthStream(symbol) {
  // Partial order book snapshots (top 20 levels) at 100ms.
  return `${symbol.toLowerCase()}@depth20@100ms`;
}

function toLevels(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => [Number(x?.[0]), Number(x?.[1])])
    .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && p > 0 && q > 0);
}

export function createBinanceOrderBook({ log, symbol, wsBase }) {
  symbol = normalizeSymbol(symbol);
  let ws = null;
  let status = { ok: false, source: "BINANCE_DEPTH", lastMsgAt: null, stream: null, error: null };
  let book = { symbol, bids: [], asks: [] };

  function connect() {
    const stream = depthStream(symbol);
    status = { ok: false, source: "BINANCE_DEPTH", lastMsgAt: status.lastMsgAt, stream, error: null };
    const url = `${wsBase || DEFAULT_WS_BASE}/${stream}`;
    ws = new WebSocket(url);

    ws.on("open", () => {
      status = { ...status, ok: true, error: null };
      log.info("binance_depth_ws_open", { stream });
    });

    ws.on("message", (raw) => {
      status.lastMsgAt = Date.now();
      try {
        const msg = JSON.parse(String(raw));
        const bids = toLevels(msg?.bids);
        const asks = toLevels(msg?.asks);
        if (bids.length || asks.length) {
          // Binance sends bids/asks sorted, but we'll still enforce.
          bids.sort((a, b) => b[0] - a[0]);
          asks.sort((a, b) => a[0] - b[0]);
          book = { symbol, bids, asks };
        }
      } catch {
        // ignore
      }
    });

    ws.on("error", (err) => {
      status = { ...status, ok: false, error: String(err?.message || err) };
      log.warn("binance_depth_ws_error", { stream, error: status.error });
    });

    ws.on("close", () => {
      status = { ...status, ok: false };
      log.warn("binance_depth_ws_close", { stream });
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
      return { ...status, symbol };
    },
    getBook() {
      return { ...book, bids: book.bids.slice(0, 20), asks: book.asks.slice(0, 20) };
    },
    setSymbol(next) {
      symbol = normalizeSymbol(next);
      book = { symbol, bids: [], asks: [] };
      try {
        ws?.terminate();
      } catch {
        // ignore
      }
      ws = null;
      connect();
    },
    close() {
      try {
        ws?.terminate();
      } catch {
        // ignore
      }
      ws = null;
      status = { ...status, ok: false };
    },
  };
}

