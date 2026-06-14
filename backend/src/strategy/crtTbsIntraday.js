/**
 * CRT_TBS — Candle Range Theory + Turtle Body Soup intraday strategy.
 */

import { precomputeIntraday } from "./intradayPro.js";
import { dayStore } from "./adapterPersisted.js";
import { utcDayId } from "./techniques/liquidity.js";
import {
  buildCrtTbsSeries,
  CRT_TBS_DEFAULTS,
  CRT_TBS_WARMUP,
  CRT_TBS_PAD_BARS,
  CrtTbsDayState,
  resolveCrtStructureMode,
} from "./techniques/crtTbs.js";
import { CRT_TBS_BNB_15M } from "./presets/crtTbsOptimized.js";

const CRT_USER_KEYS = [
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
  "crtHtfMs",
  "crtSweepPct",
  "crtMinTbsWick",
  "crtMinBodyRatio",
  "crtMinRangeAtr",
  "crtMinRangePct",
  "crtRequireChoch",
  "crtRequireMss",
  "crtStructureMode",
  "crtRequireEntryBelowEq",
  "crtMinRrToTp2",
  "crtChochMaxBars",
  "crtMaxTradesPerDay",
  "crtMinBarGap",
  "crtPartialFrac",
  "crtTradeSides",
  "crtPremiumDiscountFilter",
  "crtKillzoneOnTbsBar",
  "intradaySmcKillzoneEnabled",
  "intradaySmcKillzoneMode",
  "intradayLiqPartialTp",
  "intradayLiqTp1Enabled",
  "intradayLiqTp2Enabled",
  "intradayLiqBreakevenAfterPartial",
  "intradayLiqEntryAtSignalClose",
];

export function resolveCrtTbsCfg(cfg = {}) {
  const out = { ...CRT_TBS_BNB_15M };
  for (const k of CRT_USER_KEYS) {
    if (cfg[k] !== undefined) out[k] = cfg[k];
  }
  out.manualStrategy = "CRT_TBS";
  out.strategyMode = cfg.strategyMode ?? "MANUAL";
  return out;
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function optsFromCrtTbsCfg(cfg = {}) {
  const c = resolveCrtTbsCfg(cfg);
  return {
    ...CRT_TBS_DEFAULTS,
    crtHtfMs: num(c.crtHtfMs, CRT_TBS_DEFAULTS.crtHtfMs),
    sweepPct: num(c.crtSweepPct, CRT_TBS_DEFAULTS.sweepPct),
    minTbsWick: num(c.crtMinTbsWick, CRT_TBS_DEFAULTS.minTbsWick),
    minBodyRatio: num(c.crtMinBodyRatio, CRT_TBS_DEFAULTS.minBodyRatio),
    minCrtRangeAtr: num(c.crtMinRangeAtr, CRT_TBS_DEFAULTS.minCrtRangeAtr),
    minCrtRangePct: num(c.crtMinRangePct, CRT_TBS_DEFAULTS.minCrtRangePct),
    requireChoch: c.crtRequireChoch !== false,
    requireMss: c.crtRequireMss === true,
    structureMode: c.crtStructureMode
      ? String(c.crtStructureMode).toLowerCase()
      : resolveCrtStructureMode({
          requireChoch: c.crtRequireChoch !== false,
          requireMss: c.crtRequireMss === true,
        }),
    requireEntryBelowEq: c.crtRequireEntryBelowEq === true,
    minRrToTp2: num(c.crtMinRrToTp2, CRT_TBS_DEFAULTS.minRrToTp2),
    chochMaxBars: num(c.crtChochMaxBars, CRT_TBS_DEFAULTS.chochMaxBars),
    maxTradesPerDay: num(c.crtMaxTradesPerDay, CRT_TBS_DEFAULTS.maxTradesPerDay),
    minBarGap: num(c.crtMinBarGap, CRT_TBS_DEFAULTS.minBarGap),
    partialFrac: num(c.crtPartialFrac, CRT_TBS_DEFAULTS.partialFrac),
    tradeSides: String(c.crtTradeSides ?? CRT_TBS_DEFAULTS.tradeSides).toUpperCase(),
    premiumDiscountFilter: c.crtPremiumDiscountFilter !== false,
    killzoneOnTbsBar: c.crtKillzoneOnTbsBar !== false,
    intradaySmcKillzoneEnabled: c.intradaySmcKillzoneEnabled !== false,
    intradaySmcKillzoneMode: String(c.intradaySmcKillzoneMode ?? CRT_TBS_DEFAULTS.intradaySmcKillzoneMode),
    intradayLiqPartialTp: c.intradayLiqPartialTp,
    intradayLiqTp1Enabled: c.intradayLiqTp1Enabled,
    intradayLiqTp2Enabled: c.intradayLiqTp2Enabled,
    intradayLiqBreakevenAfterPartial: c.intradayLiqBreakevenAfterPartial,
  };
}

/** Backtest candle load should start this many ms before run.from (HTF + warmup). */
export function crtTbsPadFromMs(fromMs, tf = "15m") {
  const tfMs = tf === "5m" ? 300_000 : tf === "1h" ? 3_600_000 : 900_000;
  return fromMs - CRT_TBS_PAD_BARS * tfMs;
}

export function buildCrtTbsBacktestAdapter(candles, cfg = {}, _tf = "15m") {
  const opts = optsFromCrtTbsCfg(cfg);
  const pre = precomputeIntraday(candles);
  const { series } = buildCrtTbsSeries(candles, { ...opts, pre });
  let lastSignalIdx = -Infinity;
  let tradesToday = 0;
  let curDay = null;
  const dayLocal = { lastSignalIdx: -Infinity, tradesToday: 0, curDay: null };

  return function crtTbsAdapter(bar, idx, ctx) {
    if (idx < CRT_TBS_WARMUP) return null;
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
      crtSide: sig.crtSide,
      liqBrackets: sig.liqBrackets,
    };
  };
}

export function signal({ candles, cfg } = {}) {
  if (!candles?.length) return { action: "HOLD", reason: "no_candles" };
  const opts = optsFromCrtTbsCfg(cfg || {});
  const pre = precomputeIntraday(candles);
  const idx = candles.length - 1;
  const { series } = buildCrtTbsSeries(candles, { ...opts, pre });
  const sig = series[idx];
  if (!sig) return { action: "HOLD", reason: "crt_no_setup" };
  return {
    action: sig.action,
    reason: sig.reason,
    trigger: sig.trigger,
    playbook: sig.playbook,
    crtSide: sig.crtSide,
    liqBrackets: sig.liqBrackets,
  };
}

export const CRT_TBS = {
  name: "CRT + TBS — 4H candle range + turtle body soup (ICT)",
  signal,
};
