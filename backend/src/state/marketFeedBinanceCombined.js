import WebSocket from "ws";
import axios from "axios";
import { maxBarsForHistory } from "../lib/chartWindow.js";
import { sanitizeKlineCandle } from "../lib/symbolPriceSanity.js";
import { createCandleBuffer } from "./marketBuffer.js";
import { createBinanceDeltaAggregator } from "./marketFeedBinanceDelta.js";

const BINANCE_REST = "https://api.binance.com";
const DEFAULT_SPOT_WS = "wss://stream.binance.com:9443/ws";
const DEFAULT_SPOT_COMBINED_BASE = "wss://stream.binance.com:9443/stream";

function normalizeSymbol(symbol) {
  return String(symbol || "").toUpperCase();
}

function normalizeInterval(timeframe) {
  return String(timeframe || "1m");
}

function klineStream(symbol, interval) {
  return `${String(symbol).toLowerCase()}@kline_${interval}`;
}

/**
 * Binance spot or USDT-M futures: one or many `symbol@kline_interval` streams.
 * Single-symbol keeps the legacy `/ws/<stream>` URL; 2+ uses `/stream?streams=a/b/c`.
 * Per-symbol rolling buffers; optional aggTrade delta on **primary** symbol only.
 */
export function createBinanceCombinedMarketFeed({
  log,
  symbol: primarySymbol,
  timeframe,
  restBase,
  wsBase,
  variant = "spot",
  watchSymbols = [],
  onCandleClose = null,
}) {
  const isFutures = variant === "futures";
  const klinesPath = isFutures ? "/fapi/v1/klines" : "/api/v3/klines";
  const sourceTag = isFutures ? "BINANCE_FUTURES" : "BINANCE";

  const maxStreams = Math.max(
    1,
    Math.min(80, Math.floor(Number(process.env.BINANCE_COMBINED_MAX_STREAMS ?? 12))),
  );
  const reconnectMinMs = Math.max(500, Number(process.env.BINANCE_WS_RECONNECT_MIN_MS ?? 1500));
  const reconnectMaxMs = Math.max(reconnectMinMs, Number(process.env.BINANCE_WS_RECONNECT_MAX_MS ?? 60_000));
  const resubscribeDebounceMs = Math.max(50, Number(process.env.BINANCE_COMBINED_RESUBSCRIBE_MS ?? 400));

  const defaultWsBase = isFutures
    ? process.env.BINANCE_FUTURES_WS_BASE || "wss://fstream.binance.com/ws"
    : wsBase || DEFAULT_SPOT_WS;

  const combinedBaseDefault = isFutures
    ? String(process.env.BINANCE_FUTURES_COMBINED_BASE || "wss://fstream.binance.com/stream")
    : String(process.env.BINANCE_COMBINED_BASE || DEFAULT_SPOT_COMBINED_BASE);

  let symbol = normalizeSymbol(primarySymbol);
  let tf = normalizeInterval(timeframe);
  let extraWatch = uniqUpper(watchSymbols).filter((s) => s && s !== symbol).slice(0, maxStreams - 1);

  const buffers = new Map();
  function bufFor(symU) {
    let b = buffers.get(symU);
    if (!b) {
      b = createCandleBuffer({ max: Math.min(4000, Number(process.env.BINANCE_BUFFER_MAX || 3000)) });
      buffers.set(symU, b);
    }
    return b;
  }

  let ws = null;
  let delta = null;
  let reconnectTimer = null;
  let resubTimer = null;
  let reconnectAttempt = 0;
  let connSerial = 0;
  let msgCountWindow = { start: Date.now(), n: 0 };

  let status = {
    ok: false,
    source: sourceTag,
    lastMsgAt: null,
    stream: null,
    streams: 0,
    error: null,
    reconnectCount: 0,
    combined: false,
    messagesPerMin: null,
  };

  const http = axios.create({
    baseURL: restBase || BINANCE_REST,
    timeout: 10_000,
  });

  function uniqUpper(arr) {
    return [...new Set((Array.isArray(arr) ? arr : []).map((s) => normalizeSymbol(s)).filter(Boolean))];
  }

  function subscriptionList() {
    const all = uniqUpper([symbol, ...extraWatch]);
    return all.slice(0, maxStreams);
  }

  function getStatus() {
    return {
      ...status,
      symbol,
      timeframe: tf,
      primarySymbol: symbol,
      watchSymbols: extraWatch.slice(),
      buffer: bufFor(symbol).size(),
      buffers: Object.fromEntries([...buffers.entries()].map(([k, b]) => [k, b.size()])),
      delta: delta?.getStatus?.() || null,
    };
  }

  async function backfillOne(symU) {
    const interval = normalizeInterval(tf);
    const minFor24h = maxBarsForHistory(interval, 24);
    const target = Math.max(Number(process.env.BINANCE_BACKFILL_LIMIT || 2000), minFor24h);
    const pageLimit = 1000;
    let endTime = undefined;
    let fetched = 0;
    const batches = [];
    const buf = bufFor(symU);

    while (fetched < target) {
      const limit = Math.min(pageLimit, target - fetched);
      const params = { symbol: symU, interval, limit };
      if (endTime != null) params.endTime = endTime;
      const { data } = await http.get(klinesPath, { params });
      if (!Array.isArray(data) || data.length === 0) break;

      const mapped = data.map((k) => ({
        ts: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
        buy_volume: null,
        sell_volume: null,
      }));
      batches.unshift(mapped);
      fetched += data.length;
      endTime = Number(data[0][0]) - 1;
      if (data.length < limit) break;
    }

    for (const batch of batches) {
      for (const c of batch) {
        const prev = buf.last();
        const safe = sanitizeKlineCandle(symU, c, prev, log);
        if (safe) buf.push(safe);
      }
    }
  }

  async function backfillAll(syms) {
    const list = uniqUpper(syms);
    const concurrency = Math.max(1, Math.min(4, Number(process.env.BINANCE_BACKFILL_CONCURRENCY ?? 3)));
    for (let i = 0; i < list.length; i += concurrency) {
      const chunk = list.slice(i, i + concurrency);
      await Promise.all(
        chunk.map((s) =>
          backfillOne(s).catch((e) => {
            log?.warn?.("binance_backfill_symbol_failed", { symbol: s, error: String(e?.message || e) });
          }),
        ),
      );
    }
  }

  function buildWsUrl(streams) {
    const interval = normalizeInterval(tf);
    const names = streams.map((s) => klineStream(s, interval));
    if (names.length === 1) {
      const base = defaultWsBase.replace(/\/$/, "");
      const path = names[0];
      status = { ...status, combined: false, stream: path, streams: 1 };
      return `${base}/${path}`;
    }
    const q = encodeURIComponent(names.join("/"));
    status = { ...status, combined: true, stream: `streams=${names.length}`, streams: names.length };
    return `${combinedBaseDefault}?streams=${q}`;
  }

  function parseIncoming(raw) {
    try {
      const msg = JSON.parse(String(raw));
      if (msg?.stream && msg.data) return msg.data;
      return msg;
    } catch {
      return null;
    }
  }

  function terminateWs() {
    if (reconnectTimer) {
      try {
        clearTimeout(reconnectTimer);
      } catch {
        /* ignore */
      }
    }
    reconnectTimer = null;
    if (ws) {
      try {
        ws.removeAllListeners?.();
        ws.terminate?.();
      } catch {
        /* ignore */
      }
    }
    ws = null;
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const exp = Math.min(reconnectMaxMs, reconnectMinMs * Math.pow(2, Math.min(8, reconnectAttempt)));
    const jitter = Math.floor(Math.random() * 400);
    const delay = exp + jitter;
    reconnectAttempt += 1;
    status = { ...status, ok: false, error: status.error || "reconnecting" };
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    terminateWs();
    const serial = ++connSerial;
    const streams = subscriptionList();
    if (!streams.length) {
      log?.warn?.("binance_combined_no_streams");
      return;
    }

    const url = buildWsUrl(streams);
    const sock = new WebSocket(url);
    ws = sock;

    sock.on("open", () => {
      if (serial !== connSerial) return;
      reconnectAttempt = 0;
      status = { ...status, ok: true, error: null };
      log.info("binance_ws_open", { url: url.slice(0, 120), streams: streams.length, combined: status.combined });
    });

    sock.on("message", (raw) => {
      if (serial !== connSerial) return;
      status.lastMsgAt = Date.now();
      const now = Date.now();
      if (now - msgCountWindow.start > 60_000) {
        status = { ...status, messagesPerMin: msgCountWindow.n };
        msgCountWindow = { start: now, n: 0 };
      }
      msgCountWindow.n += 1;

      const inner = parseIncoming(raw);
      if (!inner) return;
      const k = inner?.k;
      if (!k) return;
      /** Binance kline `k.x === true` means the interval is final; Supertrend / bar-close logic must not run on partial bars. */
      const closed = Boolean(k.x);
      const candleRaw = {
        ts: Number(k.t),
        open: Number(k.o),
        high: Number(k.h),
        low: Number(k.l),
        close: Number(k.c),
        volume: Number(k.v),
        buy_volume: null,
        sell_volume: null,
      };
      const msgSym = normalizeSymbol(inner.s || streams[0]);
      const buf = bufFor(msgSym);
      const prev = buf.last();
      const candle = sanitizeKlineCandle(msgSym, candleRaw, prev, log);
      if (candle == null) return;
      buf.push(candle);
      if (closed && typeof onCandleClose === "function") {
        try {
          onCandleClose({ ...candle, symbol: msgSym });
        } catch (e) {
          log?.warn?.("onCandleClose_failed", { error: String(e?.message || e), symbol: msgSym });
        }
      }
    });

    sock.on("error", (err) => {
      if (serial !== connSerial) return;
      status = { ...status, ok: false, error: String(err?.message || err) };
      log.warn("binance_ws_error", { error: status.error });
    });

    sock.on("close", () => {
      if (serial !== connSerial) return;
      status = { ...status, ok: false };
      status.reconnectCount = (status.reconnectCount || 0) + 1;
      log.warn("binance_ws_close", { attempt: reconnectAttempt });
      scheduleReconnect();
    });
  }

  let initPromise = null;
  let lastStreamKey = "";

  async function fullResync() {
    try {
      await initPromise;
    } catch (e) {
      log?.warn?.("binance_combined_init_wait_failed", { error: String(e?.message || e) });
    }
    const syms = subscriptionList();
    const streamKey = `${tf}|${[...syms].sort().join(",")}`;
    if (streamKey === lastStreamKey) return;
    lastStreamKey = streamKey;
    await backfillAll(syms).catch((e) => log?.warn?.("binance_backfill_all_failed", { error: String(e?.message || e), reason }));
    connect();
    try {
      delta?.setSymbol?.(symbol);
      delta?.setTimeframe?.(tf);
    } catch {
      /* ignore */
    }
  }

  function debouncedResync() {
    if (resubTimer) clearTimeout(resubTimer);
    resubTimer = setTimeout(() => {
      resubTimer = null;
      void fullResync();
    }, resubscribeDebounceMs);
  }

  initPromise = (async () => {
    try {
      const syms0 = subscriptionList();
      await backfillAll(syms0);
      connect();
      lastStreamKey = `${tf}|${[...syms0].sort().join(",")}`;
      delta = createBinanceDeltaAggregator({
        log,
        symbol,
        timeframe: tf,
        wsBase: defaultWsBase,
        onDelta: ({ openTime, buy_volume, sell_volume }) => {
          const buf = bufFor(symbol);
          const arr = buf.raw();
          for (let i = arr.length - 1; i >= 0 && i >= arr.length - 5; i--) {
            if (Number(arr[i].ts) === Number(openTime)) {
              arr[i].buy_volume = buy_volume;
              arr[i].sell_volume = sell_volume;
              break;
            }
          }
        },
      });
    } catch (e) {
      status = { ...status, ok: false, error: String(e?.message || e) };
      log.warn("binance_feed_init_failed", { error: status.error });
      try {
        connect();
      } catch {
        /* ignore */
      }
    }
  })();

  function resetBuffers(keepSyms) {
    const keep = new Set(uniqUpper(keepSyms));
    for (const k of [...buffers.keys()]) {
      if (!keep.has(k)) {
        buffers.get(k)?.clear?.();
        buffers.delete(k);
      }
    }
  }

  return {
    getStatus,
    /** @returns {Promise<void>} */
    ready: () => initPromise,
    setSymbol(next) {
      symbol = normalizeSymbol(next);
      extraWatch = extraWatch.filter((s) => s !== symbol);
      resetBuffers(subscriptionList());
      lastStreamKey = "";
      debouncedResync();
      log.info("feed_symbol_set", { symbol });
    },
    setTimeframe(next) {
      tf = normalizeInterval(next);
      buffers.clear();
      lastStreamKey = "";
      debouncedResync();
      try {
        delta?.setTimeframe?.(tf);
      } catch {
        /* ignore */
      }
      log.info("feed_timeframe_set", { timeframe: tf });
    },
    /**
     * Additional symbols to multiplex on the same Binance connection (capped).
     * Primary `symbol` is always included.
     */
    setWatchSymbols(syms) {
      extraWatch = uniqUpper(syms)
        .filter((s) => s && s !== symbol)
        .slice(0, maxStreams - 1);
      resetBuffers(subscriptionList());
      debouncedResync();
    },
    getCandles() {
      return bufFor(symbol).toArray();
    },
    getCandlesForSymbol(sym) {
      const s = normalizeSymbol(sym);
      if (!buffers.has(s)) return [];
      return bufFor(s).toArray();
    },
  };
}
