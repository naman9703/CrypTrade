/**
 * Live tick-driven LIQ_CASCADE executor (paper-first).
 * Subscribes to Binance forceOrder stream; fires on cascade exhaustion.
 */
import { EventEmitter } from "events";
import {
  liquidationEvents,
  getRecentLiquidations,
} from "../intelligence/collectors/liquidationCollector.js";
import {
  createCascadeTickTracker,
  evaluateCascadeTickSignal,
  updateCascadeFromTick,
} from "../strategy/techniques/liqCascade.js";
import { optsFromLiqCascadeCfg, resolveLiqCascadeCfg } from "../strategy/liqCascadeIntraday.js";

/** @type {import('events').EventEmitter} */
export const liqCascadeLiveEvents = new EventEmitter();
liqCascadeLiveEvents.setMaxListeners(10);

/** @type {Map<string, ReturnType<typeof createCascadeTickTracker>>} */
const trackers = new Map();

let running = false;
let onForceOrder = null;
/** @type {{ getState: () => object, onSignal: (payload: object) => Promise<void>, log?: object } | null} */
let hooks = null;
/** @type {ReturnType<typeof setInterval> | null} */
let cooldownSweep = null;

const lastFireBySymbol = new Map();
const COOLDOWN_MS = 60_000;

function paperAllowed(state) {
  if (state?.liqCascadeLiveTickEnabled !== true) return false;
  if (String(state?.manualStrategy ?? "").toUpperCase() !== "LIQ_CASCADE") return false;
  const mode = String(state?.tradingMode ?? state?.mode ?? "").toUpperCase();
  if (mode === "BINANCE_LIVE" && process.env.LIQ_CASCADE_LIVE_ALLOW !== "1") return false;
  return Boolean(state?.running);
}

function trackerFor(symbol, cfg) {
  const sym = String(symbol).toUpperCase();
  if (!trackers.has(sym)) {
    trackers.set(sym, createCascadeTickTracker(optsFromLiqCascadeCfg(cfg)));
  }
  return trackers.get(sym);
}

async function handleForceOrder(event) {
  if (!hooks || !running) return;
  const state = hooks.getState?.() ?? {};
  if (!paperAllowed(state)) return;

  const sym = String(event.symbol ?? "").toUpperCase();
  const watch = String(state.symbol ?? "").toUpperCase();
  const watchList = Array.isArray(state.symbols) ? state.symbols.map((s) => String(s).toUpperCase()) : [];
  if (sym !== watch && !watchList.includes(sym)) return;

  const cfg = resolveLiqCascadeCfg(state);
  const tracker = trackerFor(sym, cfg);
  const upd = updateCascadeFromTick(tracker, event);
  if (!upd.exhausted) return;

  const lastFire = lastFireBySymbol.get(sym) ?? 0;
  if (Date.now() - lastFire < COOLDOWN_MS) return;

  const price = Number(event.price ?? 0);
  const sig = evaluateCascadeTickSignal(tracker, price);
  if (!sig) return;

  lastFireBySymbol.set(sym, Date.now());
  const payload = {
    symbol: sym,
    ...sig,
    source: "tick",
    eventTime: event.time,
    recentTicks: getRecentLiquidations(sym, 5 * 60_000).length,
  };

  liqCascadeLiveEvents.emit("signal", payload);
  hooks.log?.info?.("liq_cascade_tick_signal", {
    symbol: sym,
    action: sig.action,
    reason: sig.reason,
  });

  try {
    await hooks.onSignal(payload);
  } catch (err) {
    hooks.log?.warn?.("liq_cascade_tick_signal_failed", { error: String(err?.message || err) });
  }
}

/**
 * @param {{ getState: () => object, onSignal: (p: object) => Promise<void>, log?: object }} h
 */
export function startLiqCascadeLiveEngine(h) {
  if (running) stopLiqCascadeLiveEngine();
  hooks = h;
  running = true;
  onForceOrder = (ev) => {
    void handleForceOrder(ev);
  };
  liquidationEvents.on("forceOrder", onForceOrder);
  cooldownSweep = setInterval(() => {
    const cutoff = Date.now() - 15 * 60_000;
    for (const [sym, t] of trackers.entries()) {
      t.ticks = t.ticks.filter((x) => x.time >= cutoff);
      if (!t.ticks.length) trackers.delete(sym);
    }
  }, 60_000);
  cooldownSweep.unref?.();
  hooks.log?.info?.("liq_cascade_live_engine_started", {});
}

export function stopLiqCascadeLiveEngine() {
  running = false;
  if (onForceOrder) {
    liquidationEvents.off("forceOrder", onForceOrder);
    onForceOrder = null;
  }
  if (cooldownSweep) {
    clearInterval(cooldownSweep);
    cooldownSweep = null;
  }
  trackers.clear();
  lastFireBySymbol.clear();
  hooks = null;
}

export function isLiqCascadeLiveEngineRunning() {
  return running;
}
