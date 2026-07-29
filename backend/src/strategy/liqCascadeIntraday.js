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
} from "./techniques/liqCascade.js";
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
  "liqCascadeMinOiDropPct",
  "liqCascadeExhaustionDecay",
  "liqCascadeDirectionMode",
  "liqCascadeMinAtrPct",
  "liqCascadeSlBufferPct",
  "liqCascadeTpAtrMult",
  "liqCascadeMinRr",
  "liqCascadeMaxHoldBars",
  "liqCascadeMaxTradesPerDay",
  "liqCascadeMinBarGap",
  "liqCascadeTradeSides",
  "liqCascadeMinLiqUsdBar",
  "liqCascadeLiveTickEnabled",
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
    minOiDropPct: num(c.liqCascadeMinOiDropPct, LIQ_CASCADE_DEFAULTS.minOiDropPct),
    exhaustionDecayRatio: num(c.liqCascadeExhaustionDecay, LIQ_CASCADE_DEFAULTS.exhaustionDecayRatio),
    directionMode: String(c.liqCascadeDirectionMode ?? LIQ_CASCADE_DEFAULTS.directionMode),
    minAtrPct: num(c.liqCascadeMinAtrPct, LIQ_CASCADE_DEFAULTS.minAtrPct),
    slBufferPct: num(c.liqCascadeSlBufferPct, LIQ_CASCADE_DEFAULTS.slBufferPct),
    tpAtrMult: num(c.liqCascadeTpAtrMult, LIQ_CASCADE_DEFAULTS.tpAtrMult),
    minRr: num(c.liqCascadeMinRr, LIQ_CASCADE_DEFAULTS.minRr),
    maxHoldBars: num(c.liqCascadeMaxHoldBars, LIQ_CASCADE_DEFAULTS.maxHoldBars),
    maxTradesPerDay: num(c.liqCascadeMaxTradesPerDay, LIQ_CASCADE_DEFAULTS.maxTradesPerDay),
    minBarGap: num(c.liqCascadeMinBarGap, LIQ_CASCADE_DEFAULTS.minBarGap),
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
  const liqSeries = ctx.liqSeries ?? [];
  const oiSeries = ctx.oiSeries ?? [];
  const built = buildLiqCascadeSeries(candles, { liqSeries, oiSeries, opts });
  ctx._liqCascadeBuilt = built;
  return built;
}

export async function loadLiqCascadeMarketSeries(symbol, fromMs, toMs, cfg = {}) {
  const c = resolveLiqCascadeCfg(cfg);
  const interval = String(c.liqCascadeInterval ?? "5min");
  const { ensureCoinalyzeLiquidations, ensureCoinalyzeOi } = await import(
    "../backtest/data/coinalyzeIngest.js"
  );
  await ensureCoinalyzeLiquidations(symbol, { from: fromMs, to: toMs, interval }).catch(() => {});
  await ensureCoinalyzeOi(symbol, { from: fromMs, to: toMs, interval }).catch(() => {});
  const [liqSeries, oiSeries] = await Promise.all([
    readCoinalyzeLiquidations(symbol, fromMs, toMs, { interval }),
    readCoinalyzeOi(symbol, fromMs, toMs, { interval }),
  ]);
  return { liqSeries, oiSeries, interval };
}

/** Load Coinalyze liq/OI into cfg for backtest adapter wiring. */
export async function hydrateLiqCascadeCfg(cfg, symbol, fromMs, toMs) {
  const c = resolveLiqCascadeCfg(cfg);
  const padFrom = liqCascadePadFromMs(fromMs, c.timeframe ?? "1m");
  const { liqSeries, oiSeries, interval } = await loadLiqCascadeMarketSeries(symbol, padFrom, toMs, c);
  return {
    ...c,
    _liqCascadeLiqSeries: liqSeries,
    _liqCascadeOiSeries: oiSeries,
    _liqCascadeInterval: interval,
  };
}

/** Aggregate in-memory forceOrder ticks into Coinalyze-style liq bars (live). */
export function aggregateTicksToLiqSeries(ticks, intervalMs = 300_000) {
  if (!ticks?.length) return [];
  const buckets = new Map();
  for (const t of ticks) {
    const bucket = Math.floor(t.time / intervalMs) * intervalMs;
    if (!buckets.has(bucket)) buckets.set(bucket, { ts: bucket, liqLongUsd: 0, liqShortUsd: 0 });
    const row = buckets.get(bucket);
    if (t.side === "SELL") row.liqLongUsd += t.notionalUsd;
    else row.liqShortUsd += t.notionalUsd;
  }
  return [...buckets.values()].sort((a, b) => a.ts - b.ts);
}

export function buildLiqCascadeBacktestAdapter(candles, cfg = {}, _tf = "1m", marketCtx = {}) {
  const opts = optsFromLiqCascadeCfg(cfg);
  const liqSeries = marketCtx.liqSeries ?? [];
  const oiSeries = marketCtx.oiSeries ?? [];
  const { series } = buildLiqCascadeSeries(candles, { liqSeries, oiSeries, opts });
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
