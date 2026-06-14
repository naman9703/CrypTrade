/**
 * TREND_HTF_ST regime engine — production entry gate + dynamic brackets.
 *
 * Solves H2 2025 chop losses (immature HTF trend / EMA cross whipsaw) while
 * preserving Jan 2026 trend-leg performance via strong-trend bypass.
 *
 * Always on unless trendHtfStRegimeGate: false.
 */

import { ema, adx as computeAdx, atr as computeAtr } from "./indicators.js";
import { computeSupertrendSeries } from "./supertrend.js";

export const TREND_HTF_ST_REGIME_WARMUP = 80;

/** Per-season profiles — tuned via backtest-trend-htf-prod-sweep.mjs */
export const TREND_HTF_ST_MACRO_PROFILES = {
  CHOP_SEASON: {
    minHtfSep: 0.0008,
    blockSidewaysTriple: true,
    blockWhipsawSideways: true,
    blockSepShrinking: true,
    crossBypassMinSep: 999,
    crossBypassMinAdx: 999,
    minHtfTrendAgeHours: 0,
    tpTrendOk: 0.04,
    tpMixed: 0.04,
    tpChop: 0.04,
  },
  TREND_SEASON: {
    minHtfSep: 0.0005,
    blockSidewaysTriple: false,
    blockWhipsawSideways: false,
    blockSepShrinking: false,
    crossBypassMinSep: 0.001,
    crossBypassMinAdx: 22,
    minHtfTrendAgeHours: 0,
    tpTrendOk: 0.03,
    tpMixed: 0.035,
    tpChop: 0.035,
  },
};

export const TREND_HTF_ST_REGIME_DEFAULTS = {
  htfCrossLookbackHours: 8,
  minHtfTrendAgeHours: 0,
  crossBypassMinSep: 0.0012,
  crossBypassMinAdx: 24,
  blockSidewaysTriple: false,
  blockWhipsawSideways: false,
  minHtfSep: 0.0005,
  sepShrinkThreshold: -0.00015,
  maxPriorStSignals16: 1,
  tpTrendOk: 0.03,
  tpMixed: 0.035,
  tpChop: 0.045,
  slDefault: 0.012,
};

function aggregateToHourly(candles) {
  if (!candles.length) return [];
  const hourly = [];
  let cur = null;
  for (const c of candles) {
    const hourTs = Math.floor(c.ts / 3600000) * 3600000;
    if (!cur || cur.ts !== hourTs) {
      if (cur) hourly.push(cur);
      cur = { ts: hourTs, open: c.open, high: c.high, low: c.low, close: c.close };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
    }
  }
  if (cur) hourly.push(cur);
  return hourly;
}

function hourIndexForBar(barTs, hourly) {
  const hourTs = Math.floor(barTs / 3600000) * 3600000;
  let lo = 0;
  let hi = hourly.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (hourly[mid].ts <= hourTs) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function htfSepAt(hEma21, hEma50, hIdx) {
  const e21 = hEma21[hIdx];
  const e50 = hEma50[hIdx];
  if (!Number.isFinite(e21) || !Number.isFinite(e50) || e50 === 0) return null;
  return Math.abs(e21 - e50) / Math.abs(e50);
}

function hoursSinceHtfCross(hEma21, hEma50, hIdx, lookbackHours) {
  const start = Math.max(1, hIdx - lookbackHours);
  for (let h = hIdx; h >= start; h--) {
    const p21 = hEma21[h - 1];
    const p50 = hEma50[h - 1];
    const c21 = hEma21[h];
    const c50 = hEma50[h];
    if (!Number.isFinite(p21) || !Number.isFinite(p50) || !Number.isFinite(c21) || !Number.isFinite(c50))
      continue;
    const prevDiff = p21 - p50;
    const curDiff = c21 - c50;
    if (prevDiff === 0) continue;
    if ((prevDiff > 0 && curDiff < 0) || (prevDiff < 0 && curDiff > 0)) return hIdx - h;
  }
  return lookbackHours + 1;
}

function countPriorStSignals(stSeries, from, to) {
  let n = 0;
  for (let i = from; i < to; i++) {
    if (stSeries[i]?.buySignal || stSeries[i]?.sellSignal) n++;
  }
  return n;
}

function detectRegime15m(adx, atr, closePx) {
  const atrPct = closePx > 0 && Number.isFinite(atr) ? Math.min(atr / closePx, 0.25) : 0;
  if (atrPct > 0.012) return "VOLATILE";
  if (adx > 28) return "TRENDING";
  if (adx < 22) return "SIDEWAYS";
  return "MIXED";
}

/**
 * Macro chop vs trend season from rolling 14d 1h EMA-cross rate + 15m ADX.
 * @returns {"CHOP_SEASON"|"TREND_SEASON"}
 */
export function detectTrendHtfStMacroMode(candles, signalIdx) {
  const i = signalIdx;
  const hourly = aggregateToHourly(candles.slice(0, i + 1));
  if (hourly.length < 120) return "TREND_SEASON";

  const lookbackH = Math.min(336, hourly.length - 2);
  const startH = hourly.length - 1 - lookbackH;
  const hCloses = hourly.map((c) => c.close);
  const hEma21 = ema(hCloses, 21);
  const hEma50 = ema(hCloses, 50);
  let crosses = 0;
  for (let h = startH + 1; h < hourly.length; h++) {
    const p = hEma21[h - 1] - hEma50[h - 1];
    const c = hEma21[h] - hEma50[h];
    if (p !== 0 && c !== 0 && p * c < 0) crosses++;
  }
  const crossRate = crosses / lookbackH;

  const adxSeries = computeAdx(candles.slice(Math.max(0, i - 96 * 4), i + 1), 14);
  const tail = adxSeries.slice(-96).filter(Number.isFinite);
  const avgAdx = tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 25;

  // Default chop unless 1h trend is clearly established (avoids weak TREND bucket losses).
  if (crossRate < 0.006 && avgAdx >= 27) return "TREND_SEASON";
  return "CHOP_SEASON";
}

function applyMacroProfile(opts, macroMode, cfg) {
  const profile = TREND_HTF_ST_MACRO_PROFILES[macroMode] ?? TREND_HTF_ST_MACRO_PROFILES.TREND_SEASON;
  return {
    ...opts,
    ...profile,
    minHtfSep: profile.minHtfSep,
    tpTrendOk: Number(cfg.trendHtfStRegimeTpTrend ?? profile.tpTrendOk),
    tpMixed: Number(cfg.trendHtfStRegimeTpMixed ?? profile.tpMixed),
    tpChop: Number(cfg.trendHtfStRegimeTpChop ?? profile.tpChop),
  };
}

export function buildTrendHtfStRegimeOpts(cfg = {}) {
  const d = TREND_HTF_ST_REGIME_DEFAULTS;
  return {
    stPeriod: Number(cfg.supertrendPeriod ?? 10),
    stMultiplier: Number(cfg.supertrendMultiplier ?? 2.5),
    htfCrossLookbackHours: Number(cfg.trendHtfStRegimeHtfCrossLookbackHours ?? d.htfCrossLookbackHours),
    minHtfTrendAgeHours: Number(cfg.trendHtfStRegimeMinHtfTrendAgeHours ?? d.minHtfTrendAgeHours),
    crossBypassMinSep: Number(cfg.trendHtfStRegimeCrossBypassMinSep ?? d.crossBypassMinSep),
    crossBypassMinAdx: Number(cfg.trendHtfStRegimeCrossBypassMinAdx ?? d.crossBypassMinAdx),
    blockSidewaysTriple: cfg.trendHtfStRegimeBlockTriple !== false,
    blockWhipsawSideways: cfg.trendHtfStRegimeBlockWhipsaw === true,
    minHtfSep: Number(cfg.trendHtfStRegimeMinHtfSep ?? cfg.trendHtfStMinHtfSep ?? d.minHtfSep),
    sepShrinkThreshold: Number(cfg.trendHtfStRegimeSepShrinkThreshold ?? d.sepShrinkThreshold),
    maxPriorStSignals16: Number(cfg.trendHtfStRegimeMaxStFlips ?? d.maxPriorStSignals16),
    tpTrendOk: Number(cfg.trendHtfStRegimeTpTrend ?? cfg.supertrendFuturesFixedTpPct ?? d.tpTrendOk),
    tpMixed: Number(cfg.trendHtfStRegimeTpMixed ?? d.tpMixed),
    tpChop: Number(cfg.trendHtfStRegimeTpChop ?? d.tpChop),
    slDefault: Number(cfg.supertrendFuturesFixedSlPct ?? d.slDefault),
  };
}

export function isTrendHtfStRegimeGateEnabled(cfg = {}) {
  return cfg.trendHtfStRegimeGate === true;
}

/**
 * Resolve SL/TP for this entry from structural regime.
 * @returns {{ slPct: number, tpPct: number }}
 */
export function resolveTrendHtfStBrackets(regime, cfg = {}) {
  const o = buildTrendHtfStRegimeOpts(cfg);
  const slPct = o.slDefault;
  if (!regime) {
    return { slPct, tpPct: Number(cfg.supertrendFuturesFixedTpPct ?? o.tpTrendOk) };
  }
  if (regime.macroMode === "CHOP_SEASON") {
    return { slPct, tpPct: o.tpChop };
  }
  if (regime.structuralRisk === "TREND_OK") {
    return { slPct, tpPct: o.tpTrendOk };
  }
  if (regime.structuralRisk === "CHOP_ZONE") {
    return { slPct, tpPct: o.tpMixed };
  }
  return { slPct, tpPct: o.tpMixed };
}

/**
 * Block only loss-correlated entries in CHOP_SEASON (H2-style).
 * Jan TREND_SEASON trades pass through — preserves compounding.
 */
export function surgicalLossBlockReasons(state) {
  if (state.macroMode !== "CHOP_SEASON") return [];
  const reasons = [];
  const flags = state.flags ?? [];
  if (flags.includes("HTF_EMA_CROSS_RECENT") && !state.strongTrendBypass) {
    reasons.push("htf_cross_recent");
  }
  if (
    flags.includes("REGIME_SIDEWAYS") &&
    flags.includes("HTF_SEP_SHRINKING") &&
    state.adx15m < 22
  ) {
    reasons.push("sideways_triple");
  }
  if (flags.includes("ST_WHIPSAW") && flags.includes("REGIME_SIDEWAYS")) {
    reasons.push("st_whipsaw_sideways");
  }
  return reasons;
}

export function isTrendHtfStSurgicalLossFilterEnabled(cfg = {}) {
  return cfg.trendHtfStSurgicalLossFilter === true;
}

export function evaluateTrendHtfStRegime(candles, signalIdx, direction, cfg = {}) {
  const i = signalIdx;
  if (!candles?.length || i < TREND_HTF_ST_REGIME_WARMUP) return null;

  const macroMode = detectTrendHtfStMacroMode(candles, i);
  let opts = applyMacroProfile(buildTrendHtfStRegimeOpts(cfg), macroMode, cfg);

  const hourly = aggregateToHourly(candles.slice(0, i + 1));
  if (hourly.length < 55) return null;

  const hCloses = hourly.map((c) => c.close);
  const hEma21 = ema(hCloses, 21);
  const hEma50 = ema(hCloses, 50);
  const hIdx = hourIndexForBar(candles[i].ts, hourly);
  if (hIdx < 50) return null;

  const htfSepPct = htfSepAt(hEma21, hEma50, hIdx) ?? 0;
  const sepPrev = htfSepAt(hEma21, hEma50, Math.max(50, hIdx - 3)) ?? htfSepPct;
  const htfSepSlope = htfSepPct - sepPrev;
  const hoursSinceCross = hoursSinceHtfCross(hEma21, hEma50, hIdx, opts.htfCrossLookbackHours);
  const htfCrossRecent = hoursSinceCross <= opts.htfCrossLookbackHours;
  const trendMature = hoursSinceCross >= opts.minHtfTrendAgeHours;

  const adxSeries = computeAdx(candles.slice(0, i + 1), 14);
  const atrSeries = computeAtr(candles.slice(0, i + 1), 14);
  const adx15m = adxSeries[adxSeries.length - 1] ?? 0;
  const strongTrendBypass =
    htfSepPct >= opts.crossBypassMinSep && adx15m >= opts.crossBypassMinAdx;
  const atrVal = atrSeries[atrSeries.length - 1] ?? 0;
  const bar = candles[i];
  const regime15m = detectRegime15m(adx15m, atrVal, bar.close);
  const entryRangeAtr = atrVal > 0 ? (bar.high - bar.low) / atrVal : 0;

  const st = computeSupertrendSeries(candles.slice(0, i + 1), {
    period: opts.stPeriod,
    multiplier: opts.stMultiplier,
    wilderAtr: true,
  });
  const stFlipCount16 = countPriorStSignals(st, Math.max(TREND_HTF_ST_REGIME_WARMUP, i - 15), i);

  const flags = [];
  if (htfSepPct < opts.minHtfSep) flags.push("HTF_SEP_LOW");
  if (htfSepSlope < opts.sepShrinkThreshold) flags.push("HTF_SEP_SHRINKING");
  if (regime15m === "SIDEWAYS") flags.push("REGIME_SIDEWAYS");
  if (regime15m === "VOLATILE") flags.push("REGIME_VOLATILE");
  if (stFlipCount16 > opts.maxPriorStSignals16) flags.push("ST_WHIPSAW");
  if (htfCrossRecent) flags.push("HTF_EMA_CROSS_RECENT");
  if (!trendMature) flags.push("HTF_TREND_TOO_YOUNG");
  if (strongTrendBypass) flags.push("STRONG_TREND_BYPASS");
  if (entryRangeAtr > 2) flags.push("SPIKE_BAR");

  const sidewaysTriple =
    flags.includes("REGIME_SIDEWAYS") &&
    flags.includes("HTF_SEP_SHRINKING") &&
    adx15m < 22;

  let structuralRisk = "MIXED";
  if (
    (htfCrossRecent && !strongTrendBypass) ||
    sidewaysTriple ||
    (flags.includes("ST_WHIPSAW") && flags.includes("REGIME_SIDEWAYS"))
  ) {
    structuralRisk = "CHOP_ZONE";
  } else if (regime15m === "TRENDING" && htfSepPct >= 0.001 && trendMature) {
    structuralRisk = "TREND_OK";
  }

  const state = {
    macroMode,
    structuralRisk,
    flags,
    htfSepPct,
    htfSepSlope,
    adx15m,
    regime15m,
    stFlipCount16,
    hoursSinceCross,
    htfCrossRecent,
    trendMature,
    strongTrendBypass,
    entryRangeAtr,
    direction,
  };

  let blockReasons = [];
  const gateOn = isTrendHtfStRegimeGateEnabled(cfg);
  const surgicalOn = isTrendHtfStSurgicalLossFilterEnabled(cfg);

  if (gateOn) {
    if (flags.includes("HTF_SEP_LOW")) blockReasons.push("htf_sep_low");
    if (htfCrossRecent && !strongTrendBypass) {
      if (opts.minHtfTrendAgeHours > 0 && !trendMature) blockReasons.push("htf_cross_immature");
      else blockReasons.push("htf_cross_recent");
    }
    if (opts.blockSidewaysTriple && sidewaysTriple) blockReasons.push("sideways_triple");
    if (opts.blockWhipsawSideways && flags.includes("ST_WHIPSAW") && flags.includes("REGIME_SIDEWAYS")) {
      blockReasons.push("st_whipsaw");
    }
    if (
      opts.blockSepShrinking &&
      flags.includes("HTF_SEP_SHRINKING") &&
      (flags.includes("REGIME_SIDEWAYS") || macroMode === "CHOP_SEASON")
    ) {
      blockReasons.push("htf_sep_shrinking");
    }
  } else if (surgicalOn) {
    blockReasons = surgicalLossBlockReasons(state);
  }

  const allowEntry = blockReasons.length === 0;
  const entryBrackets = resolveTrendHtfStBrackets(
    { macroMode, structuralRisk, htfSepPct, flags, allowEntry },
    cfg,
  );

  return {
    allowEntry,
    blockReasons,
    ...state,
    brackets: entryBrackets,
    /** @deprecated alias */
    wouldBlock: !allowEntry,
    score: allowEntry ? (structuralRisk === "TREND_OK" ? 85 : 60) : 25,
    riskLevel: structuralRisk === "CHOP_ZONE" ? "high" : structuralRisk === "TREND_OK" ? "low" : "medium",
  };
}

export function shouldAllowTrendHtfStEntry(candles, signalIdx, direction, cfg = {}) {
  if (!isTrendHtfStRegimeGateEnabled(cfg) && !isTrendHtfStSurgicalLossFilterEnabled(cfg)) {
    return true;
  }
  const r = evaluateTrendHtfStRegime(candles, signalIdx, direction, cfg);
  if (!r) return true;
  return r.allowEntry;
}

export function classifyTrendHtfStTradeOutcome(trade) {
  const mfe = Number(trade.mfePct ?? 0) * 100;
  const bars = Number(trade.barsHeld ?? 0);
  const isLoss = Number(trade.netPnl) <= 0;
  if (!isLoss) {
    if (trade.exitReason === "tp") return "WIN_TP";
    if (trade.exitReason === "trail") return "WIN_TRAIL";
    return "WIN_OTHER";
  }
  if (trade.exitReason === "sl" && bars <= 3 && mfe < 0.35) return "INSTANT_SL";
  if (trade.exitReason === "sl" && mfe >= 1.0) return "WHIPSAW_GAVE_BACK";
  if (trade.exitReason === "sl" && bars <= 8 && mfe < 0.5) return "FAST_FAIL";
  if (trade.exitReason === "flip" || trade.exitReason === "signal_flip") return "ST_FLIP_EXIT";
  return "LOSS_OTHER";
}
