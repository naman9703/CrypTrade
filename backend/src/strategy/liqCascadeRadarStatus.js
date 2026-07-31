/**
 * LIQ_CASCADE — live radar snapshot for UI (read-only; does not affect signal timing).
 */
import {
  getLiquidationStreamStatus,
  getRecentLiquidations,
  getLiquidationPayloadForSymbol,
} from "../intelligence/collectors/liquidationCollector.js";
import { getOpenInterestFetchedAt, intelligenceCache } from "../intelligence/index.js";
import { isLiqCascadeLiveEngineRunning } from "../svc/liqCascadeLiveEngine.js";
import { resolveLiqCascadeWatchSymbols } from "../svc/liqCascadeLiveEngine.js";
import { aggregateTicksToLiqSeries, optsFromLiqCascadeCfg, resolveLiqCascadeCfg } from "./liqCascadeIntraday.js";
import {
  liqIntervalToMs,
  prepareLiqBars,
  LIQ_CASCADE_DEFAULTS,
} from "./techniques/liqCascade.js";
import { atr as atrFn } from "./indicators.js";
import { buildLiqCascadeFeedStatus } from "./liqCascadeFeedStatus.js";

const DOM_RATIO = 1.2;
const TAPE_LIMIT = 24;
const COOLDOWN_AFTER_SIGNAL_MS = 60_000;
const RADAR_DB_TICK_CACHE_MS = 60_000;

/** @type {Map<string, { ticks: { time: number, side: string, notionalUsd: number }[], fetchedAt: number }>} */
const dbTickCache = new Map();

/** Prime radar z-score / last-tick display from DB (WS memory only retains ~15m). */
export async function refreshLiqCascadeRadarTickCache(symbols, windowMs = 6 * 60 * 60_000) {
  const list = (Array.isArray(symbols) ? symbols : [symbols])
    .map((s) => String(s || "").trim().toUpperCase())
    .filter(Boolean);
  if (!list.length) return;
  const now = Date.now();
  const fromMs = now - windowMs;
  let readRecentForceOrders;
  try {
    ({ readRecentForceOrders } = await import("../intelligence/collectors/forceOrderPersist.js"));
  } catch {
    return;
  }
  for (const sym of list) {
    try {
      const dbTicks = await readRecentForceOrders(sym, fromMs, now);
      dbTickCache.set(sym, { ticks: dbTicks, fetchedAt: now });
    } catch {
      /* DB optional */
    }
  }
}

function mergeRadarTicks(sym, windowMs) {
  const cutoff = Date.now() - windowMs;
  const mem = getRecentLiquidations(sym, windowMs);
  const cached = dbTickCache.get(sym);
  const db =
    cached && Date.now() - cached.fetchedAt <= RADAR_DB_TICK_CACHE_MS * 3 ? cached.ticks : [];
  const merged = new Map();
  for (const t of [...db, ...mem]) {
    if (t.time < cutoff) continue;
    merged.set(`${t.time}|${t.side}|${t.price ?? ""}|${t.notionalUsd ?? ""}`, t);
  }
  return [...merged.values()].sort((a, b) => a.time - b.time);
}

function countTicksSince(sym, windowMs) {
  const cutoff = Date.now() - windowMs;
  return mergeRadarTicks(sym, windowMs).filter((t) => t.time >= cutoff).length;
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function fmtDom(longUsd, shortUsd) {
  if (longUsd > shortUsd * DOM_RATIO) return "longs";
  if (shortUsd > longUsd * DOM_RATIO) return "shorts";
  return "neutral";
}

function candleIdxAtOrBefore(candles, ts) {
  let lo = 0;
  let hi = candles.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Number(candles[mid].ts) <= ts) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function computeBuildingBar(ticks, intervalMs, lookbackBars, now = Date.now()) {
  const bucketStart = Math.floor(now / intervalMs) * intervalMs;
  const fromMs = bucketStart - lookbackBars * intervalMs;
  const liqSeries = aggregateTicksToLiqSeries(ticks, intervalMs, fromMs, bucketStart + intervalMs - 1);
  const bars = prepareLiqBars(liqSeries, { intervalMs, lookbackBars });
  const completed = bars.filter((b) => b.ts <= now);
  const lastCompleted = completed.length ? completed[completed.length - 1] : null;

  let buildLong = 0;
  let buildShort = 0;
  for (const t of ticks) {
    if (t.time < bucketStart || t.time > now) continue;
    if (t.side === "SELL") buildLong += Number(t.notionalUsd) || 0;
    else buildShort += Number(t.notionalUsd) || 0;
  }
  const buildTotal = buildLong + buildShort;
  let buildZ = null;
  if (completed.length >= 8) {
    const base = completed.slice(-lookbackBars, -1);
    const mean = base.reduce((s, b) => s + b.totalUsd, 0) / base.length;
    const varSum = base.reduce((s, b) => s + (b.totalUsd - mean) ** 2, 0);
    const std = Math.sqrt(varSum / base.length);
    buildZ = std > 0 ? (buildTotal - mean) / std : buildTotal > mean ? 99 : 0;
  }

  return {
    bucketStart,
    bucketCloseMs: bucketStart + intervalMs,
    buildingLongUsd: buildLong,
    buildingShortUsd: buildShort,
    buildingTotalUsd: buildTotal,
    buildingZ: buildZ,
    buildingDom: fmtDom(buildLong, buildShort),
    lastCompleted,
  };
}

function resolvePhase(ctx) {
  const {
    tickEnabled,
    tickSnap,
    opts,
    zScore,
    zThreshold,
    liqUsd,
    liqMin,
    dom,
    oiGatePass,
    dispAtr,
    dispMin,
    atrPct,
    atrMin,
    lastSignalMs,
    decayRatio,
    decayTarget,
  } = ctx;

  const now = Date.now();
  if (lastSignalMs && now - lastSignalMs < COOLDOWN_AFTER_SIGNAL_MS) return "COOLDOWN";

  if (tickEnabled && tickSnap?.cascadeActive) {
    if (decayRatio != null && decayRatio <= decayTarget) return "EXHAUSTION";
    return "CASCADE";
  }

  const spikeHint = zScore != null && zScore >= zThreshold * 0.45;
  const liqHot = liqUsd >= liqMin * 0.5;

  if (!spikeHint && !liqHot && !(tickSnap?.cascadeActive)) return "SCANNING";

  const triggerOk =
    zScore != null &&
    zScore >= zThreshold &&
    (dom === "longs" || dom === "shorts") &&
    liqUsd >= liqMin &&
    dispAtr != null &&
    dispAtr >= dispMin &&
    atrPct >= atrMin &&
    oiGatePass;

  if (triggerOk) return "CONFIRM";

  if (spikeHint || liqHot || dom !== "neutral") return "SPIKE";

  return "SCANNING";
}

function buildCoinRadar(symbol, state, feed, tickSnapshots, now = Date.now()) {
  const sym = String(symbol || "").toUpperCase();
  const cfg = resolveLiqCascadeCfg(state);
  const opts = optsFromLiqCascadeCfg(cfg);
  const intervalMs = liqIntervalToMs(opts.liqInterval ?? LIQ_CASCADE_DEFAULTS.liqInterval);
  const lookbackBars = num(opts.liqLookbackBars, LIQ_CASCADE_DEFAULTS.liqLookbackBars);
  const zThreshold = num(opts.liqZScoreMin, LIQ_CASCADE_DEFAULTS.liqZScoreMin);
  const liqMin = num(opts.minLiqUsdBar, LIQ_CASCADE_DEFAULTS.minLiqUsdBar);
  const dispMin = num(opts.minDispAtrMult, LIQ_CASCADE_DEFAULTS.minDispAtrMult);
  const atrMin = num(opts.minAtrPct, LIQ_CASCADE_DEFAULTS.minAtrPct);
  const oiMin = num(opts.minOiDropPct, LIQ_CASCADE_DEFAULTS.minOiDropPct);
  const oiMode = String(opts.oiGateMode ?? LIQ_CASCADE_DEFAULTS.oiGateMode).toLowerCase();
  const decayTarget = num(opts.exhaustionDecayRatio, LIQ_CASCADE_DEFAULTS.exhaustionDecayRatio);
  const tickEnabled = state?.liqCascadeLiveTickEnabled === true;

  const tickWindowMs = Math.max(intervalMs * (lookbackBars + 4), 6 * 60 * 60_000);
  const ticks = mergeRadarTicks(sym, tickWindowMs);
  const building = computeBuildingBar(ticks, intervalMs, lookbackBars, now);
  const lastCompleted = building.lastCompleted;

  const zScore = building.buildingZ ?? lastCompleted?.z ?? null;
  const liqUsd = building.buildingTotalUsd > 0 ? building.buildingTotalUsd : lastCompleted?.totalUsd ?? 0;
  const dom =
    building.buildingDom !== "neutral"
      ? building.buildingDom
      : lastCompleted?.dom ?? getLiquidationPayloadForSymbol(sym)?.dominance ?? "neutral";

  const symKey = sym.replace(/[^A-Za-z0-9]/g, "");
  const oiRow = intelligenceCache.openInterest?.[symKey] ?? intelligenceCache.openInterest?.[sym] ?? null;
  const oiChange4h = oiRow?.change4hPct ?? null;
  const oiGatePass =
    oiMode === "off" || oiMin <= 0
      ? true
      : oiChange4h != null && oiChange4h <= -oiMin;

  const candles =
    typeof feed?.getCandlesForSymbol === "function"
      ? feed.getCandlesForSymbol(sym)
      : feed?.getCandles?.() ?? [];
  let dispAtr = null;
  let atrPct = null;
  if (Array.isArray(candles) && candles.length > 20) {
    const idx = candles.length - 1;
    const closes = candles.map((c) => Number(c.close));
    const atrArr = atrFn(candles, 14);
    const atrVal = atrArr[idx];
    atrPct = closes[idx] > 0 && atrVal > 0 ? (atrVal / closes[idx]) * 100 : null;
    const startIdx = candleIdxAtOrBefore(candles, building.bucketStart);
    if (atrVal > 0 && startIdx != null) {
      dispAtr = Math.abs(closes[idx] - closes[startIdx]) / atrVal;
    }
  }

  const tickSnap = tickSnapshots?.[sym] ?? null;
  let decayRatio = null;
  if (tickSnap?.cascadeActive && tickSnap.peakLiqRate > 0) {
    const recentTotal = (tickSnap.windowLongUsd ?? 0) + (tickSnap.windowShortUsd ?? 0);
    const windowMs = num(opts.cascadeWindowBars, 3) * 60_000;
    const rate = recentTotal / (windowMs / 60_000);
    decayRatio = rate / tickSnap.peakLiqRate;
  } else if (lastCompleted?.decayFromPeak != null) {
    decayRatio = lastCompleted.decayFromPeak;
  }

  const lastSignalMs = tickSnap?.lastSignalMs ?? 0;
  const phase = resolvePhase({
    tickEnabled,
    tickSnap,
    opts,
    zScore,
    zThreshold,
    liqUsd,
    liqMin,
    dom,
    oiGatePass,
    dispAtr,
    dispMin,
    atrPct,
    atrMin,
    lastSignalMs,
    decayRatio,
    decayTarget,
  });

  const fadeAction =
    dom === "longs"
      ? String(opts.directionMode).toLowerCase() === "continuation"
        ? "SELL"
        : "BUY"
      : dom === "shorts"
        ? String(opts.directionMode).toLowerCase() === "continuation"
          ? "BUY"
          : "SELL"
        : null;

  const gates = [
    {
      key: "zScore",
      label: "Liq z-score",
      pass: zScore != null && zScore >= zThreshold,
      value: zScore,
      threshold: zThreshold,
      display: zScore != null ? zScore.toFixed(2) : "—",
    },
    {
      key: "liqUsd",
      label: "Liq $ (building bar)",
      pass: liqUsd >= liqMin,
      value: liqUsd,
      threshold: liqMin,
      display: `$${Math.round(liqUsd).toLocaleString()}`,
    },
    {
      key: "dominance",
      label: "Forced side",
      pass: dom === "longs" || dom === "shorts",
      value: dom,
      threshold: "longs|shorts",
      display: dom,
    },
    {
      key: "oiDrop",
      label: oiMode === "off" ? "OI gate (off)" : oiMode === "window" ? "OI Δ 4h (window proxy)" : "OI Δ 4h",
      pass: oiGatePass,
      value: oiChange4h,
      threshold: -oiMin,
      display: oiChange4h != null ? `${oiChange4h.toFixed(3)}%` : "—",
    },
    {
      key: "displacement",
      label: "Displacement (ATR)",
      pass: dispAtr != null && dispAtr >= dispMin,
      value: dispAtr,
      threshold: dispMin,
      display: dispAtr != null ? dispAtr.toFixed(2) : "—",
    },
    {
      key: "volatility",
      label: "ATR %",
      pass: atrPct != null && atrPct >= atrMin,
      value: atrPct,
      threshold: atrMin,
      display: atrPct != null ? `${atrPct.toFixed(3)}%` : "—",
    },
  ];

  if (tickEnabled && tickSnap?.cascadeActive) {
    gates.push({
      key: "exhaustion",
      label: "Exhaustion decay",
      pass: decayRatio != null && decayRatio <= decayTarget,
      value: decayRatio,
      threshold: decayTarget,
      display: decayRatio != null ? decayRatio.toFixed(2) : "—",
    });
  }

  const lastTickMs = ticks.length ? ticks[ticks.length - 1].time : null;
  const msToBarClose = Math.max(0, building.bucketCloseMs - now);

  return {
    symbol: sym,
    phase,
    fadeAction,
    zScore,
    zThreshold,
    liqUsd,
    liqMin,
    domSide: dom,
    oiChange4hPct: oiChange4h,
    oiDropMin: oiMin,
    dispAtr,
    dispMin,
    atrPct,
    atrMin,
    decayRatio,
    decayTarget,
    buildingBarUsd: building.buildingTotalUsd,
    lastCompletedBarUsd: lastCompleted?.totalUsd ?? null,
    lastCompletedZ: lastCompleted?.z ?? null,
    recentTickCount15m: countTicksSince(sym, 15 * 60_000),
    lastForceOrderMs: lastTickMs,
    nextLiqBarCloseMs: building.bucketCloseMs,
    msToBarClose,
    tickCascadeActive: tickSnap?.cascadeActive === true,
    gates,
    gatesPassed: gates.filter((g) => g.pass).length,
    gatesTotal: gates.length,
  };
}

function buildLiquidationTape(symbols, limit = TAPE_LIMIT) {
  const rows = [];
  for (const sym of symbols) {
    for (const t of mergeRadarTicks(sym, 15 * 60_000)) {
      rows.push({
        symbol: sym,
        time: t.time,
        side: t.side,
        notionalUsd: t.notionalUsd,
        price: t.price ?? null,
        forcedSide: t.side === "SELL" ? "longs" : "shorts",
      });
    }
  }
  rows.sort((a, b) => b.time - a.time);
  return rows.slice(0, limit);
}

/**
 * @param {{
 *   state?: object,
 *   feed?: { getCandles?: () => object[], getCandlesForSymbol?: (s: string) => object[] },
 *   tickSnapshots?: Record<string, object>,
 *   feedStatus?: object | null,
 *   marketFeedLive?: boolean,
 *   getTradingMode?: () => string,
 * }} ctx
 */
export function buildLiqCascadeRadarStatus(ctx = {}) {
  const state = ctx.state ?? {};
  const now = Date.now();
  const symbols = resolveLiqCascadeWatchSymbols(state);
  const watch = symbols.length ? symbols : [String(state.symbol || "BTCUSDT").toUpperCase()];
  const tickEnabled = state.liqCascadeLiveTickEnabled === true;
  const tickSnapshots = ctx.tickSnapshots ?? {};

  const coins = watch.map((sym) => buildCoinRadar(sym, state, ctx.feed, tickSnapshots, now));
  const tape = buildLiquidationTape(watch);
  const liqStream = getLiquidationStreamStatus();
  const cfgEcho = resolveLiqCascadeCfg(state);
  const optsEcho = optsFromLiqCascadeCfg(cfgEcho);

  const primarySym = String(state.symbol || watch[0] || "BTCUSDT").toUpperCase();
  const feedStatus = buildLiqCascadeFeedStatus({
    symbol: primarySym,
    feedStatus: ctx.feedStatus ?? null,
    marketFeedLive: ctx.marketFeedLive !== false,
    liqCascadeLiveTickEnabled: tickEnabled,
    botRunning: state.running === true,
    getTradingMode: ctx.getTradingMode,
  });

  return {
    updatedAt: now,
    mode: tickEnabled ? "tick" : "bar_close",
    botRunning: state.running === true,
    tickEngineRunning: isLiqCascadeLiveEngineRunning(),
    liqStreamOk: feedStatus.feeds?.liquidations?.ok === true,
    lastForceOrderMs: tape[0]?.time ?? liqStream.lastMessageAt ?? null,
    focusSymbol: primarySym,
    effectiveConfig: {
      liqCascadeZScoreMin: optsEcho.liqZScoreMin,
      liqCascadeMinLiqUsdBar: optsEcho.minLiqUsdBar,
      liqCascadeMinDispAtr: optsEcho.minDispAtrMult,
      liqCascadeOiGateMode: optsEcho.oiGateMode,
      liqCascadeMinRr: optsEcho.minRr,
      onState: {
        liqCascadeZScoreMin: state.liqCascadeZScoreMin ?? null,
        liqCascadeMinLiqUsdBar: state.liqCascadeMinLiqUsdBar ?? null,
        liqCascadeMinDispAtr: state.liqCascadeMinDispAtr ?? null,
        liqCascadeOiGateMode: state.liqCascadeOiGateMode ?? null,
      },
    },
    coins,
    tape,
    feedStatus,
  };
}
