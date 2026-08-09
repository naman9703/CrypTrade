/**
 * Unified live microstructure snapshot per symbol (MICRO_EVENT + intel).
 * Coalesced read model — sources update independently; consumers poll or subscribe.
 */
import { EventEmitter } from "events";
import { getRecentLiquidations } from "../../intelligence/collectors/liquidationCollector.js";
import { getAggTradeRollingMetrics } from "../../intelligence/collectors/aggTradeRolling.js";
import { intelligenceCache, getOpenInterestFetchedAt } from "../../intelligence/index.js";
import { orderBookCollector } from "../../intelligence/collectors/orderBookCollector.js";
import { getActiveMicroEventCalendarWindows } from "./microEventCalendar.js";
import { oiDeltaPctFromHistory } from "./openInterestHistory.js";

export const microstructureSnapshotEvents = new EventEmitter();
microstructureSnapshotEvents.setMaxListeners(30);

function normSym(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * Compute liq metrics from recent forceOrder ticks.
 * @param {string} symbol
 * @param {number} windowMs
 * @param {number} [domRatio]
 * @param {{ quietMs?: number, nowMs?: number }} [extra]
 */
export function computeLiqMetricsFromTicks(symbol, windowMs, domRatio = 1.2, extra = {}) {
  const nowMs = extra.nowMs ?? Date.now();
  const quietMs = Math.max(60_000, Number(extra.quietMs) || 900_000);
  const ticks = getRecentLiquidations(symbol, windowMs);
  let longUsd = 0;
  let shortUsd = 0;
  for (const t of ticks) {
    if (t.side === "SELL") longUsd += t.notionalUsd;
    else shortUsd += t.notionalUsd;
  }
  const totalUsd = longUsd + shortUsd;
  const rateUsdPerMin = windowMs > 0 ? (totalUsd / windowMs) * 60_000 : 0;
  let dom = "neutral";
  if (longUsd > shortUsd * domRatio) dom = "longs";
  else if (shortUsd > longUsd * domRatio) dom = "shorts";

  const priorTicks = getRecentLiquidations(symbol, windowMs * 2).filter(
    (t) => t.time < nowMs - windowMs,
  );
  let pLong = 0;
  let pShort = 0;
  for (const t of priorTicks) {
    if (t.side === "SELL") pLong += t.notionalUsd;
    else pShort += t.notionalUsd;
  }
  const priorTotal = pLong + pShort;
  const zLike = priorTotal > 0 ? totalUsd / priorTotal : totalUsd > 0 ? 2 : 0;
  const lastTickMs = ticks.length ? ticks[ticks.length - 1].time : null;

  /** Cascade extreme for SL: long-liq → max price; short-liq → min price. */
  let liqExtremePrice = null;
  if (dom === "longs" || dom === "shorts") {
    const relevant = ticks.filter((t) => (dom === "longs" ? t.side === "SELL" : t.side === "BUY"));
    const prices = relevant.map((t) => Number(t.price)).filter((p) => p > 0);
    if (prices.length) {
      liqExtremePrice = dom === "longs" ? Math.max(...prices) : Math.min(...prices);
    }
  }

  const quietSpan = windowMs + quietMs;
  const quietTicks = getRecentLiquidations(symbol, quietSpan).filter(
    (t) => t.time >= nowMs - windowMs - quietMs && t.time < nowMs - windowMs,
  );
  let liqQuietPriorUsd = 0;
  const quietBuckets = new Map();
  for (const t of quietTicks) {
    const usd = Number(t.notionalUsd) || 0;
    liqQuietPriorUsd += usd;
    const bucket = Math.floor(Number(t.time) / 60_000) * 60_000;
    quietBuckets.set(bucket, (quietBuckets.get(bucket) || 0) + usd);
  }
  let liqQuietPriorMaxBarUsd = 0;
  for (const v of quietBuckets.values()) {
    if (v > liqQuietPriorMaxBarUsd) liqQuietPriorMaxBarUsd = v;
  }

  return {
    liqLongUsd: longUsd,
    liqShortUsd: shortUsd,
    liqTotalUsd: totalUsd,
    liqRateUsdPerMin: rateUsdPerMin,
    liqDom: dom,
    liqZLike: zLike,
    lastLiqTickMs: lastTickMs,
    liqTickCount: ticks.length,
    liqExtremePrice,
    liqQuietPriorUsd,
    liqQuietPriorMaxBarUsd,
  };
}

/**
 * Build full snapshot for one symbol.
 * @param {string} symbol
 * @param {{ liqWindowSec?: number, domRatio?: number, nowMs?: number }} [opts]
 */
export function buildMicrostructureSnapshot(symbol, opts = {}) {
  const sym = normSym(symbol);
  const nowMs = opts.nowMs ?? Date.now();
  const liqWindowMs = Math.max(10_000, num(opts.liqWindowSec, 90) * 1000);
  const domRatio = num(opts.domRatio, 1.2);
  const quietMs = Math.max(60_000, num(opts.cascadeQuietSec, 900) * 1000);

  const liq = computeLiqMetricsFromTicks(sym, liqWindowMs, domRatio, { quietMs, nowMs });

  const oiRow = intelligenceCache.openInterest?.[sym];
  // openInterestCollector stores `.usdt`; legacy keys kept for back-compat.
  const oi = num(oiRow?.usdt ?? oiRow?.current ?? oiRow?.openInterest ?? oiRow?.oi, 0);
  // OI delta samples are recorded on REST poll (ensureOpenInterestForSymbols), not here.

  const bookData = orderBookCollector.collect([sym], intelligenceCache)[sym] ?? null;

  const agg = getAggTradeRollingMetrics(sym, nowMs);

  const funding = intelligenceCache.funding?.[sym] ?? null;

  const calendar = getActiveMicroEventCalendarWindows(nowMs, sym);

  return {
    symbol: sym,
    tsMs: nowMs,
    ...liq,
    oi,
    oiDeltaPct1m: oiDeltaPctFromHistory(sym, 60_000, nowMs),
    oiDeltaPct5m: oiDeltaPctFromHistory(sym, 300_000, nowMs),
    oiFetchedAt: getOpenInterestFetchedAt(sym),
    bookImbalance: bookData?.imbalanceRatio ?? null,
    bidWallUsd: bookData?.bidWallUsdt ?? null,
    askWallUsd: bookData?.askWallUsdt ?? null,
    bookPressure: bookData?.pressure ?? "neutral",
    cvdUsd60s: agg.cvdUsd60s,
    aggressiveBuyUsd60s: agg.buyUsd60s,
    aggressiveSellUsd60s: agg.sellUsd60s,
    cvdSlope60s: agg.cvdSlope60s,
    aggTradeLastTickMs: agg.lastTickMs,
    lastPrice: agg.lastPrice ?? null,
    fundingRate: funding?.current ?? null,
    fundingZ: funding?.zscore ?? null,
    crowdedSide: funding?.bias ?? "neutral",
    calendarActive: calendar.length > 0,
    calendarEvents: calendar,
  };
}

/** @type {Map<string, object>} */
const lastSnapshot = new Map();

export function getMicrostructureSnapshot(symbol, opts = {}) {
  const sym = normSym(symbol);
  const snap = buildMicrostructureSnapshot(sym, opts);
  lastSnapshot.set(sym, snap);
  return snap;
}

export function getCachedMicrostructureSnapshot(symbol) {
  return lastSnapshot.get(normSym(symbol)) ?? null;
}

export function refreshMicrostructureSnapshots(symbols, opts = {}) {
  const out = {};
  for (const s of symbols ?? []) {
    const sym = normSym(s);
    if (!sym) continue;
    out[sym] = getMicrostructureSnapshot(sym, opts);
  }
  microstructureSnapshotEvents.emit("refresh", out);
  return out;
}

let coalesceTimer = null;
/** @type {Set<string>} */
let watchSymbols = new Set();

export function setMicrostructureWatchSymbols(symbols) {
  watchSymbols = new Set((symbols ?? []).map(normSym).filter(Boolean));
}

export function startMicrostructureSnapshotCoalescer(intervalMs = 500, opts = {}) {
  stopMicrostructureSnapshotCoalescer();
  coalesceTimer = setInterval(() => {
    if (!watchSymbols.size) return;
    refreshMicrostructureSnapshots([...watchSymbols], opts);
  }, intervalMs);
  coalesceTimer.unref?.();
}

export function stopMicrostructureSnapshotCoalescer() {
  if (coalesceTimer) {
    clearInterval(coalesceTimer);
    coalesceTimer = null;
  }
}

/** Subscribe to coalesced snapshot refreshes. Returns unsubscribe fn. */
export function subscribeMicrostructureUpdates(cb) {
  if (typeof cb !== "function") return () => {};
  const handler = (payload) => cb(payload);
  microstructureSnapshotEvents.on("refresh", handler);
  return () => microstructureSnapshotEvents.off("refresh", handler);
}

/** Back-compat stub replacement */
export async function fetchMarketIntelSnapshot(opts = {}) {
  const sym = normSym(opts.symbol);
  if (!sym) return { ok: false, reason: "no_symbol" };
  const snap = getMicrostructureSnapshot(sym, opts);
  return { ok: true, snapshot: snap };
}

export function passesMarketIntelFilter(_opts, _side) {
  return true;
}
