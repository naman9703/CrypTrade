/**
 * LIQ_CASCADE — liquidation cascade event-driven scalping.
 */

import { dayStore } from "./adapterPersisted.js";
import { utcDayId } from "./techniques/liquidity.js";
import {
  buildLiqCascadeSeries,
  LIQ_CASCADE_DEFAULTS,
  LIQ_CASCADE_PAD_BARS,
  LIQ_CASCADE_WARMUP,
  liqIntervalToMs,
} from "./techniques/liqCascade.js";
import {
  collectLiqCascadeBarCloseAuditEvents,
  formatLiqCascadeSkipReason,
  initLiqCascadeActivityPersisted,
  liqCascadeAdapterSkipReason,
} from "./liqCascadeActivityAudit.js";
import { LIQ_CASCADE_BTC_1M } from "./presets/liqCascadeOptimized.js";
import { readCoinalyzeLiquidations, readCoinalyzeOi } from "../backtest/data/coinalyzeIngest.js";

const LIQ_CASCADE_USER_KEYS = [
  "symbol",
  "timeframe",
  "marketMode",
  "market",
  "futuresLeverage",
  "leverage",
  "futuresLeverageMode",
  "backtestPositionSizing",
  "riskPerTrade",
  "riskPerTradeUnit",
  "liqCascadeInterval",
  "liqCascadeZScoreMin",
  "liqCascadeLookbackBars",
  "liqCascadeWindowBars",
  "liqCascadeMinDispAtr",
  "liqCascadeStrongDispAtr",
  "liqCascadeMinOiDropPct",
  "liqCascadeOiGateMode",
  "liqCascadeOiWindowBars",
  "liqCascadeConfirmMode",
  "liqCascadeConfirmLiqBars",
  "liqCascadeExhaustionDecay",
  "liqCascadeDirectionMode",
  "liqCascadeMinAtrPct",
  "liqCascadeSlBufferPct",
  "liqCascadeTpAtrMult",
  "liqCascadeTpRr",
  "liqCascadeMinRr",
  "liqCascadeMaxHoldBars",
  "liqCascadeMaxTradesPerDay",
  "liqCascadeMinBarGap",
  "liqCascadeEventCooldownLiqBars",
  "liqCascadeTradeSides",
  "liqCascadeMinLiqUsdBar",
  "liqCascadeLiveTickEnabled",
  "liqCascadeLiqSource",
  "liqCascadeOiSource",
  "intradayLiqPartialTp",
  "intradayLiqTp1Enabled",
  "intradayLiqTp2Enabled",
  "intradayLiqBreakevenAfterPartial",
  "intradayLiqEntryAtSignalClose",
];

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function resolveLiqCascadeCfg(cfg = {}) {
  const out = { ...LIQ_CASCADE_BTC_1M };
  for (const k of LIQ_CASCADE_USER_KEYS) {
    if (cfg[k] !== undefined) out[k] = cfg[k];
  }
  out.manualStrategy = "LIQ_CASCADE";
  out.strategyMode = cfg.strategyMode ?? "MANUAL";
  return out;
}

export function optsFromLiqCascadeCfg(cfg = {}) {
  const c = resolveLiqCascadeCfg(cfg);
  return {
    ...LIQ_CASCADE_DEFAULTS,
    liqInterval: String(c.liqCascadeInterval ?? LIQ_CASCADE_DEFAULTS.liqInterval),
    liqZScoreMin: num(c.liqCascadeZScoreMin, LIQ_CASCADE_DEFAULTS.liqZScoreMin),
    liqLookbackBars: num(c.liqCascadeLookbackBars, LIQ_CASCADE_DEFAULTS.liqLookbackBars),
    cascadeWindowBars: num(c.liqCascadeWindowBars, LIQ_CASCADE_DEFAULTS.cascadeWindowBars),
    minDispAtrMult: num(c.liqCascadeMinDispAtr, LIQ_CASCADE_DEFAULTS.minDispAtrMult),
    strongDispAtrMult: num(c.liqCascadeStrongDispAtr, LIQ_CASCADE_DEFAULTS.strongDispAtrMult),
    minOiDropPct: num(c.liqCascadeMinOiDropPct, LIQ_CASCADE_DEFAULTS.minOiDropPct),
    oiGateMode: String(c.liqCascadeOiGateMode ?? LIQ_CASCADE_DEFAULTS.oiGateMode).toLowerCase(),
    oiWindowBars: num(c.liqCascadeOiWindowBars, LIQ_CASCADE_DEFAULTS.oiWindowBars),
    confirmMode: String(c.liqCascadeConfirmMode ?? LIQ_CASCADE_DEFAULTS.confirmMode).toLowerCase(),
    confirmLiqBars: num(c.liqCascadeConfirmLiqBars, LIQ_CASCADE_DEFAULTS.confirmLiqBars),
    exhaustionDecayRatio: num(c.liqCascadeExhaustionDecay, LIQ_CASCADE_DEFAULTS.exhaustionDecayRatio),
    directionMode: String(c.liqCascadeDirectionMode ?? LIQ_CASCADE_DEFAULTS.directionMode),
    minAtrPct: num(c.liqCascadeMinAtrPct, LIQ_CASCADE_DEFAULTS.minAtrPct),
    slBufferPct: num(c.liqCascadeSlBufferPct, LIQ_CASCADE_DEFAULTS.slBufferPct),
    tpAtrMult: num(c.liqCascadeTpAtrMult, LIQ_CASCADE_DEFAULTS.tpAtrMult),
    tpRr: num(c.liqCascadeTpRr, LIQ_CASCADE_DEFAULTS.tpRr),
    minRr: num(c.liqCascadeMinRr, LIQ_CASCADE_DEFAULTS.minRr),
    maxHoldBars: num(c.liqCascadeMaxHoldBars, LIQ_CASCADE_DEFAULTS.maxHoldBars),
    maxTradesPerDay: num(c.liqCascadeMaxTradesPerDay, LIQ_CASCADE_DEFAULTS.maxTradesPerDay),
    minBarGap: num(c.liqCascadeMinBarGap, LIQ_CASCADE_DEFAULTS.minBarGap),
    eventCooldownLiqBars: num(c.liqCascadeEventCooldownLiqBars, LIQ_CASCADE_DEFAULTS.eventCooldownLiqBars),
    tradeSides: String(c.liqCascadeTradeSides ?? LIQ_CASCADE_DEFAULTS.tradeSides).toUpperCase(),
    minLiqUsdBar: num(c.liqCascadeMinLiqUsdBar, LIQ_CASCADE_DEFAULTS.minLiqUsdBar),
  };
}

export function liqCascadePadFromMs(fromMs, tf = "1m") {
  const tfMs =
    tf === "5m" ? 300_000 : tf === "15m" ? 900_000 : tf === "1h" ? 3_600_000 : 60_000;
  return fromMs - LIQ_CASCADE_PAD_BARS * tfMs;
}

/** Attach liq/OI series to ctx for adapter reuse across bars. */
export function attachLiqCascadeSeries(candles, cfg, ctx = {}) {
  if (ctx._liqCascadeBuilt) return ctx._liqCascadeBuilt;
  const opts = optsFromLiqCascadeCfg(cfg);
  const liqSeries = ctx.liqSeries ?? cfg._liqCascadeLiqSeries ?? [];
  const oiSeries = ctx.oiSeries ?? cfg._liqCascadeOiSeries ?? [];
  const oiIntervalMs = ctx.oiIntervalMs ?? cfg._liqCascadeOiIntervalMs ?? undefined;
  const built = buildLiqCascadeSeries(candles, { liqSeries, oiSeries, oiIntervalMs, opts });
  ctx._liqCascadeBuilt = built;
  return built;
}

/** @typedef {"coinalyze" | "force_orders" | "auto"} LiqCascadeLiqSource */

export function resolveLiqCascadeLiqSource(cfg = {}) {
  const raw = String(
    cfg.liqCascadeLiqSource ?? process.env.LIQ_SOURCE ?? process.env.LIQ_CASCADE_LIQ_SOURCE ?? "coinalyze",
  )
    .trim()
    .toLowerCase();
  if (raw === "force_orders" || raw === "ticks" || raw === "tick") return "force_orders";
  if (raw === "auto") return "auto";
  return "coinalyze";
}

/** @typedef {"coinalyze" | "binance"} LiqCascadeOiSource */
export function resolveLiqCascadeOiSource(cfg = {}) {
  const raw = String(
    cfg.liqCascadeOiSource ?? process.env.LIQ_CASCADE_OI_SOURCE ?? "binance",
  )
    .trim()
    .toLowerCase();
  if (raw === "coinalyze" || raw === "cz") return "coinalyze";
  return "binance";
}

async function loadLiqCascadeOiSeries(symbol, fromMs, toMs, cfg = {}) {
  const c = resolveLiqCascadeCfg(cfg);
  const liqInterval = String(c.liqCascadeInterval ?? "5min");
  const oiSource = resolveLiqCascadeOiSource(c);

  if (oiSource === "coinalyze") {
    const { ensureCoinalyzeOi, readCoinalyzeOi } = await import("../backtest/data/coinalyzeIngest.js");
    await ensureCoinalyzeOi(symbol, { from: fromMs, to: toMs, interval: liqInterval }).catch(() => {});
    const oiSeries = await readCoinalyzeOi(symbol, fromMs, toMs, { interval: liqInterval });
    return {
      oiSeries,
      oiIntervalMs: liqIntervalToMs(liqInterval),
      oiSource: "coinalyze",
    };
  }

  const { loadCascadeOiFromBinance } = await import("../backtest/data/openInterestIngest.js");
  const loaded = await loadCascadeOiFromBinance(symbol, fromMs, toMs, liqInterval);
  return { ...loaded, oiSource: "binance" };
}

/**
 * Aggregate persisted Binance forceOrder ticks into Coinalyze-style liq bars.
 * Zero-liq intervals are filled when fromMs/toMs are set (z-score baseline parity).
 */
export async function loadLiqCascadeForceOrderSeries(symbol, fromMs, toMs, cfg = {}) {
  const c = resolveLiqCascadeCfg(cfg);
  const interval = String(c.liqCascadeInterval ?? "5min");
  const intervalMs = liqIntervalToMs(interval);
  const { readRecentForceOrders } = await import("../intelligence/collectors/forceOrderPersist.js");
  const ticks = await readRecentForceOrders(symbol, fromMs, toMs);
  const liqSeries = aggregateTicksToLiqSeries(ticks, intervalMs, fromMs, toMs);
  return {
    liqSeries,
    oiSeries: [],
    interval,
    source: "force_orders",
    tickCount: ticks.length,
    liqBarCount: liqSeries.length,
  };
}

export async function loadLiqCascadeMarketSeries(symbol, fromMs, toMs, cfg = {}) {
  const c = resolveLiqCascadeCfg(cfg);
  const interval = String(c.liqCascadeInterval ?? "5min");
  const source = resolveLiqCascadeLiqSource(c);

  if (source === "force_orders") {
    const tickSeries = await loadLiqCascadeForceOrderSeries(symbol, fromMs, toMs, c);
    const oi = await loadLiqCascadeOiSeries(symbol, fromMs, toMs, c);
    return { ...tickSeries, ...oi };
  }

  if (source === "auto") {
    const tickProbe = await loadLiqCascadeForceOrderSeries(symbol, fromMs, toMs, c);
    const minTicks = Number(process.env.LIQ_FORCE_MIN_TICKS || 500);
    const minWeeks = Number(process.env.LIQ_FORCE_MIN_WEEKS || 1);
    const weeks =
      tickProbe.liqBarCount > 1
        ? (tickProbe.liqSeries[tickProbe.liqSeries.length - 1].ts -
            tickProbe.liqSeries[0].ts) /
          (7 * 864e5)
        : 0;
    if (tickProbe.tickCount >= minTicks && weeks >= minWeeks) {
      const oi = await loadLiqCascadeOiSeries(symbol, fromMs, toMs, c);
      return { ...tickProbe, ...oi };
    }
  }

  const { ensureCoinalyzeLiquidations } = await import("../backtest/data/coinalyzeIngest.js");
  await ensureCoinalyzeLiquidations(symbol, { from: fromMs, to: toMs, interval }).catch(() => {});
  const liqSeries = await readCoinalyzeLiquidations(symbol, fromMs, toMs, { interval });
  const oi = await loadLiqCascadeOiSeries(symbol, fromMs, toMs, c);
  return { liqSeries, ...oi, interval, source: "coinalyze" };
}

/** Load Coinalyze liq/OI into cfg for backtest adapter wiring. */
export async function hydrateLiqCascadeCfg(cfg, symbol, fromMs, toMs) {
  const c = resolveLiqCascadeCfg(cfg);
  const padFrom = liqCascadePadFromMs(fromMs, c.timeframe ?? "1m");
  const loaded = await loadLiqCascadeMarketSeries(symbol, padFrom, toMs, c);
  return {
    ...c,
    _liqCascadeLiqSeries: loaded.liqSeries,
    _liqCascadeOiSeries: loaded.oiSeries,
    _liqCascadeOiIntervalMs: loaded.oiIntervalMs ?? null,
    _liqCascadeOiSource: loaded.oiSource ?? resolveLiqCascadeOiSource(c),
    _liqCascadeInterval: loaded.interval,
    _liqCascadeLiqSource: loaded.source ?? resolveLiqCascadeLiqSource(c),
    _liqCascadeTickCount: loaded.tickCount ?? null,
  };
}

/**
 * Aggregate forceOrder ticks into Coinalyze-style liq bars (interval start ts).
 * @param {{ time: number, side: string, notionalUsd: number }[]} ticks
 * @param {number} [intervalMs]
 * @param {number|null} [fromMs] — when set with toMs, emit zero-liq bars for full grid
 * @param {number|null} [toMs]
 */
export function aggregateTicksToLiqSeries(ticks, intervalMs = 300_000, fromMs = null, toMs = null) {
  const buckets = new Map();
  for (const t of ticks ?? []) {
    const bucket = Math.floor(Number(t.time) / intervalMs) * intervalMs;
    if (!buckets.has(bucket)) buckets.set(bucket, { ts: bucket, liqLongUsd: 0, liqShortUsd: 0 });
    const row = buckets.get(bucket);
    if (t.side === "SELL") row.liqLongUsd += Number(t.notionalUsd) || 0;
    else row.liqShortUsd += Number(t.notionalUsd) || 0;
  }
  if (fromMs != null && toMs != null && Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs) {
    const start = Math.floor(fromMs / intervalMs) * intervalMs;
    const end = Math.floor(toMs / intervalMs) * intervalMs;
    for (let ts = start; ts <= end; ts += intervalMs) {
      if (!buckets.has(ts)) buckets.set(ts, { ts, liqLongUsd: 0, liqShortUsd: 0 });
    }
  }
  if (!buckets.size) return [];
  return [...buckets.values()].sort((a, b) => a.ts - b.ts);
}

export function buildLiqCascadeBacktestAdapter(candles, cfg = {}, _tf = "1m", marketCtx = {}) {
  const opts = optsFromLiqCascadeCfg(cfg);
  const liqSeries = marketCtx.liqSeries ?? [];
  const oiSeries = marketCtx.oiSeries ?? [];
  const oiIntervalMs = marketCtx.oiIntervalMs ?? cfg._liqCascadeOiIntervalMs ?? undefined;
  const { series } = buildLiqCascadeSeries(candles, { liqSeries, oiSeries, oiIntervalMs, opts });
  let lastSignalIdx = -Infinity;
  let tradesToday = 0;
  let curDay = null;
  const dayLocal = { lastSignalIdx: -Infinity, tradesToday: 0, curDay: null };

  return function liqCascadeAdapter(bar, idx, ctx) {
    if (idx < LIQ_CASCADE_WARMUP) return null;
    const dDay = dayStore(ctx, dayLocal);
    const day = utcDayId(bar.ts);
    if (day !== (ctx?.persisted ? dDay.curDay : curDay)) {
      if (ctx?.persisted) {
        dDay.curDay = day;
        dDay.tradesToday = 0;
      } else {
        curDay = day;
        tradesToday = 0;
      }
    }
    const sig = series[idx];
    if (!sig) return null;
    const tradesCount = ctx?.persisted ? dDay.tradesToday : tradesToday;
    if (tradesCount >= opts.maxTradesPerDay) return null;
    const lastIdx = ctx?.persisted ? dDay.lastSignalIdx : lastSignalIdx;
    if (idx - lastIdx < opts.minBarGap) return null;

    if (ctx?.persisted) {
      dDay.lastSignalIdx = idx;
      dDay.tradesToday = tradesCount + 1;
    } else {
      lastSignalIdx = idx;
      tradesToday += 1;
    }
    return {
      action: sig.action,
      reason: sig.reason,
      trigger: sig.trigger,
      playbook: sig.playbook,
      liqBrackets: sig.liqBrackets,
    };
  };
}

export function signal({ candles, cfg, liqSeries, oiSeries } = {}) {
  if (!candles?.length) return { action: "HOLD", reason: "no_candles" };
  const opts = optsFromLiqCascadeCfg(cfg || {});
  const idx = candles.length - 1;
  const { series } = buildLiqCascadeSeries(candles, {
    liqSeries: liqSeries ?? [],
    oiSeries: oiSeries ?? [],
    opts,
  });
  const sig = series[idx];
  if (!sig) return { action: "HOLD", reason: "liq_cascade_no_setup" };
  return {
    action: sig.action,
    reason: sig.reason,
    trigger: sig.trigger,
    playbook: sig.playbook,
    liqBrackets: sig.liqBrackets,
  };
}

export const LIQ_CASCADE = {
  name: "LIQ CASCADE — liquidation event scalping (fade forced flow)",
  signal,
};

export function liqCascadeActivityPersistedFor(state, symU) {
  const sym = String(symU || "").toUpperCase();
  if (!state._liqCascadeActivityPersisted) state._liqCascadeActivityPersisted = Object.create(null);
  if (!state._liqCascadeActivityPersisted[sym]) {
    state._liqCascadeActivityPersisted[sym] = initLiqCascadeActivityPersisted();
  }
  return state._liqCascadeActivityPersisted[sym];
}

function readLiqCascadeAdapterPersisted(state, symU) {
  const sym = String(symU || "").toUpperCase();
  return state._liveStrategyPersisted?.[sym]?.LIQ_CASCADE ?? null;
}

/**
 * Bar-close liq series: merge WS memory ticks with DB archive so z-score baseline
 * works immediately after bot start (not only ticks since WS connected).
 */
export async function loadLiqCascadeBarCloseLiqSeries(symU, barTs, cfg = {}) {
  const opts = optsFromLiqCascadeCfg(cfg);
  const intervalMs = liqIntervalToMs(opts.liqInterval ?? LIQ_CASCADE_DEFAULTS.liqInterval);
  const lookbackBars = num(opts.liqLookbackBars, LIQ_CASCADE_DEFAULTS.liqLookbackBars);
  const ts = Number(barTs);
  if (!Number.isFinite(ts)) {
    return { liqSeries: [], intervalMs, opts, fromMs: 0, toMs: 0, tickCount: 0 };
  }
  const padMs = (lookbackBars + 10) * intervalMs;
  const fromMs = ts - padMs;
  const toMs = ts + intervalMs;

  const { getRecentLiquidations } = await import("../intelligence/collectors/liquidationCollector.js");
  const memTicks = getRecentLiquidations(symU, padMs + intervalMs * 5);

  let dbTicks = [];
  try {
    const { readRecentForceOrders } = await import("../intelligence/collectors/forceOrderPersist.js");
    dbTicks = await readRecentForceOrders(symU, fromMs, toMs);
  } catch {
    /* DB optional — fall back to memory ticks only */
  }

  const merged = new Map();
  for (const t of [...dbTicks, ...memTicks]) {
    const key = `${t.time}|${t.side}|${t.price ?? ""}|${t.notionalUsd ?? ""}`;
    merged.set(key, t);
  }
  const ticks = [...merged.values()].sort((a, b) => a.time - b.time);
  const liqSeries = aggregateTicksToLiqSeries(ticks, intervalMs, fromMs, toMs);
  return { liqSeries, intervalMs, opts, fromMs, toMs, tickCount: ticks.length };
}

/**
 * Evaluate gate / confirm / bracket / adapter skips for Activity on bar close.
 * @returns {Promise<object[]>}
 */
export async function auditLiqCascadeBarCloseForActivity(state, { candles, barIdx, symU }) {
  if (barIdx < LIQ_CASCADE_WARMUP) return [];
  const barTs = Number(candles[barIdx]?.ts);
  if (!Number.isFinite(barTs)) return [];

  const { liqSeries, opts, fromMs, intervalMs } = await loadLiqCascadeBarCloseLiqSeries(symU, barTs, state);

  let oiSeries = [];
  let oiIntervalMs;
  try {
    const oi = await loadLiqCascadeOiSeries(symU, fromMs, barTs + intervalMs, state);
    oiSeries = oi.oiSeries ?? [];
    oiIntervalMs = oi.oiIntervalMs;
  } catch {
    /* OI optional — gate will fail with no data */
  }

  const persisted = liqCascadeActivityPersistedFor(state, symU);
  const events = collectLiqCascadeBarCloseAuditEvents(persisted, candles, barIdx, {
    liqSeries,
    oiSeries,
    oiIntervalMs,
    opts,
  });

  const { series } = buildLiqCascadeSeries(candles, { liqSeries, oiSeries, oiIntervalMs, opts });
  const sig = series[barIdx];
  if (sig) {
    const adapterReason = liqCascadeAdapterSkipReason(readLiqCascadeAdapterPersisted(state, symU), barIdx, opts);
    if (adapterReason) {
      const dedupeKey = `adapter_skip:${barTs}:${adapterReason}`;
      if (!persisted.emittedKeys[dedupeKey]) {
        persisted.emittedKeys[dedupeKey] = true;
        events.push({
          type: "adapter_skip",
          reasonCode: adapterReason,
          liqBarTs: barTs,
          fadeAction: sig.action,
          liqUsd: sig.liqUsd,
          confirmTier: sig.confirmTier,
          z: sig.liqZ,
          dispAtr: sig.dispAtr,
          oiDropPct: sig.oiDropPct,
        });
      }
    }
  }

  for (const ev of events) {
    ev.reason = formatLiqCascadeSkipReason(ev);
  }
  return events;
}
