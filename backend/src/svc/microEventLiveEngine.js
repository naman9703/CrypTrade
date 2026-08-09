/**
 * Live tick-driven MICRO_EVENT executor — spike + confluence, continuation default.
 */
import { EventEmitter } from "events";
import { liquidationEvents } from "../intelligence/collectors/liquidationCollector.js";
import { aggTradeRollingEvents } from "../intelligence/collectors/aggTradeRolling.js";
import {
  getMicrostructureSnapshot,
  refreshMicrostructureSnapshots,
  setMicrostructureWatchSymbols,
  startMicrostructureSnapshotCoalescer,
  stopMicrostructureSnapshotCoalescer,
} from "../strategy/data/microstructureSnapshot.js";
import { evaluateMicroEventFromSnapshot, formatMicroEventSkipReason } from "../strategy/techniques/microEvent.js";
import { resolveMicroEventCfg } from "../strategy/microEventIntraday.js";
import { ensureOpenInterestForSymbols } from "../intelligence/index.js";

export const microEventLiveEvents = new EventEmitter();
microEventLiveEvents.setMaxListeners(10);

const SYM_RE = /^[A-Z0-9]+USDT$/;
/** @type {Map<string, number>} */
const lastFireBySymbol = new Map();
/** @type {Map<string, number>} */
const tradesThisHour = new Map();
/**
 * Tick-driven eval fires on every aggTrade (many/sec on BTCUSDT); liq/OI/CVD gate inputs only
 * change on the order of the liq/CVD windows (~seconds-to-minutes), so consecutive ticks almost
 * always produce the *same* skip reason. Throttle skip telemetry per symbol so the Activity feed
 * (and its synchronous disk-append) isn't hammered dozens of times per second with duplicates.
 * @type {Map<string, { ts: number, reason: string }>}
 */
const lastSkipEmitBySymbol = new Map();
const SKIP_EMIT_MIN_INTERVAL_MS = 15_000;
/** @type {Map<string, Promise<void>>} — serialize concurrent eval per symbol */
const evalChainBySymbol = new Map();

let running = false;
let hooks = null;
let onForceOrder = null;
let onAggTick = null;

export function resolveMicroEventWatchSymbols(state) {
  const norm = (s) => String(s || "").trim().toUpperCase();
  const isMultiple = String(state?.universeCoinSelectMode || "").toUpperCase() === "MULTIPLE";
  const custom = Array.isArray(state?.universeCustomSymbols)
    ? [...new Set(state.universeCustomSymbols.map(norm).filter((s) => SYM_RE.test(s)))]
    : [];
  if (isMultiple && custom.length > 0) return custom;
  const legacy = Array.isArray(state?.symbols)
    ? [...new Set(state.symbols.map(norm).filter((s) => SYM_RE.test(s)))]
    : [];
  if (legacy.length > 0) return legacy;
  const primary = norm(state?.symbol ?? "");
  return SYM_RE.test(primary) ? [primary] : [];
}

function paperAllowed(state) {
  if (state?.microEventLiveTickEnabled === false) return false;
  if (String(state?.manualStrategy ?? "").toUpperCase() !== "MICRO_EVENT") return false;
  const mode = String(state?.tradingMode ?? state?.mode ?? "").toUpperCase();
  if (mode === "BINANCE_LIVE" && process.env.MICRO_EVENT_LIVE_ALLOW !== "1") return false;
  return Boolean(state?.running);
}

function hourBucket(now = Date.now()) {
  return Math.floor(now / 3_600_000);
}

function recordTrade(sym) {
  const key = `${sym}:${hourBucket()}`;
  tradesThisHour.set(key, (tradesThisHour.get(key) ?? 0) + 1);
}

/** Defense-in-depth frequency gate (also checked in trySupertrendFuturesOrder). */
export function checkMicroEventFrequencyGate(sym, cfg, nowMs = Date.now()) {
  const cooldownMs = Math.max(0, Number(cfg?.microEventCooldownSec ?? 45) * 1000);
  const lastFire = lastFireBySymbol.get(sym) ?? 0;
  if (nowMs - lastFire < cooldownMs) {
    return { ok: false, reason: "cooldown", cooldownRemainingMs: cooldownMs - (nowMs - lastFire) };
  }
  const maxPerHour = Number(cfg?.microEventMaxTradesPerHour ?? 12);
  const key = `${sym}:${hourBucket(nowMs)}`;
  const count = tradesThisHour.get(key) ?? 0;
  if (count >= maxPerHour) {
    return { ok: false, reason: "max_trades_per_hour", tradesThisHour: count, maxPerHour };
  }
  return { ok: true, tradesThisHour: count, maxPerHour };
}

async function evaluateAndMaybeFire(sym, triggerPrice, triggerSource, triggerEventTimeMs) {
  if (!hooks || !running) return;
  const state = hooks.getState?.() ?? {};
  if (!paperAllowed(state)) return;

  const watchSet = new Set(resolveMicroEventWatchSymbols(state));
  if (!watchSet.has(sym)) return;

  const cfg = resolveMicroEventCfg(state);
  const freq = checkMicroEventFrequencyGate(sym, cfg);
  if (!freq.ok) return;

  const snapshot = getMicrostructureSnapshot(sym, {
    liqWindowSec: cfg.microEventLiqWindowSec,
    domRatio: cfg.microEventLiqDomRatio,
    cascadeQuietSec: cfg.microEventCascadeQuietSec,
  });
  snapshot.lastPrice = triggerPrice > 0 ? triggerPrice : snapshot.lastPrice;

  const evalStartedAt = Date.now();
  const ev = evaluateMicroEventFromSnapshot(snapshot, cfg, triggerPrice);
  const evalMs = Date.now() - evalStartedAt;
  const triggerTs =
    Number.isFinite(Number(triggerEventTimeMs)) && Number(triggerEventTimeMs) > 0
      ? Number(triggerEventTimeMs)
      : evalStartedAt;

  if (!ev.action) {
    const skipReason = formatMicroEventSkipReason(ev.audit);
    const lastSkip = lastSkipEmitBySymbol.get(sym);
    const nowMs = Date.now();
    const shouldEmit =
      !lastSkip || lastSkip.reason !== skipReason || nowMs - lastSkip.ts >= SKIP_EMIT_MIN_INTERVAL_MS;
    if (shouldEmit) {
      lastSkipEmitBySymbol.set(sym, { ts: nowMs, reason: skipReason });
      microEventLiveEvents.emit("skip", { symbol: sym, audit: ev.audit, source: triggerSource });
      hooks.log?.info?.("micro_event_skip", {
        symbol: sym,
        reason: skipReason,
        source: triggerSource,
        evalMs,
      });
    }
    return;
  }

  const payload = {
    symbol: sym,
    action: ev.action,
    reason: ev.reason,
    trigger: ev.trigger,
    playbook: "MICRO_EVENT",
    confluenceScore: ev.confluenceScore,
    layers: ev.layers,
    hits: ev.hits,
    liqBrackets: ev.liqBrackets,
    source: triggerSource,
    triggerEventTimeMs: triggerTs,
    evalMs,
    /** @deprecated CPU eval time only — use triggerEventTimeMs + tickToOrderLagMs for true latency */
    signalLagMs: evalMs,
    snapshot,
  };

  // Reserve frequency slot before await onSignal — prevents stacked fires while placeOrder is in flight.
  lastFireBySymbol.set(sym, Date.now());
  recordTrade(sym);

  microEventLiveEvents.emit("signal", payload);
  hooks.log?.info?.("micro_event_tick_signal", {
    symbol: sym,
    action: ev.action,
    score: ev.confluenceScore,
    source: triggerSource,
    evalMs,
    triggerEventTimeMs: triggerTs,
  });

  try {
    const res = await hooks.onSignal(payload);
    if (res?.action === "placed") {
      const tickToOrderLagMs = Date.now() - triggerTs;
      hooks.log?.info?.("micro_event_order_placed", {
        symbol: sym,
        action: ev.action,
        tickToOrderLagMs,
        evalMs,
        source: triggerSource,
      });
    } else {
      // Roll back reservation if exchange skipped (cooldown still applies lightly via lastFire).
      hooks.log?.info?.("micro_event_tick_order_skipped", {
        symbol: sym,
        reason: res?.reason,
        action: ev.action,
      });
    }
  } catch (err) {
    hooks.log?.warn?.("micro_event_tick_signal_failed", { error: String(err?.message || err) });
  }
}

async function handleForceOrder(event) {
  const sym = String(event.symbol ?? "").toUpperCase();
  const price = Number(event.price ?? 0);
  const eventTimeMs = Number(event.time ?? event.T ?? Date.now());
  const prev = evalChainBySymbol.get(sym) ?? Promise.resolve();
  const next = prev
    .then(() => evaluateAndMaybeFire(sym, price, "forceOrder", eventTimeMs))
    .catch(() => {});
  evalChainBySymbol.set(sym, next);
  await next;
}

async function handleAggTrade({ symbol, tick }) {
  const sym = String(symbol ?? "").toUpperCase();
  const eventTimeMs = Number(tick?.time ?? Date.now());
  const prev = evalChainBySymbol.get(sym) ?? Promise.resolve();
  const next = prev
    .then(() => evaluateAndMaybeFire(sym, Number(tick?.price ?? 0), "aggTrade", eventTimeMs))
    .catch(() => {});
  evalChainBySymbol.set(sym, next);
  await next;
}

/**
 * @param {{ getState: () => object, onSignal: (p: object) => Promise<void>, log?: object }} h
 */
export function startMicroEventLiveEngine(h) {
  if (running) stopMicroEventLiveEngine();
  hooks = h;
  running = true;

  const state = hooks.getState?.() ?? {};
  const watch = resolveMicroEventWatchSymbols(state);
  setMicrostructureWatchSymbols(watch);
  startMicrostructureSnapshotCoalescer(500, {
    liqWindowSec: state.microEventLiqWindowSec,
    domRatio: state.microEventLiqDomRatio,
  });
  void ensureOpenInterestForSymbols(watch).catch(() => {});
  refreshMicrostructureSnapshots(watch);

  onForceOrder = (ev) => {
    void handleForceOrder(ev);
  };
  onAggTick = (ev) => {
    void handleAggTrade(ev);
  };
  liquidationEvents.on("forceOrder", onForceOrder);
  aggTradeRollingEvents.on("tick", onAggTick);

  hooks.log?.info?.("micro_event_live_engine_started", { watch });
}

export function stopMicroEventLiveEngine() {
  running = false;
  if (onForceOrder) {
    liquidationEvents.off("forceOrder", onForceOrder);
    onForceOrder = null;
  }
  if (onAggTick) {
    aggTradeRollingEvents.off("tick", onAggTick);
    onAggTick = null;
  }
  stopMicrostructureSnapshotCoalescer();
  lastFireBySymbol.clear();
  lastSkipEmitBySymbol.clear();
  evalChainBySymbol.clear();
  hooks = null;
}

export function isMicroEventLiveEngineRunning() {
  return running;
}

export function getMicroEventEngineState() {
  return {
    running,
    lastFireBySymbol: Object.fromEntries(lastFireBySymbol),
    tradesThisHour: Object.fromEntries(tradesThisHour),
  };
}
