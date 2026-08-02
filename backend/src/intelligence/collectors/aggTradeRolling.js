/**
 * Rolling sub-minute aggTrade buy/sell USD + CVD slope (MICRO_EVENT live path).
 */
import { EventEmitter } from "events";

/** @typedef {{ time: number, price: number, qty: number, notionalUsd: number, side: 'buy'|'sell' }} AggTick */

export const aggTradeRollingEvents = new EventEmitter();
aggTradeRollingEvents.setMaxListeners(20);

/** @type {Map<string, AggTick[]>} */
const ticksBySymbol = new Map();

const MAX_TICKS_PER_SYM = 8000;
const PRUNE_MS = 5 * 60_000;

function normSym(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

/**
 * @param {string} symbol
 * @param {{ T?: number, p?: string|number, q?: string|number, m?: boolean }} msg — Binance aggTrade
 */
export function ingestAggTradeMessage(symbol, msg) {
  const sym = normSym(symbol);
  if (!sym) return;
  const ts = Number(msg?.T ?? Date.now());
  const price = Number(msg?.p ?? 0);
  const qty = Number(msg?.q ?? 0);
  if (!(price > 0) || !(qty > 0)) return;
  const notionalUsd = price * qty;
  const side = msg?.m === true ? "sell" : "buy";
  const tick = { time: ts, price, qty, notionalUsd, side };
  let arr = ticksBySymbol.get(sym);
  if (!arr) {
    arr = [];
    ticksBySymbol.set(sym, arr);
  }
  arr.push(tick);
  if (arr.length > MAX_TICKS_PER_SYM) arr.splice(0, arr.length - MAX_TICKS_PER_SYM);
  aggTradeRollingEvents.emit("tick", { symbol: sym, tick });
}

function sumWindow(arr, windowMs, now = Date.now()) {
  const cutoff = now - windowMs;
  let buyUsd = 0;
  let sellUsd = 0;
  for (const t of arr) {
    if (t.time < cutoff) continue;
    if (t.side === "buy") buyUsd += t.notionalUsd;
    else sellUsd += t.notionalUsd;
  }
  return { buyUsd, sellUsd, cvdUsd: buyUsd - sellUsd };
}

function cvdSlope(arr, windowMs, now = Date.now()) {
  const half = windowMs / 2;
  const recent = sumWindow(arr, half, now);
  const prior = sumWindow(arr.filter((t) => t.time < now - half), half, now - half);
  const recentCvd = recent.cvdUsd;
  const priorCvd = prior.cvdUsd;
  return recentCvd - priorCvd;
}

/**
 * @param {string} symbol
 * @param {number} [nowMs]
 */
export function getAggTradeRollingMetrics(symbol, nowMs = Date.now()) {
  const sym = normSym(symbol);
  const arr = ticksBySymbol.get(sym) ?? [];
  const w30 = sumWindow(arr, 30_000, nowMs);
  const w60 = sumWindow(arr, 60_000, nowMs);
  const w180 = sumWindow(arr, 180_000, nowMs);
  return {
    symbol: sym,
    buyUsd30s: w30.buyUsd,
    sellUsd30s: w30.sellUsd,
    cvdUsd30s: w30.cvdUsd,
    buyUsd60s: w60.buyUsd,
    sellUsd60s: w60.sellUsd,
    cvdUsd60s: w60.cvdUsd,
    buyUsd180s: w180.buyUsd,
    sellUsd180s: w180.sellUsd,
    cvdUsd180s: w180.cvdUsd,
    cvdSlope60s: cvdSlope(arr, 60_000, nowMs),
    tickCount: arr.filter((t) => t.time >= nowMs - 180_000).length,
    lastTickMs: arr.length ? arr[arr.length - 1].time : null,
    lastPrice: arr.length ? arr[arr.length - 1].price : null,
  };
}

export function pruneAggTradeRolling(nowMs = Date.now()) {
  const cutoff = nowMs - PRUNE_MS;
  for (const [sym, arr] of ticksBySymbol.entries()) {
    const next = arr.filter((t) => t.time >= cutoff);
    if (next.length) ticksBySymbol.set(sym, next);
    else ticksBySymbol.delete(sym);
  }
}

let pruneTimer = null;

export function startAggTradeRollingMaintenance() {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => pruneAggTradeRolling(), 60_000);
  pruneTimer.unref?.();
}

export function stopAggTradeRollingMaintenance() {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}
