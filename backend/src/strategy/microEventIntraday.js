/**
 * MICRO_EVENT — tick-first microstructure event scalper (live + bar-close proxy backtest).
 */
import {
  MICRO_EVENT_DEFAULTS,
  MICRO_EVENT_WARMUP,
  optsFromMicroEventCfg,
  evaluateMicroEventFromSnapshot,
  formatMicroEventSkipReason,
} from "./techniques/microEvent.js";
import { buildMicroEventFeedStatus } from "./microEventFeedStatus.js";
import { MICRO_EVENT_BTC_1M } from "./presets/microEventOptimized.js";
import {
  hydrateMicroEventBacktestContext,
  buildBacktestSnapshotFields,
} from "./data/microEventBacktestHydration.js";

const MICRO_EVENT_USER_KEYS = [
  "symbol",
  "timeframe",
  "marketMode",
  "futuresLeverage",
  "backtestPositionSizing",
  "riskPerTrade",
  "riskPerTradeUnit",
  "microEventDirectionMode",
  "microEventTypesEnabled",
  "microEventMinConfluenceScore",
  "microEventMinConfirmLayers",
  "microEventLiqWindowSec",
  "microEventLiqZMin",
  "microEventLiqMinUsd",
  "microEventLiqDomRatio",
  "microEventLiqRequired",
  "microEventOiGateEnabled",
  "microEventOiMinDropPct1m",
  "microEventOiMinDropPct5m",
  "microEventBookGateEnabled",
  "microEventMinImbalance",
  "microEventMaxOppositeWallUsd",
  "microEventCvdGateEnabled",
  "microEventMinAggressiveUsd",
  "microEventMinCvdSlope",
  "microEventFundingGateEnabled",
  "microEventMinFundingZ",
  "microEventCrowdedSideFilter",
  "microEventMacroGateEnabled",
  "microEventMacroScoreBoost",
  "microEventSlBufferPct",
  "microEventTpRr",
  "microEventMaxHoldSec",
  "microEventMaxTradesPerHour",
  "microEventCooldownSec",
  "microEventLiveTickEnabled",
  "microEventTradeSides",
  "intradayLiqPartialTp",
  "intradayLiqTp1Enabled",
  "intradayLiqTp2Enabled",
  "intradayLiqBreakevenAfterPartial",
  "intradayLiqEntryAtSignalClose",
];

export function resolveMicroEventCfg(cfg = {}) {
  const out = { ...MICRO_EVENT_BTC_1M };
  for (const k of MICRO_EVENT_USER_KEYS) {
    if (cfg[k] !== undefined) out[k] = cfg[k];
  }
  out.manualStrategy = "MICRO_EVENT";
  out.strategyMode = cfg.strategyMode ?? "MANUAL";
  return out;
}

export { optsFromMicroEventCfg };

export function microEventPadFromMs(fromMs, tf = "1m") {
  const tfMs = tf === "1m" ? 60_000 : tf === "5m" ? 300_000 : 60_000;
  return fromMs - MICRO_EVENT_WARMUP * tfMs * 2;
}

export function microEventMaxHoldBarsFromSec(cfg) {
  const sec = Number(cfg?.microEventMaxHoldSec ?? MICRO_EVENT_DEFAULTS.maxHoldSec);
  return Math.max(1, Math.ceil(sec / 60));
}

/** Bar-close proxy adapter using hydrated liq + CVD + funding + OI (book = live-only). */
export function buildMicroEventBacktestAdapter(candles, cfg = {}, _tf = "1m", marketCtx = {}) {
  const opts = optsFromMicroEventCfg(cfg);
  const liqSeries = marketCtx.liqSeries ?? cfg._microEventLiqSeries ?? [];
  const btCtx = marketCtx.backtestCtx ?? cfg._microEventBacktestCtx ?? null;
  const intervalMs = 60_000;
  let lastSignalIdx = -Infinity;
  let tradesHour = 0;
  let hourBucket = null;
  let lastFireMs = 0;
  const dayLocal = { lastSignalIdx: -Infinity, tradesHour: 0, hourBucket: null, lastFireMs: 0 };
  const cooldownMs = Math.max(0, opts.cooldownSec * 1000);

  return function microEventAdapter(bar, idx, ctx) {
    if (idx < MICRO_EVENT_WARMUP) return null;
    const ts = Number(bar.ts);
    const hour = Math.floor(ts / 3_600_000);
    const dHour = ctx?.persisted ? dayLocal : { hourBucket, tradesHour, lastSignalIdx, lastFireMs };
    if (dHour.hourBucket !== hour) {
      dHour.hourBucket = hour;
      dHour.tradesHour = 0;
    }
    if (dHour.tradesHour >= opts.maxTradesPerHour) return null;
    if (ts - (dHour.lastFireMs ?? 0) < cooldownMs) return null;
    if (idx - (ctx?.persisted ? dHour.lastSignalIdx : lastSignalIdx) < 1) return null;

    const liqBar = liqSeries.find((b) => b.ts <= ts && b.ts > ts - intervalMs);
    if (!liqBar) return null;

    const snapFields = btCtx
      ? buildBacktestSnapshotFields(ts, {
          symbol: cfg.symbol ?? "BTCUSDT",
          liqTicks: btCtx.liqTicks ?? [],
          liqWindowSec: opts.liqWindowSec,
          domRatio: opts.liqDomRatio,
          aggTrades: btCtx.aggTrades ?? [],
          fundingRates: btCtx.fundingRates ?? [],
          oiSeries: btCtx.oiSeries ?? [],
          oiAvailableFromMs: btCtx.oiAvailableFromMs ?? null,
        })
      : null;

    const longUsd = Number(liqBar.liqLongUsd ?? 0);
    const shortUsd = Number(liqBar.liqShortUsd ?? 0);
    const totalUsd = longUsd + shortUsd;

    const snapshot = {
      symbol: cfg.symbol ?? "BTCUSDT",
      tsMs: ts,
      liqLongUsd: snapFields?.liqLongUsd ?? longUsd,
      liqShortUsd: snapFields?.liqShortUsd ?? shortUsd,
      liqTotalUsd: snapFields?.liqTotalUsd ?? totalUsd,
      liqRateUsdPerMin: snapFields?.liqRateUsdPerMin ?? totalUsd,
      liqDom: snapFields?.liqDom ?? "neutral",
      liqZLike: snapFields?.liqZLike ?? totalUsd / Math.max(opts.liqMinUsd, 1),
      lastLiqTickMs: ts,
      oi: snapFields?.oi ?? null,
      oiDeltaPct1m: snapFields?.oiDeltaPct1m ?? null,
      oiDeltaPct5m: snapFields?.oiDeltaPct5m ?? null,
      bookImbalance: null,
      bidWallUsd: null,
      askWallUsd: null,
      cvdUsd60s: snapFields?.cvdUsd60s ?? 0,
      aggressiveBuyUsd60s: snapFields?.aggressiveBuyUsd60s ?? 0,
      aggressiveSellUsd60s: snapFields?.aggressiveSellUsd60s ?? 0,
      cvdSlope60s: snapFields?.cvdSlope60s ?? 0,
      fundingZ: snapFields?.fundingZ ?? null,
      crowdedSide: snapFields?.crowdedSide ?? "neutral",
      calendarActive: snapFields?.calendarActive ?? false,
      calendarEvents: snapFields?.calendarEvents ?? [],
      lastPrice: Number(bar.close),
    };

    if (!snapFields) {
      let dom = "neutral";
      if (longUsd > shortUsd * opts.liqDomRatio) dom = "longs";
      else if (shortUsd > longUsd * opts.liqDomRatio) dom = "shorts";
      snapshot.liqDom = dom;
    }

    const ev = evaluateMicroEventFromSnapshot(snapshot, cfg, Number(bar.close));
    if (!ev.action) return null;

    if (ctx?.persisted) {
      dHour.lastSignalIdx = idx;
      dHour.tradesHour += 1;
      dHour.lastFireMs = ts;
    } else {
      lastSignalIdx = idx;
      tradesHour += 1;
      lastFireMs = ts;
    }

    return {
      action: ev.action,
      reason: ev.reason,
      trigger: ev.trigger,
      playbook: ev.playbook,
      liqBrackets: ev.liqBrackets,
      confluenceScore: ev.confluenceScore,
    };
  };
}

export async function hydrateMicroEventBacktestData(symbol, fromMs, toMs, cfg = {}) {
  const ctx = await hydrateMicroEventBacktestContext(symbol, fromMs, toMs, cfg);
  return {
    liqSeries: ctx.liqSeries,
    tickCount: ctx.tickCount,
    backtestCtx: ctx,
  };
}

export async function hydrateMicroEventCfg(cfg, symbol, fromMs, toMs) {
  const { liqSeries, tickCount, backtestCtx } = await hydrateMicroEventBacktestData(symbol, fromMs, toMs, cfg);
  return {
    ...cfg,
    _microEventLiqSeries: liqSeries,
    _microEventTickCount: tickCount,
    _microEventBacktestCtx: backtestCtx,
  };
}

/** Activity audit row for tick near-misses. */
export function auditMicroEventTickSkipForActivity(payload = {}) {
  const audit = payload.audit;
  if (!audit?.skip) return null;
  return {
    type: "skip",
    reason: formatMicroEventSkipReason(audit),
    failedGate: audit.failedGate,
    score: audit.score,
    layers: audit.layers,
    hits: audit.hits,
    source: payload.source,
  };
}

export function signal({ candles, cfg, liqSeries } = {}) {
  if (!candles?.length) return { action: "HOLD", reason: "no_candles" };
  const adapter = buildMicroEventBacktestAdapter(candles, cfg, "1m", { liqSeries: liqSeries ?? [] });
  const idx = candles.length - 1;
  const sig = adapter(candles[idx], idx, {});
  if (!sig) return { action: "HOLD", reason: "no_setup" };
  return sig;
}

export const MICRO_EVENT = {
  key: "MICRO_EVENT",
  name: "MICRO EVENT — microstructure event scalper",
  buildFeedStatus: buildMicroEventFeedStatus,
  signal,
  resolveCfg: resolveMicroEventCfg,
};

export default MICRO_EVENT;
