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
  /** Bumps on each new socket so messages from a terminated connection cannot corrupt the book. */
  let depthConnSerial = 0;
  let status = { ok: false, source: "BINANCE_DEPTH", lastMsgAt: null, stream: null, error: null };
  let book = { symbol, bids: [], asks: [] };

  function connect() {
    const stream = depthStream(symbol);
    const serial = ++depthConnSerial;
    status = { ok: false, source: "BINANCE_DEPTH", lastMsgAt: status.lastMsgAt, stream, error: null };
    const url = `${wsBase || DEFAULT_WS_BASE}/${stream}`;
    ws = new WebSocket(url);

    ws.on("open", () => {
      status = { ...status, ok: true, error: null };
      log.info("binance_depth_ws_open", { stream });
    });

    ws.on("message", (raw) => {
      if (serial !== depthConnSerial) return;
      status.lastMsgAt = Date.now();
      try {
        const msg = JSON.parse(String(raw));
        /** Spot partial depth uses `bids`/`asks`; USD-M futures use `b`/`a` (same [price,qty] tuples). */
        const root = msg?.data && typeof msg.data === "object" ? msg.data : msg;
        const bids = toLevels(root?.bids ?? root?.b);
        const asks = toLevels(root?.asks ?? root?.a);
        if (bids.length || asks.length) {
          // Binance sends bids/asks sorted, but we'll still enforce.
          bids.sort((a, b) => b[0] - a[0]);
          asks.sort((a, b) => a[0] - b[0]);
          const sym = normalizeSymbol(symbol);
          book = { symbol: sym, bids, asks };
        }
      } catch {
        // ignore
      }
    });

    ws.on("error", (err) => {
      if (serial !== depthConnSerial) return;
      status = { ...status, ok: false, error: String(err?.message || err) };
      log.warn("binance_depth_ws_error", { stream, error: status.error });
    });

    ws.on("close", () => {
      if (serial !== depthConnSerial) return;
      status = { ...status, ok: false };
      log.warn("binance_depth_ws_close", { stream });
      setTimeout(() => {
        if (serial !== depthConnSerial) return;
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
      const prevSym = symbol;
      const nextNorm = normalizeSymbol(next);
      if (prevSym === nextNorm) return;
      depthConnSerial += 1;
      symbol = nextNorm;
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

