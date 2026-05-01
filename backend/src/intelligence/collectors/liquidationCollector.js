import WebSocket from 'ws';

const STREAM_URL =
  String(process.env.BINANCE_FUTURES_LIQUIDATIONS_WS_URL || '').trim() ||
  'wss://fstream.binance.com/ws/!forceOrder@arr';
const WINDOW_MS = 4 * 60 * 60 * 1000;
const RECONNECT_DELAY_MS = 5000;

/** @typedef {{ time: number, side: string, notionalUsd: number }} LiqEntry */

/** @type {Map<string, LiqEntry[]>} */
const buffer = new Map();

/** @type {Map<string, Record<string, unknown>>} */
const stats = new Map();

let ws = null;
let running = false;
let reconnectTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let pruneTimer = null;

export function startLiquidationStream() {
  if (running) return;
  running = true;
  connect();
  pruneTimer = setInterval(pruneBuffer, 5 * 60 * 1000);
  pruneTimer.unref?.();
  console.log('[liquidations] Binance forceOrder stream starting...');
}

export function stopLiquidationStream() {
  running = false;
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

function connect() {
  if (!running) return;
  try {
    ws = new WebSocket(STREAM_URL);

    ws.on('open', () => {
      console.log('[liquidations] Connected to Binance forceOrder stream');
    });

    ws.on('message', (raw) => {
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
      console.warn(`[liquidations] Stream closed (${code}). Reconnecting in ${RECONNECT_DELAY_MS}ms`);
      ws = null;
      if (running) reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    });

    ws.on('error', (err) => {
      console.warn('[liquidations] Stream error:', err?.message || err);
    });
  } catch (err) {
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
  const notionalUsd = qty * price;

  if (!symbol || !Number.isFinite(notionalUsd) || notionalUsd < 1) return;
  if (side !== 'SELL' && side !== 'BUY') return;

  if (!buffer.has(symbol)) buffer.set(symbol, []);
  buffer.get(symbol).push({ time, side, notionalUsd });

  recomputeStats(symbol);
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
}
