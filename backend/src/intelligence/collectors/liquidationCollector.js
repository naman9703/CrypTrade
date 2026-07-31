import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { enqueueForceOrder } from './forceOrderPersist.js';
import { resolveBinanceForceOrderStreamUrl } from '../../lib/binanceLiquidationWsUrl.js';

const WINDOW_MS = 4 * 60 * 60 * 1000;
const RECONNECT_DELAY_MS = 5000;
const RECENT_TICK_CAP = 5000;

/** @typedef {{ time: number, side: string, notionalUsd: number, price?: number, qty?: number }} LiqEntry */

/** @type {Map<string, LiqEntry[]>} */
const buffer = new Map();

/** Fine-grained recent ticks per symbol for cascade live engine. */
/** @type {Map<string, LiqEntry[]>} */
const recentTicks = new Map();

/** @type {Map<string, Record<string, unknown>>} */
const stats = new Map();

/** @type {import('events').EventEmitter} */
export const liquidationEvents = new EventEmitter();
liquidationEvents.setMaxListeners(20);

let ws = null;
let running = false;
let reconnectTimer = null;
/** @type {(() => string) | null} */
let resolveTradingMode = null;
/** @type {ReturnType<typeof setInterval> | null} */
let pruneTimer = null;

/** @type {{ running: boolean, connected: boolean, connectedAt: number | null, startedAt: number | null, lastMessageAt: number | null, lastError: string | null, messageCount: number, streamUrl: string | null }} */
const streamMeta = {
  running: false,
  connected: false,
  connectedAt: null,
  startedAt: null,
  lastMessageAt: null,
  lastError: null,
  messageCount: 0,
  streamUrl: null,
};

const LIQ_STALE_MS = 10 * 60 * 1000;
const LIQ_CONNECT_GRACE_MS = 90_000;

/** Health of Binance USD-M forceOrder websocket (used by LIQ_CASCADE live tick + intel). */
export function getLiquidationStreamStatus() {
  const now = Date.now();
  const recentMessage =
    streamMeta.lastMessageAt != null && now - streamMeta.lastMessageAt <= LIQ_STALE_MS;
  const connectGrace =
    streamMeta.connectedAt != null && now - streamMeta.connectedAt <= LIQ_CONNECT_GRACE_MS;
  const ok = streamMeta.running && streamMeta.connected && (recentMessage || connectGrace);
  return {
    running: streamMeta.running,
    connected: streamMeta.connected,
    ok,
    live: streamMeta.running && streamMeta.connected,
    streamUrl: streamMeta.streamUrl,
    connectedAt: streamMeta.connectedAt,
    startedAt: streamMeta.startedAt,
    lastMessageAt: streamMeta.lastMessageAt,
    lastError: streamMeta.lastError,
    messageCount: streamMeta.messageCount,
    staleMs: LIQ_STALE_MS,
  };
}

/** Start if needed; restart if stuck disconnected. Safe to call from LIQ_CASCADE status polls. */
export function ensureLiquidationStreamRunning(opts = {}) {
  const now = Date.now();
  const st = getLiquidationStreamStatus();
  if (!st.running) {
    startLiquidationStream(opts);
    return getLiquidationStreamStatus();
  }
  const startedAt = streamMeta.startedAt ?? now;
  const disconnectedFor = !st.connected ? now - startedAt : 0;
  const staleDisconnect = !st.connected && disconnectedFor > 25_000;
  const errorStuck = !st.connected && Boolean(st.lastError);
  if (staleDisconnect || errorStuck) {
    console.warn("[liquidations] Restarting stuck forceOrder stream", {
      disconnectedFor,
      lastError: st.lastError,
      streamUrl: st.streamUrl,
    });
    stopLiquidationStream();
    startLiquidationStream(opts);
  }
  return getLiquidationStreamStatus();
}

function currentStreamUrl() {
  const tm = resolveTradingMode?.() ?? process.env.TRADING_MODE ?? "PAPER";
  return resolveBinanceForceOrderStreamUrl(tm);
}

/** @param {{ getTradingMode?: () => string }} [opts] */
export function startLiquidationStream(opts = {}) {
  if (running) return;
  resolveTradingMode = typeof opts.getTradingMode === "function" ? opts.getTradingMode : null;
  running = true;
  streamMeta.running = true;
  streamMeta.startedAt = Date.now();
  streamMeta.streamUrl = currentStreamUrl();
  connect();
  pruneTimer = setInterval(pruneBuffer, 5 * 60 * 1000);
  pruneTimer.unref?.();
  console.log('[liquidations] Binance forceOrder stream starting...');
}

export function stopLiquidationStream() {
  running = false;
  streamMeta.running = false;
  streamMeta.connected = false;
  streamMeta.connectedAt = null;
  streamMeta.startedAt = null;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
  if (ws) {
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
    ws = null;
  }
}

/** Binance USDⓈ-M perpetual-style symbols we aggregate (matches intel candle universe). */
const SYM_LIQ_RE = /^[A-Z0-9]{2,32}USDT$/;

/** @param {Record<string, unknown>} row */
function normalizeLiquidationRow(row) {
  return {
    longUsd: Number(row.longUsd ?? 0),
    shortUsd: Number(row.shortUsd ?? 0),
    totalUsd: Number(row.totalUsd ?? 0),
    count: Number(row.count ?? 0),
    dominance:
      row.dominance === 'longs' || row.dominance === 'shorts' ? row.dominance : 'neutral',
    intensity:
      row.intensity === 'moderate' ||
      row.intensity === 'high' ||
      row.intensity === 'extreme'
        ? row.intensity
        : 'low',
    windowHours: 4,
    lastUpdated: Number(row.lastUpdated ?? Date.now()),
  };
}

/**
 * Normalized liquidation snapshot for API/WS when the collector is running — includes a zero stub
 * so the UI never shows "no data" just because no forceOrder hit this symbol yet.
 * @param {string} symbol e.g. BTCUSDT
 */
export function getLiquidationPayloadForSymbol(symbol) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym || !SYM_LIQ_RE.test(sym)) return null;

  const row = stats.get(sym);
  if (row && typeof row === 'object') return normalizeLiquidationRow(row);

  if (!running) return null;

  return {
    longUsd: 0,
    shortUsd: 0,
    totalUsd: 0,
    count: 0,
    dominance: 'neutral',
    intensity: 'low',
    windowHours: 4,
    lastUpdated: Date.now(),
  };
}

/** @param {string} symbol e.g. BTCUSDT */
export function getLiquidationStats(symbol) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) return null;
  return stats.get(sym) ?? null;
}

export function getAllLiquidationStats() {
  return Object.fromEntries(stats.entries());
}

/**
 * Recent forceOrder ticks for a symbol (in-memory, up to ~15 min retained).
 * @param {string} symbol
 * @param {number} windowMs
 */
export function getRecentLiquidations(symbol, windowMs = 15 * 60 * 1000) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym) return [];
  const cutoff = Date.now() - windowMs;
  return (recentTicks.get(sym) ?? []).filter((e) => e.time >= cutoff);
}

function connect() {
  if (!running) return;
  const streamUrl = currentStreamUrl();
  streamMeta.streamUrl = streamUrl;
  try {
    ws = new WebSocket(streamUrl);

    ws.on('open', () => {
      streamMeta.connected = true;
      streamMeta.connectedAt = Date.now();
      streamMeta.lastError = null;
      console.log('[liquidations] Connected to Binance forceOrder stream', streamUrl);
    });

    ws.on('message', (raw) => {
      streamMeta.lastMessageAt = Date.now();
      streamMeta.messageCount += 1;
      try {
        const msg = JSON.parse(String(raw));
        const events = Array.isArray(msg) ? msg : [msg];
        for (const event of events) {
          if (event && event.e === 'forceOrder' && event.o) handleLiquidation(event.o);
        }
      } catch {
        /* malformed — ignore */
      }
    });

    ws.on('close', (code) => {
      streamMeta.connected = false;
      streamMeta.connectedAt = null;
      console.warn(`[liquidations] Stream closed (${code}). Reconnecting in ${RECONNECT_DELAY_MS}ms`);
      ws = null;
      if (running) reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    });

    ws.on('error', (err) => {
      streamMeta.lastError = String(err?.message || err);
      console.warn('[liquidations] Stream error:', err?.message || err);
    });
  } catch (err) {
    streamMeta.lastError = String(err?.message || err);
    console.warn('[liquidations] connect() failed:', err?.message || err);
    if (running) reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  }
}

/** @param {Record<string, unknown>} order */
function handleLiquidation(order) {
  const status = String(order.X ?? order.x ?? '').toUpperCase();
  if (status && status !== 'FILLED' && status !== 'PARTIALLY_FILLED') return;

  const symbol = String(order.s ?? '').trim().toUpperCase();
  const side = String(order.S ?? '').toUpperCase();
  const qty = Number(order.z ?? order.q ?? 0);
  const price = Number(order.ap ?? order.p ?? 0);
  const time = Number(order.T ?? Date.now());
  const orderId = Number(order.i ?? order.orderId ?? 0) || undefined;
  const notionalUsd = qty * price;

  if (!symbol || !Number.isFinite(notionalUsd) || notionalUsd < 1) return;
  if (side !== 'SELL' && side !== 'BUY') return;

  const entry = { time, side, notionalUsd, price, qty };

  if (!buffer.has(symbol)) buffer.set(symbol, []);
  buffer.get(symbol).push(entry);

  if (!recentTicks.has(symbol)) recentTicks.set(symbol, []);
  const ticks = recentTicks.get(symbol);
  ticks.push(entry);
  if (ticks.length > RECENT_TICK_CAP) ticks.splice(0, ticks.length - RECENT_TICK_CAP);

  enqueueForceOrder({
    symbol,
    ts: time,
    side,
    price,
    qty,
    notionalUsd,
    orderId,
  });

  recomputeStats(symbol);

  liquidationEvents.emit('forceOrder', {
    symbol,
    time,
    side,
    price,
    qty,
    notionalUsd,
  });
}

/** @param {string} symbol */
function recomputeStats(symbol) {
  const cutoff = Date.now() - WINDOW_MS;
  const entries = (buffer.get(symbol) ?? []).filter((e) => e.time >= cutoff);
  buffer.set(symbol, entries);

  let longUsd = 0;
  let shortUsd = 0;

  for (const e of entries) {
    if (e.side === 'SELL') longUsd += e.notionalUsd;
    else shortUsd += e.notionalUsd;
  }

  const totalUsd = longUsd + shortUsd;
  let dominance = 'neutral';
  if (totalUsd > 0) {
    if (longUsd > shortUsd) dominance = 'longs';
    else if (shortUsd > longUsd) dominance = 'shorts';
  }

  const intensity =
    totalUsd > 50_000_000 ? 'extreme' :
    totalUsd > 10_000_000 ? 'high' :
    totalUsd > 1_000_000 ? 'moderate' : 'low';

  stats.set(symbol, {
    longUsd,
    shortUsd,
    totalUsd,
    count: entries.length,
    dominance,
    intensity,
    windowHours: 4,
    lastUpdated: Date.now(),
  });
}

function pruneBuffer() {
  const cutoff = Date.now() - WINDOW_MS;
  const recentCutoff = Date.now() - 15 * 60 * 1000;
  for (const [symbol, entries] of buffer.entries()) {
    const pruned = entries.filter((e) => e.time >= cutoff);
    if (pruned.length === 0) {
      buffer.delete(symbol);
      stats.delete(symbol);
    } else {
      buffer.set(symbol, pruned);
      recomputeStats(symbol);
    }
  }
  for (const [symbol, entries] of recentTicks.entries()) {
    const pruned = entries.filter((e) => e.time >= recentCutoff);
    if (pruned.length === 0) recentTicks.delete(symbol);
    else recentTicks.set(symbol, pruned);
  }
}
