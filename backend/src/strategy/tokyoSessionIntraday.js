/**
 * TOKYO_SESSION — standalone Asia/Tokyo session strategy.
 */

import { atr as computeAtr } from "./indicators.js";
import {
  buildTokyoSessionSeries,
  TOKYO_SESSION_DEFAULTS,
} from "./techniques/tokyoSession.js";
import { TOKYO_SESSION_BNB_15M } from "./presets/tokyoSessionOptimized.js";

const USER_KEYS = [
  "symbol",
  "timeframe",
  "marketMode",
  "market",
  "futuresLeverage",
  "leverage",
  "backtestPositionSizing",
  "riskPerTrade",
  "riskPerTradeUnit",
  "tokyoSessionStartUtc",
  "tokyoSessionEndUtc",
  "tokyoEntryMode",
  "tokyoSweepMaxBarIdx",
  "tokyoMinPreAsiaWidthPct",
  "tokyoHiSweepOnlyDays",
  "tokyoLoSweepOnlyDays",
  "tokyoSweepTpTarget",
  "tokyoDirMode",
  "tokyoSlMode",
  "tokyoTpMode",
  "tokyoSlBufferPct",
  "tokyoSlMinPct",
  "tokyoSlMaxPct",
  "tokyoSlAtrMult",
  "tokyoSlSpanMult",
  "tokyoTpRr",
  "tokyoTpMinRr",
  "tokyoTp1Rr",
  "tokyoTp1MinPct",
  "tokyoTp2Rr",
  "tokyoTp2MinPct",
  "tokyoTp2MaxPct",
  "tokyoTp2PreWidthFrac",
  "tokyoTpMinPct",
  "tokyoTpMaxPct",
  "tokyoTpPreWidthFrac",
  "tokyoPartialTp",
  "tokyoPartialFrac",
  "tokyoMaxTradesPerDay",
  "tokyoMinFirst2RangePct",
  "tokyoSkipMixedBodies",
  "tokyoSkipMisaligned",
  "intradayLiqEntryAtSignalClose",
  "intradayLiqPartialTp",
  "intradayLiqTp1Enabled",
  "intradayLiqTp2Enabled",
  "intradayLiqBreakevenAfterPartial",
  "supertrendFuturesUseFixedSl",
  "supertrendFuturesUseFixedTp",
  "trailingStopLossAuto",
  "futuresTrailingStopMode",
  "trailBufferMode",
  "trailBufferRate",
  "trailBufferAtrMult",
  "futuresTrailingStFeeBreakeven",
  "futuresTrailingStAdvanced",
];

export function resolveTokyoSessionCfg(cfg = {}) {
  const out = { ...TOKYO_SESSION_BNB_15M };
  for (const k of USER_KEYS) {
    if (cfg[k] !== undefined) out[k] = cfg[k];
  }
  out.manualStrategy = "TOKYO_SESSION";
  out.strategyMode = cfg.strategyMode ?? "MANUAL";
  out.supertrendFuturesUseFixedSl = true;
  out.supertrendFuturesUseFixedTp = true;
  out.intradayLiqEntryAtSignalClose = cfg.intradayLiqEntryAtSignalClose !== false;
  out.intradayLiqPartialTp = cfg.intradayLiqPartialTp !== false && out.tokyoPartialTp !== false;
  out.intradayLiqTp1Enabled = cfg.intradayLiqTp1Enabled !== false && out.intradayLiqPartialTp;
  out.intradayLiqTp2Enabled = cfg.intradayLiqTp2Enabled !== false;
  out.intradayLiqBreakevenAfterPartial = cfg.intradayLiqBreakevenAfterPartial !== false;
  out.intradaySmcMaxHoldBars = 0;
  out.intradayLiqMaxHoldBars = 0;
  return out;
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function optsFromTokyoSessionCfg(cfg = {}) {
  const c = resolveTokyoSessionCfg(cfg);
  return {
    ...TOKYO_SESSION_DEFAULTS,
    sessionStartUtc: num(c.tokyoSessionStartUtc, 0),
    sessionEndUtc: num(c.tokyoSessionEndUtc, 4),
    entryMode: String(c.tokyoEntryMode ?? TOKYO_SESSION_DEFAULTS.entryMode),
    sweepMaxBarIdx: num(c.tokyoSweepMaxBarIdx, TOKYO_SESSION_DEFAULTS.sweepMaxBarIdx),
    minPreAsiaWidthPct: num(c.tokyoMinPreAsiaWidthPct, TOKYO_SESSION_DEFAULTS.minPreAsiaWidthPct),
    hiSweepOnlyDays: c.tokyoHiSweepOnlyDays === true,
    loSweepOnlyDays: c.tokyoLoSweepOnlyDays === true,
    sweepTpTarget: String(c.tokyoSweepTpTarget ?? TOKYO_SESSION_DEFAULTS.sweepTpTarget),
    dirMode: String(c.tokyoDirMode ?? TOKYO_SESSION_DEFAULTS.dirMode),
    slMode: String(c.tokyoSlMode ?? TOKYO_SESSION_DEFAULTS.slMode),
    tpMode: String(c.tokyoTpMode ?? TOKYO_SESSION_DEFAULTS.tpMode),
    slBufferPct: num(c.tokyoSlBufferPct, TOKYO_SESSION_DEFAULTS.slBufferPct),
    slMinPct: num(c.tokyoSlMinPct, TOKYO_SESSION_DEFAULTS.slMinPct),
    slMaxPct: num(c.tokyoSlMaxPct, TOKYO_SESSION_DEFAULTS.slMaxPct),
    slAtrMult: num(c.tokyoSlAtrMult, TOKYO_SESSION_DEFAULTS.slAtrMult),
    slSpanMult: num(c.tokyoSlSpanMult, TOKYO_SESSION_DEFAULTS.slSpanMult),
    tpRr: num(c.tokyoTpRr, TOKYO_SESSION_DEFAULTS.tpRr),
    tpMinRr: num(c.tokyoTpMinRr, TOKYO_SESSION_DEFAULTS.tpMinRr),
    tp1Rr: num(c.tokyoTp1Rr, TOKYO_SESSION_DEFAULTS.tp1Rr),
    tp1MinPct: num(c.tokyoTp1MinPct, TOKYO_SESSION_DEFAULTS.tp1MinPct),
    tp2Rr: num(c.tokyoTp2Rr, TOKYO_SESSION_DEFAULTS.tp2Rr),
    tp2MinPct: num(c.tokyoTp2MinPct, TOKYO_SESSION_DEFAULTS.tp2MinPct),
    tp2MaxPct: num(c.tokyoTp2MaxPct, TOKYO_SESSION_DEFAULTS.tp2MaxPct),
    tp2PreWidthFrac: num(c.tokyoTp2PreWidthFrac, TOKYO_SESSION_DEFAULTS.tp2PreWidthFrac),
    tpMinPct: num(c.tokyoTpMinPct, TOKYO_SESSION_DEFAULTS.tpMinPct),
    tpMaxPct: num(c.tokyoTpMaxPct, TOKYO_SESSION_DEFAULTS.tpMaxPct),
    tpPreWidthFrac: num(c.tokyoTpPreWidthFrac, TOKYO_SESSION_DEFAULTS.tpPreWidthFrac),
    partialFrac: num(c.tokyoPartialFrac, TOKYO_SESSION_DEFAULTS.partialFrac),
    partialTp: c.tokyoPartialTp !== false,
    maxTradesPerDay: num(c.tokyoMaxTradesPerDay, 1),
    minFirst2RangePct: num(c.tokyoMinFirst2RangePct, 0),
    skipMixedBodies: c.tokyoSkipMixedBodies === true,
    tokyoSessionStartUtc: num(c.tokyoSessionStartUtc, 0),
    tokyoSessionEndUtc: num(c.tokyoSessionEndUtc, 4),
    tokyoEntryMode: c.tokyoEntryMode,
    tokyoSweepMaxBarIdx: num(c.tokyoSweepMaxBarIdx, TOKYO_SESSION_DEFAULTS.sweepMaxBarIdx),
    tokyoMinPreAsiaWidthPct: num(c.tokyoMinPreAsiaWidthPct, 0),
    tokyoHiSweepOnlyDays: c.tokyoHiSweepOnlyDays === true,
    tokyoLoSweepOnlyDays: c.tokyoLoSweepOnlyDays === true,
    tokyoSweepTpTarget: c.tokyoSweepTpTarget,
    tokyoDirMode: c.tokyoDirMode,
    tokyoSlMode: c.tokyoSlMode,
    tokyoTpMode: c.tokyoTpMode,
    tokyoSlBufferPct: num(c.tokyoSlBufferPct, TOKYO_SESSION_DEFAULTS.slBufferPct),
    tokyoSlMinPct: num(c.tokyoSlMinPct, TOKYO_SESSION_DEFAULTS.slMinPct),
    tokyoSlMaxPct: num(c.tokyoSlMaxPct, TOKYO_SESSION_DEFAULTS.slMaxPct),
    tokyoSlAtrMult: num(c.tokyoSlAtrMult, TOKYO_SESSION_DEFAULTS.slAtrMult),
    tokyoSlSpanMult: num(c.tokyoSlSpanMult, TOKYO_SESSION_DEFAULTS.slSpanMult),
    tokyoTpRr: num(c.tokyoTpRr, TOKYO_SESSION_DEFAULTS.tpRr),
    tokyoTpMinRr: num(c.tokyoTpMinRr, TOKYO_SESSION_DEFAULTS.tpMinRr),
    tokyoTp1Rr: num(c.tokyoTp1Rr, TOKYO_SESSION_DEFAULTS.tp1Rr),
    tokyoTp1MinPct: num(c.tokyoTp1MinPct, TOKYO_SESSION_DEFAULTS.tp1MinPct),
    tokyoTp2Rr: num(c.tokyoTp2Rr, TOKYO_SESSION_DEFAULTS.tp2Rr),
    tokyoTp2MinPct: num(c.tokyoTp2MinPct, TOKYO_SESSION_DEFAULTS.tp2MinPct),
    tokyoTp2MaxPct: num(c.tokyoTp2MaxPct, TOKYO_SESSION_DEFAULTS.tp2MaxPct),
    tokyoTp2PreWidthFrac: num(c.tokyoTp2PreWidthFrac, TOKYO_SESSION_DEFAULTS.tp2PreWidthFrac),
    tokyoTpMinPct: num(c.tokyoTpMinPct, TOKYO_SESSION_DEFAULTS.tpMinPct),
    tokyoTpMaxPct: num(c.tokyoTpMaxPct, TOKYO_SESSION_DEFAULTS.tpMaxPct),
    tokyoTpPreWidthFrac: num(c.tokyoTpPreWidthFrac, TOKYO_SESSION_DEFAULTS.tpPreWidthFrac),
    tokyoPartialTp: c.tokyoPartialTp !== false,
    tokyoPartialFrac: num(c.tokyoPartialFrac, TOKYO_SESSION_DEFAULTS.partialFrac),
    tokyoMaxTradesPerDay: num(c.tokyoMaxTradesPerDay, 1),
    tokyoMinFirst2RangePct: num(c.tokyoMinFirst2RangePct, 0),
    tokyoSkipMixedBodies: c.tokyoSkipMixedBodies === true,
    tokyoSkipMisaligned: c.tokyoSkipMisaligned === true,
  };
}

const PAD_BARS = 200;

export function tokyoSessionPadFromMs(fromMs, tf = "15m") {
  const tfMs = tf === "5m" ? 300_000 : tf === "1h" ? 3_600_000 : 900_000;
  return fromMs - PAD_BARS * tfMs;
}

export function buildTokyoSessionBacktestAdapter(candles, cfg = {}, _tf = "15m") {
  const opts = optsFromTokyoSessionCfg(cfg);
  const atrSeries = computeAtr(candles, 14);
  const series = buildTokyoSessionSeries(candles, opts, atrSeries);

  return function tokyoSessionAdapter(_bar, idx) {
    const sig = series[idx];
    if (!sig) return null;
    return {
      action: sig.action,
      reason: sig.reason,
      playbook: sig.playbook,
      trigger: sig.trigger,
      liqBrackets: sig.liqBrackets,
      techniques: sig.techniques,
    };
  };
}

export function signal({ candles, cfg } = {}) {
  if (!candles?.length) return { action: "HOLD", reason: "no_candles" };
  const opts = optsFromTokyoSessionCfg(cfg || {});
  const atrSeries = computeAtr(candles, 14);
  const series = buildTokyoSessionSeries(candles, opts, atrSeries);
  const idx = candles.length - 1;
  const sig = series[idx];
  if (!sig) return { action: "HOLD", reason: "tokyo_no_setup" };
  return {
    action: sig.action,
    reason: sig.reason,
    playbook: sig.playbook,
    liqBrackets: sig.liqBrackets,
  };
}

export const TOKYO_SESSION = {
  name: "Tokyo Session — overnight sweep fade (ICT Asia)",
  signal,
};
