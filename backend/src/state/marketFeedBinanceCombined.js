import WebSocket from "ws";
import axios from "axios";
import { maxBarsForHistory } from "../lib/chartWindow.js";
import { normalizeSym, sanitizeKlineCandle } from "../lib/symbolPriceSanity.js";
import { createCandleBuffer } from "./marketBuffer.js";
import { binancePublicAggTradeStreamName, createBinanceDeltaAggregator } from "./marketFeedBinanceDelta.js";
import { routeBinanceUsdmWsBase } from "../lib/binanceUsdmWsRoute.js";

const BINANCE_REST = "https://api.binance.com";
const DEFAULT_SPOT_WS = "wss://stream.binance.com:9443/ws";
const DEFAULT_SPOT_COMBINED_BASE = "wss://stream.binance.com:9443/stream";

function normalizeSymbol(symbol) {
  return String(symbol || "").toUpperCase();
}

function normalizeInterval(timeframe) {
  return String(timeframe || "1m");
}

/**
 * USD-M **market** streams (kline, aggTrade) must use `.../market/ws` or `.../market/stream` on
 * `fstream.binance.com` / `fstream.binancefuture.com` — legacy unrouted `/ws` is public-only and can
 * stop klines on live (stale chart + false slippage vs REST).
 * @see https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams
 */
function coerceUsdMFuturesWsEndpoints(wsBase, combinedBase, log, realm) {
  const isDemo = realm === "demo_testnet";
  const rawDefault = isDemo
    ? "wss://fstream.binancefuture.com/market/ws"
    : "wss://fstream.binance.com/market/ws";
  const combDefault = isDemo
    ? "wss://fstream.binancefuture.com/market/stream"
    : "wss://fstream.binance.com/market/stream";
  const spotLike = [/stream\.binance\.com/i, /demo-stream\.binance\.com/i, /testnet\.binance\.vision/i];
  function isUsdMStreamHost(u) {
    const s = String(u || "");
    if (!s.trim()) return false;
    if (/fstream\.binance\.com/i.test(s)) return true;
    if (/fstream\.binancefuture\.com/i.test(s)) return true;
    return false;
  }
  function mustCoerce(u) {
    const s = String(u || "");
    if (!s.trim()) return false;
    if (isUsdMStreamHost(s)) return false;
    return spotLike.some((re) => re.test(s));
  }
  let w = String(wsBase || "").trim() || rawDefault;
  let c = String(combinedBase || "").trim() || combDefault;
  if (mustCoerce(w)) {
    log?.warn?.("binance_usdm_ws_raw_base_coerced", { was: w.slice(0, 160), realm });
    w = rawDefault;
  }
  if (mustCoerce(c)) {
    log?.warn?.("binance_usdm_ws_combined_base_coerced", { was: c.slice(0, 160), realm });
    c = combDefault;
  }
  w = routeBinanceUsdmWsBase(w, "market");
  c = routeBinanceUsdmWsBase(c, "market");
  return { wsBase: w, combinedBase: c };
}

/**
 * Binance spot or USDT-M futures: one or many `symbol@kline_interval` streams.
 * Single-symbol keeps the legacy `/ws/<stream>` URL; 2+ uses `/stream?streams=a/b/c`.
 * Per-symbol rolling buffers; optional aggTrade delta on **primary** symbol only (dedicated socket or
 * multiplexed on the same connection as klines when `BINANCE_AGGTRADE_MULTIPLEX=1`). Same behavior for
 * **Spot** uses `stream.binance.com`; **USD-M** uses `fstream.binance.com` (live) or `fstream.binancefuture.com` (demo/testnet) per Binance docs — spot hosts are never used for `variant: "futures"`.
 */
export function createBinanceCombinedMarketFeed({
  log,
  symbol: primarySymbol,
  timeframe,
  restBase,
  wsBase,
  /** Optional: combined `?streams=` base (spot or futures). When set, overrides env defaults. */
  combinedStreamBase,
  variant = "spot",
  /** `live` → fstream.binance.com; `demo_testnet` → fstream.binancefuture.com (spot-host coercion targets). */
  futuresStreamRealm = "live",
  watchSymbols = [],
  onCandleClose = null,
  /** Throttled (~`MARKET_LIVE_CANDLE_MS`) push of the latest primary bar after each **WebSocket** kline (not REST backfill). */
  onPrimaryCandleLive = null,
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

  let defaultWsBase = isFutures
    ? wsBase != null && String(wsBase).trim() !== ""
      ? String(wsBase).trim()
      : process.env.BINANCE_FUTURES_WS_BASE || "wss://fstream.binance.com/market/ws"
    : wsBase || DEFAULT_SPOT_WS;

  let combinedBaseDefault = isFutures
    ? combinedStreamBase != null && String(combinedStreamBase).trim() !== ""
      ? String(combinedStreamBase).trim()
      : String(process.env.BINANCE_FUTURES_COMBINED_BASE || "wss://fstream.binance.com/market/stream")
    : combinedStreamBase != null && String(combinedStreamBase).trim() !== ""
      ? String(combinedStreamBase).trim()
      : String(process.env.BINANCE_COMBINED_BASE || DEFAULT_SPOT_COMBINED_BASE);

  if (isFutures) {
    const coerced = coerceUsdMFuturesWsEndpoints(defaultWsBase, combinedBaseDefault, log, futuresStreamRealm);
    defaultWsBase = coerced.wsBase;
    combinedBaseDefault = coerced.combinedBase;
  }

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
  /** Cleared on every `terminateWs` / successful `open` — detects hung handshakes. */
  let openWatchTimer = null;
  /** Client RFC ping (Binance server ping is 3m; unsolicited pong/ping helps NAT/proxies). */
  let clientPingTimer = null;
  let reconnectTimer = null;
  let resubTimer = null;
  let reconnectAttempt = 0;
  let connSerial = 0;
  let msgCountWindow = { start: Date.now(), n: 0 };

  let status = {
    ok: false,
    source: sourceTag,
    /** Wall-clock: last raw `message` on the kline multiplex socket (detects zombie / silent freeze). */
    lastMsgAt: null,
    /** Exchange event time `E` (ms) from the last primary-symbol kline frame — observability / skew checks. */
    lastPrimaryKlineExchangeEventMs: null,
    /** Wall-clock: last kline accepted into the primary buffer (REST backfill or WS after sanity). */
    lastPrimaryBufferPushAt: null,
    stream: null,
    streams: 0,
    error: null,
    reconnectCount: 0,
    combined: false,
    messagesPerMin: null,
  };

  function notePrimaryKlineAccepted(symU) {
    if (normalizeSym(symU) !== normalizeSym(symbol)) return;
    status.lastPrimaryBufferPushAt = Date.now();
  }

  const livePushMs = Math.max(16, Math.min(500, Number(process.env.MARKET_LIVE_CANDLE_MS ?? 100)));
  /** Throttle `onPrimaryCandleLive` per multiplexed symbol (primary + watchlist). */
  const livePushBySym = new Map();

  function livePushRec(symU) {
    const k = normalizeSymbol(symU);
    let r = livePushBySym.get(k);
    if (!r) {
      r = { timer: null, lastFire: 0 };
      livePushBySym.set(k, r);
    }
    return r;
  }

  function emitCandleLiveFromWs(symU) {
    if (typeof onPrimaryCandleLive !== "function") return;
    const u = normalizeSymbol(symU);
    const arr = bufFor(u).toArray();
    const last = arr[arr.length - 1];
    if (!last) return;
    try {
      onPrimaryCandleLive({
        symbol: u,
        timeframe: normalizeInterval(tf),
        candle: {
          ts: last.ts,
          open: last.open,
          high: last.high,
          low: last.low,
          close: last.close,
          volume: last.volume,
        },
      });
    } catch {
      /* ignore */
    }
  }

  function scheduleCandleLiveFromWs(symU) {
    if (typeof onPrimaryCandleLive !== "function") return;
    const rec = livePushRec(symU);
    const now = Date.now();
    const elapsed = now - rec.lastFire;
    const fire = () => {
      rec.timer = null;
      rec.lastFire = Date.now();
      emitCandleLiveFromWs(symU);
    };
    if (elapsed >= livePushMs) {
      if (rec.timer) {
        try {
          clearTimeout(rec.timer);
        } catch {
          /* ignore */
        }
        rec.timer = null;
      }
      rec.lastFire = now;
      emitCandleLiveFromWs(symU);
      return;
    }
    if (rec.timer) return;
    rec.timer = setTimeout(fire, livePushMs - elapsed);
    try {
      rec.timer.unref?.();
    } catch {
      /* ignore */
    }
  }

  function clearAllLivePushTimers() {
    for (const rec of livePushBySym.values()) {
      if (rec?.timer) {
        try {
          clearTimeout(rec.timer);
        } catch {
          /* ignore */
        }
        rec.timer = null;
      }
    }
    livePushBySym.clear();
  }

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

  /** Prefer one WebSocket for kline + primary `aggTrade` (Binance combined `/stream?streams=`). Applies to live mainnet and demo/testnet; set `BINANCE_AGGTRADE_MULTIPLEX=0` for a separate trades socket. */
  function resolveMultiplexAggTrade() {
    const v = String(process.env.BINANCE_AGGTRADE_MULTIPLEX ?? "1").toLowerCase();
    if (v === "0" || v === "false" || v === "off") return false;
    return true;
  }

  function buildSubscriptionStreamNames(includeAggMultiplex) {
    const interval = normalizeInterval(tf);
    const syms = subscriptionList();
    const names = syms.map((s) => `${normalizeSymbol(s).toLowerCase()}@kline_${interval}`);
    if (includeAggMultiplex) names.push(binancePublicAggTradeStreamName(symbol));
    return names;
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
        if (safe) {
          buf.push(safe);
          notePrimaryKlineAccepted(symU);
        }
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

  /** @param {string[]} streamNames full paths e.g. `btcusdt@kline_1m`, `btcusdt@aggTrade` */
  function buildWsUrlFromStreamNames(streamNames) {
    if (!streamNames.length) return null;
    if (streamNames.length === 1) {
      const base = defaultWsBase.replace(/\/$/, "");
      const path = streamNames[0];
      status = { ...status, combined: false, stream: path, streams: 1 };
      return `${base}/${path}`;
    }
    const q = encodeURIComponent(streamNames.join("/"));
    status = { ...status, combined: true, stream: `streams=${streamNames.length}`, streams: streamNames.length };
    return `${combinedBaseDefault}?streams=${q}`;
  }

  function parseIncoming(raw) {
    try {
      const msg = JSON.parse(String(raw));
      if (msg?.stream != null && msg.data != null) {
        let d = msg.data;
        if (typeof d === "string") {
          try {
            d = JSON.parse(d);
          } catch {
            return null;
          }
        }
        return d;
      }
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
    if (openWatchTimer) {
      try {
        clearTimeout(openWatchTimer);
      } catch {
        /* ignore */
      }
      openWatchTimer = null;
    }
    if (clientPingTimer) {
      try {
        clearInterval(clientPingTimer);
      } catch {
        /* ignore */
      }
      clientPingTimer = null;
    }
    /** Staleness gate uses min(lastMsgAt, lastPrimaryBufferPushAt); clear push time so reconnect cannot pair fresh `lastMsgAt` with a pre-disconnect accept ts (false "Feed: stale"). */
    status = { ...status, lastPrimaryBufferPushAt: null, lastPrimaryKlineExchangeEventMs: null };
    clearAllLivePushTimers();
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

  let lastForceReconnectAt = 0;
  /** Production: zombie sockets stay `open` with no data — terminate and reconnect (debounced). */
  function requestReconnect(reason) {
    const cooldown = Math.max(2000, Number(process.env.FEED_FORCE_RECONNECT_COOLDOWN_MS ?? 8000));
    const t = Date.now();
    if (t - lastForceReconnectAt < cooldown) {
      log?.info?.("feed_force_reconnect_skipped_cooldown", { reason, cooldownMs: cooldown });
      return;
    }
    lastForceReconnectAt = t;
    log.warn("feed_force_reconnect", { reason: String(reason || "unspecified") });
    if (reconnectTimer) {
      try {
        clearTimeout(reconnectTimer);
      } catch {
        /* ignore */
      }
      reconnectTimer = null;
    }
    reconnectAttempt = 0;
    try {
      connect();
    } catch (e) {
      log?.warn?.("feed_force_reconnect_failed", { error: String(e?.message || e) });
      scheduleReconnect();
    }
  }

  /** Best-effort ms timestamp from Binance kline wrapper (`E`, `T`, `k.T`, `k.t`); handles rare sec-scale values. */
  function pickBinanceKlineEventMs(inner, kline) {
    const cands = [inner?.E, inner?.T, kline?.T, kline?.t];
    for (const raw of cands) {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (n > 1e12) return Math.round(n);
      if (n > 1e9) return Math.round(n * 1000);
    }
    return null;
  }

  function connect() {
    terminateWs();
    const serial = ++connSerial;
    const syms = subscriptionList();
    if (!syms.length) {
      log?.warn?.("binance_combined_no_streams");
      return;
    }

    const multiplexAgg = resolveMultiplexAggTrade();
    const streamNames = buildSubscriptionStreamNames(multiplexAgg);
    const url = buildWsUrlFromStreamNames(streamNames);
    if (!url) {
      log?.warn?.("binance_combined_no_streams");
      return;
    }
    const handshakeMs = Math.max(10_000, Math.min(120_000, Number(process.env.BINANCE_WS_OPEN_TIMEOUT_MS ?? 30_000)));
    const sock = new WebSocket(url, {
      handshakeTimeout: handshakeMs,
      perMessageDeflate: false,
      maxPayload: 32 * 1024 * 1024,
    });
    ws = sock;

    openWatchTimer = setTimeout(() => {
      openWatchTimer = null;
      if (serial !== connSerial) return;
      if (sock.readyState === WebSocket.OPEN) return;
      log.warn("binance_ws_open_timeout", { url: url.slice(0, 140), handshakeMs });
      try {
        sock.terminate();
      } catch {
        /* ignore */
      }
      /** `close` → `scheduleReconnect`; avoid double-scheduling here. */
    }, handshakeMs + 2000);
    try {
      openWatchTimer.unref?.();
    } catch {
      /* ignore */
    }

    sock.on("open", () => {
      if (serial !== connSerial) return;
      if (openWatchTimer) {
        try {
          clearTimeout(openWatchTimer);
        } catch {
          /* ignore */
        }
        openWatchTimer = null;
      }
      if (clientPingTimer) {
        try {
          clearInterval(clientPingTimer);
        } catch {
          /* ignore */
        }
        clientPingTimer = null;
      }
      const pingEvery = Math.max(
        45_000,
        Math.min(150_000, Number(process.env.BINANCE_WS_CLIENT_PING_MS ?? 120_000)),
      );
      clientPingTimer = setInterval(() => {
        if (serial !== connSerial || !ws || ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.ping();
        } catch {
          /* ignore */
        }
      }, pingEvery);
      try {
        clientPingTimer.unref?.();
      } catch {
        /* ignore */
      }
      reconnectAttempt = 0;
      // Align both refs used by `evaluateLiveBinanceFeedExecutionGate` (defaults to max of inbound + primary accept).
      // Reconnect used to reset only `lastMsgAt`, so min(fresh inbound, stale lastPrimaryBufferPushAt) stayed
      // old → immediate "Feed: stale" + autotrade pause while aggTrade/kline multiplex was healthy (live futures).
      const t0 = Date.now();
      status = { ...status, ok: true, error: null, lastMsgAt: t0, lastPrimaryBufferPushAt: t0 };
      log.info("binance_ws_open", {
        url: url.slice(0, 120),
        klineSymbols: syms.length,
        streamCount: streamNames.length,
        aggTradeMultiplex: multiplexAgg,
        combined: status.combined,
      });
    });

    sock.on("unexpected-response", (_req, res) => {
      if (serial !== connSerial) return;
      const code = res?.statusCode;
      log.warn("binance_ws_unexpected_response", { statusCode: code, url: url.slice(0, 120) });
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
      if (inner.e === "error") {
        log?.warn?.("binance_ws_payload_error", { detail: inner });
        return;
      }

      if (multiplexAgg && inner.e === "aggTrade") {
        delta?.ingestMultiplexAggTrade?.(inner);
        return;
      }

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
      const msgSym = normalizeSymbol(inner.s || syms[0]);
      if (normalizeSym(msgSym) === normalizeSym(symbol)) {
        const exchMs = pickBinanceKlineEventMs(inner, k);
        if (exchMs != null) status.lastPrimaryKlineExchangeEventMs = exchMs;
      }
      const buf = bufFor(msgSym);
      const prev = buf.last();
      const candle = sanitizeKlineCandle(msgSym, candleRaw, prev, log);
      if (candle == null) return;
      buf.push(candle);
      notePrimaryKlineAccepted(msgSym);
      scheduleCandleLiveFromWs(msgSym);
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
      if (openWatchTimer) {
        try {
          clearTimeout(openWatchTimer);
        } catch {
          /* ignore */
        }
        openWatchTimer = null;
      }
      status = { ...status, ok: false, error: String(err?.message || err) };
      log.warn("binance_ws_error", { error: status.error });
    });

    sock.on("close", () => {
      if (serial !== connSerial) return;
      if (openWatchTimer) {
        try {
          clearTimeout(openWatchTimer);
        } catch {
          /* ignore */
        }
        openWatchTimer = null;
      }
      if (clientPingTimer) {
        try {
          clearInterval(clientPingTimer);
        } catch {
          /* ignore */
        }
        clientPingTimer = null;
      }
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
      const multiplexAgg = resolveMultiplexAggTrade();
      delta = createBinanceDeltaAggregator({
        log,
        symbol,
        timeframe: tf,
        wsBase: defaultWsBase,
        multiplexed: multiplexAgg,
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
      connect();
      lastStreamKey = `${tf}|${[...syms0].sort().join(",")}`;
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
    requestReconnect,
    /** @returns {Promise<void>} */
    ready: () => initPromise,
    setSymbol(next) {
      const prevSym = symbol;
      symbol = normalizeSymbol(next);
      if (prevSym !== symbol) {
        status.lastPrimaryBufferPushAt = null;
        status.lastPrimaryKlineExchangeEventMs = null;
      }
      extraWatch = extraWatch.filter((s) => s !== symbol);
      resetBuffers(subscriptionList());
      lastStreamKey = "";
      debouncedResync();
      log.info("feed_symbol_set", { symbol });
    },
    setTimeframe(next) {
      tf = normalizeInterval(next);
      buffers.clear();
      status.lastPrimaryBufferPushAt = null;
      status.lastPrimaryKlineExchangeEventMs = null;
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
      /** Always use `bufFor` — empty buffer before first backfill/WS is still a valid series (was `[]` if key missing). */
      return bufFor(s).toArray();
    },
  };
}
