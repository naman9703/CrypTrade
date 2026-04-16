import WebSocket from "ws";
import axios from "axios";
import { maxBarsForHistory } from "../lib/chartWindow.js";
import { sanitizeKlineCandle } from "../lib/symbolPriceSanity.js";
import { createCandleBuffer } from "./marketBuffer.js";
import { createBinanceDeltaAggregator } from "./marketFeedBinanceDelta.js";

const BINANCE_REST = "https://api.binance.com";
const DEFAULT_WS_BASE = "wss://stream.binance.com:9443/ws";

function normalizeSymbol(symbol) {
  return String(symbol || "").toUpperCase();
}

function normalizeInterval(timeframe) {
  // Binance intervals: 1m,3m,5m,15m,30m,1h,2h,4h,6h,8h,12h,1d...
  return String(timeframe || "1m");
}

function klineStream(symbol, interval) {
  return `${symbol.toLowerCase()}@kline_${interval}`;
}

/** @param {{ variant?: "spot" | "futures", onCandleClose?: (c: { ts: number, open: number, high: number, low: number, close: number, volume: number }) => void }} opts — futures = USDT-M `fapi` + `fstream` (often works when spot/demo returns 451). */
export function createBinanceMarketFeed({ log, symbol, timeframe, restBase, wsBase, variant = "spot", onCandleClose = null }) {
  const isFutures = variant === "futures";
  const klinesPath = isFutures ? "/fapi/v1/klines" : "/api/v3/klines";
  const sourceTag = isFutures ? "BINANCE_FUTURES" : "BINANCE";

  const buf = createCandleBuffer({ max: 3000 });
  let ws = null;
  let delta = null;
  let status = { ok: false, source: sourceTag, lastMsgAt: null, stream: null, error: null };

  const http = axios.create({
    baseURL: restBase || BINANCE_REST,
    timeout: 10_000,
  });

  function getStatus() {
    return {
      ...status,
      symbol,
      timeframe,
      buffer: buf.size(),
      delta: delta?.getStatus?.() || null,
    };
  }

  async function backfill() {
    const sym = normalizeSymbol(symbol);
    const interval = normalizeInterval(timeframe);
    const minFor24h = maxBarsForHistory(interval, 24);
    const target = Math.max(Number(process.env.BINANCE_BACKFILL_LIMIT || 2000), minFor24h);
    const pageLimit = 1000;
    let endTime = undefined;
    let fetched = 0;
    /** Each REST page is ascending time; older pages are unshifted so final flatten is oldest → newest. */
    const batches = [];

    while (fetched < target) {
      const limit = Math.min(pageLimit, target - fetched);
      const params = { symbol: sym, interval, limit };
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
        const safe = sanitizeKlineCandle(sym, c, prev, log);
        if (safe) buf.push(safe);
      }
    }
  }

  function connect() {
    const sym = normalizeSymbol(symbol);
    const interval = normalizeInterval(timeframe);
    const stream = klineStream(sym, interval);
    status = { ok: false, source: sourceTag, lastMsgAt: status.lastMsgAt, stream, error: null };

    const url = `${wsBase || DEFAULT_WS_BASE}/${stream}`;
    ws = new WebSocket(url);

    ws.on("open", () => {
      status = { ...status, ok: true, error: null };
      log.info("binance_ws_open", { stream });
    });

    ws.on("message", (raw) => {
      status.lastMsgAt = Date.now();
      try {
        const msg = JSON.parse(String(raw));
        const k = msg?.k;
        if (!k) return;
        /** `k.x` = finalized bar; `onCandleClose` runs only here (production bar-close signals). */
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
        const msgSym = normalizeSymbol(msg.s || sym);
        const prev = buf.last();
        const candle = sanitizeKlineCandle(msgSym, candleRaw, prev, log);
        if (candle == null) return;
        buf.push(candle);
        if (closed && typeof onCandleClose === "function") {
          try {
            onCandleClose({ ...candle, symbol: msgSym });
          } catch (e) {
            log?.warn?.("onCandleClose_failed", { error: String(e?.message || e) });
          }
        }
      } catch {
        // ignore
      }
    });

    ws.on("error", (err) => {
      status = { ...status, ok: false, error: String(err?.message || err) };
      log.warn("binance_ws_error", { stream, error: status.error });
    });

    ws.on("close", () => {
      status = { ...status, ok: false };
      log.warn("binance_ws_close", { stream });
      // reconnect with small backoff
      setTimeout(() => {
        try {
          connect();
        } catch (e) {
          status = { ...status, ok: false, error: String(e?.message || e) };
        }
      }, 1500);
    });
  }

  // init
  (async () => {
    try {
      await backfill();
      connect();
      delta = createBinanceDeltaAggregator({
        log,
        symbol,
        timeframe,
        wsBase,
        onDelta: ({ openTime, buy_volume, sell_volume }) => {
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
      // still try WS (may succeed even if REST blocked)
      try {
        connect();
      } catch {
        // ignore
      }
    }
  })();

  function reset() {
    if (ws) {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }
    ws = null;
    try {
      delta?.setSymbol?.(symbol);
    } catch {
      // ignore
    }
    status = { ok: false, source: sourceTag, lastMsgAt: null, stream: null, error: null };
    buf.clear();
  }

  return {
    getStatus,
    setSymbol(next) {
      symbol = normalizeSymbol(next);
      reset();
      backfill().then(connect).catch(() => connect());
      try {
        delta?.setSymbol?.(symbol);
      } catch {
        // ignore
      }
      log.info("feed_symbol_set", { symbol });
    },
    setTimeframe(next) {
      timeframe = normalizeInterval(next);
      reset();
      backfill().then(connect).catch(() => connect());
      try {
        delta?.setTimeframe?.(timeframe);
      } catch {
        // ignore
      }
      log.info("feed_timeframe_set", { timeframe });
    },
    getCandles() {
      return buf.toArray();
    },
  };
}

