/**
 * Transparent setup scanners — shared by year study and live situation router.
 */

import { computeLiquidityBrackets, dayStartIndex, sweepReclaim } from "../techniques/liquidity.js";
import { utcHourFromTs } from "../techniques/sessionKillzones.js";
import { SETUP_TRIGGERS } from "./situationConstants.js";

function avgVol(volumes, idx, lookback = 20) {
  let sum = 0;
  let n = 0;
  for (let j = Math.max(0, idx - lookback); j < idx; j++) {
    const v = Number(volumes[j]);
    if (Number.isFinite(v) && v > 0) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

function dayExtreme(candles, idx, dayStart, pick) {
  let v = pick === "low" ? Infinity : -Infinity;
  for (let j = dayStart; j <= idx; j++) {
    v = pick === "low" ? Math.min(v, candles[j].low) : Math.max(v, candles[j].high);
  }
  return Number.isFinite(v) ? v : 0;
}

function swingExtreme(candles, idx, dayStart, side, lookback = 3) {
  const slice = candles.slice(Math.max(dayStart, idx - lookback + 1), idx + 1);
  return side === "SELL"
    ? Math.max(...slice.map((c) => c.high))
    : Math.min(...slice.map((c) => c.low));
}

export function buildSituationBrackets(side, entry, slPrice, tp2R = 2.5, partialR = 1.5) {
  const fill = Number(entry);
  const sl = Number(slPrice);
  if (!(fill > 0) || !(sl > 0)) return null;
  const risk = Math.abs(fill - sl);
  if (!(risk > 0)) return null;
  const tp1Price = side === "BUY" ? fill + partialR * risk : fill - partialR * risk;
  const tp2Price = side === "BUY" ? fill + tp2R * risk : fill - tp2R * risk;
  return {
    slPct: risk / fill,
    tpPct: Math.abs(tp2Price - fill) / fill,
    tp1Pct: Math.abs(tp1Price - fill) / fill,
    slPrice: sl,
    tpPrice: tp2Price,
    tp2Price,
    tp1Price,
    partialTp: true,
    tp2Enabled: true,
    partialFrac: 0.5,
    rr: tp2R,
    tpMode: "situation_structure",
  };
}

function baseSetup(side, trigger, entry, slPrice, score, techniques, meta = {}) {
  const br = buildSituationBrackets(side, entry, slPrice, meta.tp2R ?? 2.5, meta.partialR ?? 1.5);
  if (!br) return null;
  return {
    side,
    action: side,
    trigger,
    entry,
    score,
    techniques: ["situation", trigger, ...techniques],
    ...br,
    situationMeta: meta,
  };
}

function rvolAt(pre, idx, bar) {
  const avg = avgVol(pre.volumes, idx);
  return avg > 0 ? Number(bar.volume) / avg : 1;
}

function sessionLabel(ts) {
  const h = utcHourFromTs(ts);
  if (h >= 0 && h < 7) return "ASIA";
  if (h >= 7 && h < 12) return "LONDON";
  if (h >= 12 && h < 21) return "NY";
  return "LATE";
}

export function scanLhFadeShort(candles, idx, pre, dayState, opts = {}) {
  const bar = candles[idx];
  const pdl = pre.prevDayLow?.[idx];
  const onRangeAbovePdl = pdl > 0 && bar.close > pdl;
  if (!dayState.bearBias && !onRangeAbovePdl) return null;
  const dayStart = dayStartIndex(candles, idx);
  const barsFromOpen = idx - dayStart;
  if (onRangeAbovePdl && !dayState.bearBias) {
    const minBars = opts.lhFadeMinBarsFromOpen ?? 4;
    const maxBars = opts.lhFadeMaxBarsFromOpen ?? 28;
    if (barsFromOpen < minBars || barsFromOpen > maxBars) return null;
  }
  const prev = candles[idx - 1];
  if (!prev) return null;
  const e21 = pre.ema21?.[idx];
  const atr = pre.atrSeries?.[idx];
  const adx = pre.adxSeries?.[idx];
  const rsi = pre.rsiSeries?.[idx];
  if (!Number.isFinite(e21) || !(atr > 0)) return null;
  const rvol = rvolAt(pre, idx, bar);
  const body = Math.abs(bar.close - bar.open);
  const range = Math.max(1e-9, bar.high - bar.low);
  const bearish = bar.close < bar.open;
  const dayHighBuffer = opts.dayHighBuffer ?? 3;
  const lhOk = bar.high < dayState.dayHigh - dayHighBuffer || dayState.bearBias || onRangeAbovePdl;
  if (
    !bearish ||
    bar.high < e21 * 0.997 ||
    bar.close >= e21 ||
    body / range < (opts.minBodyRatio ?? 0.35) ||
    !lhOk
  ) {
    return null;
  }
  if ((opts.fadeMinAdx ?? 20) > 0 && (!Number.isFinite(adx) || adx < opts.fadeMinAdx)) return null;
  if ((opts.fadeMinRvol ?? 1.0) > 0 && rvol < opts.fadeMinRvol) return null;
  if (Number.isFinite(rsi) && (rsi < (opts.rsiMinShort ?? 34) || rsi > (opts.rsiMaxShort ?? 55))) return null;

  const slPrice = swingExtreme(candles, idx, dayStart, "SELL", 3) + atr * (opts.slAtrMult ?? 0.1);
  let score = 8 + Math.min(3, rvol);
  if (pre.htfDown?.[idx]) score += 2;
  return baseSetup("SELL", SETUP_TRIGGERS.LH_FADE_SHORT, bar.close, slPrice, score, ["lh_fade"], {
    rvol,
    adx,
  });
}

export function scanLhFadeLong(candles, idx, pre, dayState, opts = {}) {
  if (!dayState.bullBias) return null;
  const bar = candles[idx];
  const e21 = pre.ema21?.[idx];
  const atr = pre.atrSeries?.[idx];
  const adx = pre.adxSeries?.[idx];
  const rsi = pre.rsiSeries?.[idx];
  if (!Number.isFinite(e21) || !(atr > 0)) return null;
  const rvol = rvolAt(pre, idx, bar);
  const dayStart = dayStartIndex(candles, idx);
  const body = Math.abs(bar.close - bar.open);
  const range = Math.max(1e-9, bar.high - bar.low);
  const bullish = bar.close > bar.open;
  if (
    !bullish ||
    bar.low > e21 * 1.003 ||
    bar.close <= e21 ||
    body / range < (opts.minBodyRatio ?? 0.35)
  ) {
    return null;
  }
  if ((opts.fadeMinAdx ?? 20) > 0 && (!Number.isFinite(adx) || adx < opts.fadeMinAdx)) return null;
  if ((opts.fadeMinRvol ?? 1.0) > 0 && rvol < opts.fadeMinRvol) return null;
  if (Number.isFinite(rsi) && (rsi < (opts.rsiMinLong ?? 42) || rsi > (opts.rsiMaxLong ?? 58))) return null;

  const slPrice = swingExtreme(candles, idx, dayStart, "BUY", 3) - atr * (opts.slAtrMult ?? 0.1);
  let score = 8 + Math.min(3, rvol);
  if (pre.htfUp?.[idx]) score += 2;
  return baseSetup("BUY", SETUP_TRIGGERS.LH_FADE_LONG, bar.close, slPrice, score, ["lh_fade"], { rvol, adx });
}

export function scanRetestShort(candles, idx, pre, dayState, opts = {}) {
  if (!dayState.bearBias) return null;
  const barsSince = dayState.barsSinceDispIdx(idx, "SELL");
  const maxBars = opts.retestMaxBars ?? 12;
  if (barsSince > maxBars || barsSince < 1) return null;
  const bar = candles[idx];
  const breakLevel = dayState.breakLevel ?? pre.prevDayLow?.[idx];
  const adx = pre.adxSeries?.[idx];
  const rsi = pre.rsiSeries?.[idx];
  const rvol = rvolAt(pre, idx, bar);
  const buffer = opts.retestBuffer ?? 3;
  if (!(breakLevel > 0) || bar.close > breakLevel + buffer) return null;
  if (bar.close >= bar.open) return null;
  if ((opts.retestMinAdx ?? 18) > 0 && (!Number.isFinite(adx) || adx < opts.retestMinAdx)) return null;
  if ((opts.retestMinRvol ?? 0.8) > 0 && rvol < opts.retestMinRvol) return null;
  if (Number.isFinite(rsi) && (rsi < (opts.rsiMinShort ?? 34) || rsi > (opts.rsiMaxShort ?? 55))) return null;
  if (!pre.htfDown?.[idx]) return null;

  const atr = pre.atrSeries?.[idx] ?? 0;
  const dayStart = dayStartIndex(candles, idx);
  const slPrice = swingExtreme(candles, idx, dayStart, "SELL", 3) + atr * 0.1;
  return baseSetup("SELL", SETUP_TRIGGERS.RETEST_SHORT, bar.close, slPrice, 9 + Math.min(2, rvol), ["retest"], {
    barsSince,
    rvol,
  });
}

export function scanRetestLong(candles, idx, pre, dayState, opts = {}) {
  if (!dayState.bullBias) return null;
  const barsSince = dayState.barsSinceDispIdx(idx, "BUY");
  const maxBars = opts.retestMaxBars ?? 12;
  if (barsSince > maxBars || barsSince < 1) return null;
  const bar = candles[idx];
  const breakLevel = dayState.bullBreakLevel ?? pre.prevDayHigh?.[idx];
  const adx = pre.adxSeries?.[idx];
  const rsi = pre.rsiSeries?.[idx];
  const rvol = rvolAt(pre, idx, bar);
  const buffer = opts.retestBuffer ?? 3;
  if (!(breakLevel > 0) || bar.close < breakLevel - buffer) return null;
  if (bar.close <= bar.open) return null;
  if ((opts.retestMinAdx ?? 18) > 0 && (!Number.isFinite(adx) || adx < opts.retestMinAdx)) return null;
  if ((opts.retestMinRvol ?? 0.8) > 0 && rvol < opts.retestMinRvol) return null;
  if (!pre.htfUp?.[idx]) return null;

  const atr = pre.atrSeries?.[idx] ?? 0;
  const dayStart = dayStartIndex(candles, idx);
  const slPrice = swingExtreme(candles, idx, dayStart, "BUY", 3) - atr * 0.1;
  return baseSetup("BUY", SETUP_TRIGGERS.RETEST_LONG, bar.close, slPrice, 9 + Math.min(2, rvol), ["retest"], {
    barsSince,
    rvol,
  });
}

export function scanDisplacementShort(candles, idx, pre, dayState, opts = {}) {
  const bar = candles[idx];
  const pdl = pre.prevDayLow?.[idx];
  const onRangeAbovePdl = pdl > 0 && bar.close > pdl;
  if (!dayState.bearBias && !onRangeAbovePdl) return null;
  const atr = pre.atrSeries?.[idx];
  const adx = pre.adxSeries?.[idx];
  const rsi = pre.rsiSeries?.[idx];
  const rvol = rvolAt(pre, idx, bar);
  if (!(atr > 0)) return null;
  const body = Math.abs(bar.close - bar.open);
  const range = Math.max(1e-9, bar.high - bar.low);
  const minDispAtr = opts.minDispAtr ?? 0.42;
  const minRvol = opts.dispMinRvol ?? 2.5;
  if (bar.close >= bar.open) return null;
  if (body < minDispAtr * atr) return null;
  if (rvol < minRvol) return null;
  if (bar.close > bar.low + range * 0.35) return null;
  if ((opts.dispMinAdx ?? 18) > 0 && (!Number.isFinite(adx) || adx < opts.dispMinAdx)) return null;
  if (Number.isFinite(rsi) && rsi > (opts.rsiMaxShort ?? 58)) return null;
  if (!pre.htfDown?.[idx]) return null;

  const dayStart = dayStartIndex(candles, idx);
  if (onRangeAbovePdl && !dayState.bearBias) {
    const barsFromOpen = idx - dayStart;
    const maxBars = opts.rangeDispMaxBarsFromOpen ?? 32;
    if (barsFromOpen > maxBars) return null;
    if (dayState.dayRangePct() > (opts.maxDispDayRangePct ?? 0.03)) return null;
  }
  const prevLow = idx > 0 ? candles[idx - 1].low : bar.low;
  if (bar.close >= prevLow) return null;
  const slPrice = swingExtreme(candles, idx, dayStart, "SELL", 3) + atr * 0.1;
  return baseSetup("SELL", SETUP_TRIGGERS.DISPLACEMENT_SHORT, bar.close, slPrice, 10 + Math.min(3, rvol), [
    "displacement",
  ], { rvol, adx });
}

export function scanDisplacementLong(candles, idx, pre, dayState, opts = {}) {
  if (!dayState.bullBias) return null;
  const bar = candles[idx];
  const atr = pre.atrSeries?.[idx];
  const rvol = rvolAt(pre, idx, bar);
  if (!(atr > 0)) return null;
  const body = Math.abs(bar.close - bar.open);
  const range = Math.max(1e-9, bar.high - bar.low);
  if (bar.close <= bar.open) return null;
  if (body < (opts.minDispAtr ?? 0.42) * atr) return null;
  if (rvol < (opts.dispMinRvol ?? 2.5)) return null;
  if (bar.close < bar.high - range * 0.35) return null;
  if (!pre.htfUp?.[idx]) return null;

  const dayStart = dayStartIndex(candles, idx);
  const prevHigh = idx > 0 ? candles[idx - 1].high : bar.high;
  if (bar.close <= prevHigh) return null;
  const slPrice = swingExtreme(candles, idx, dayStart, "BUY", 3) - atr * 0.1;
  return baseSetup("BUY", SETUP_TRIGGERS.DISPLACEMENT_LONG, bar.close, slPrice, 10 + Math.min(3, rvol), [
    "displacement",
  ], { rvol });
}

export function scanFailShort(candles, idx, pre, dayState, opts = {}) {
  if (!dayState.bearBias) return null;
  const bar = candles[idx];
  const prev = candles[idx - 1];
  if (!prev) return null;
  const e21 = pre.ema21?.[idx];
  const atr = pre.atrSeries?.[idx];
  const rvol = rvolAt(pre, idx, bar);
  if (!Number.isFinite(e21) || !(atr > 0)) return null;
  if (!(prev.close > e21 && bar.close < e21 && bar.close < bar.open)) return null;
  if (rvol < (opts.failMinRvol ?? 1.2)) return null;
  if (!pre.htfDown?.[idx]) return null;

  const dayStart = dayStartIndex(candles, idx);
  const slPrice = swingExtreme(candles, idx, dayStart, "SELL", 3) + atr * 0.1;
  return baseSetup("SELL", SETUP_TRIGGERS.FAIL_SHORT, bar.close, slPrice, 9 + Math.min(2, rvol), ["fail"], {
    rvol,
  });
}

export function scanFailLong(candles, idx, pre, dayState, opts = {}) {
  if (!dayState.bullBias) return null;
  const bar = candles[idx];
  const prev = candles[idx - 1];
  if (!prev) return null;
  const e21 = pre.ema21?.[idx];
  const atr = pre.atrSeries?.[idx];
  const rvol = rvolAt(pre, idx, bar);
  if (!Number.isFinite(e21) || !(atr > 0)) return null;
  if (!(prev.close < e21 && bar.close > e21 && bar.close > bar.open)) return null;
  if (rvol < (opts.failMinRvol ?? 1.2)) return null;
  if (!pre.htfUp?.[idx]) return null;

  const dayStart = dayStartIndex(candles, idx);
  const slPrice = swingExtreme(candles, idx, dayStart, "BUY", 3) - atr * 0.1;
  return baseSetup("BUY", SETUP_TRIGGERS.FAIL_LONG, bar.close, slPrice, 9 + Math.min(2, rvol), ["fail"], { rvol });
}

export function scanExhaustionLong(candles, idx, pre, dayState, opts = {}) {
  const bar = candles[idx];
  const dayStart = dayStartIndex(candles, idx);
  const minBarsFromOpen = opts.exhaustionMinBarsFromOpen ?? 20;
  if (minBarsFromOpen > 0 && idx - dayStart < minBarsFromOpen) return null;
  if (!pre.htfDown?.[idx]) return null;
  const dayLow = dayExtreme(candles, idx, dayStart, "low");
  const rsi = pre.rsiSeries?.[idx];
  const atr = pre.atrSeries?.[idx];
  const rvol = rvolAt(pre, idx, bar);
  const range = Math.max(1e-9, bar.high - bar.low);
  const lowerWick = (Math.min(bar.open, bar.close) - bar.low) / range;
  const prevDayLow = idx > 0 ? dayExtreme(candles, idx - 1, dayStart, "low") : dayLow;
  const newLow = bar.low <= dayLow && bar.low < prevDayLow;
  if (!newLow) return null;
  if (lowerWick < (opts.exhaustionMinWick ?? 0.42)) return null;
  if (Number.isFinite(rsi) && rsi >= (opts.exhaustionRsiMax ?? 42)) return null;
  if (rvol < (opts.exhaustionMinRvol ?? 1.6)) return null;
  if (!(atr > 0)) return null;

  const slPrice = bar.low - atr * (opts.exhaustionSlAtr ?? 0.4);
  const partialR = opts.exhaustionPartialR ?? 1.8;
  const tp2R = opts.exhaustionTp2R ?? 1.8;
  return baseSetup("BUY", SETUP_TRIGGERS.EXHAUSTION_LONG, bar.close, slPrice, 8 + Math.min(2, rvol), [
    "exhaustion",
  ], { rvol, partialR, tp2R });
}

export function scanExhaustionShort(candles, idx, pre, dayState, opts = {}) {
  const bar = candles[idx];
  const dayStart = dayStartIndex(candles, idx);
  const dayHigh = dayExtreme(candles, idx, dayStart, "high");
  const rsi = pre.rsiSeries?.[idx];
  const atr = pre.atrSeries?.[idx];
  const rvol = rvolAt(pre, idx, bar);
  const range = Math.max(1e-9, bar.high - bar.low);
  const upperWick = (bar.high - Math.max(bar.open, bar.close)) / range;
  const prevDayHigh = idx > 0 ? dayExtreme(candles, idx - 1, dayStart, "high") : dayHigh;
  const newHigh = bar.high >= dayHigh && bar.high > prevDayHigh;
  if (!newHigh) return null;
  if (upperWick < (opts.exhaustionMinWick ?? 0.42)) return null;
  if (Number.isFinite(rsi) && rsi <= (opts.exhaustionRsiMin ?? 58)) return null;
  if (rvol < (opts.exhaustionMinRvol ?? 1.6)) return null;
  if (!(atr > 0)) return null;

  const slPrice = bar.high + atr * (opts.exhaustionSlAtr ?? 0.4);
  return baseSetup("SELL", SETUP_TRIGGERS.EXHAUSTION_SHORT, bar.close, slPrice, 8 + Math.min(2, rvol), [
    "exhaustion",
  ], { rvol, partialR: 1.8, tp2R: 1.8 });
}

export function scanClassicalPdlReclaim(candles, idx, pre, _dayState, opts = {}) {
  const pdl = pre.prevDayLow?.[idx];
  const pdh = pre.prevDayHigh?.[idx];
  if (!(pdl > 0) || !(pdh > 0)) return null;
  const bar = candles[idx];
  const sweepPct = opts.sweepPct ?? 0.001;
  if (!sweepReclaim(bar, pdl, "BUY", sweepPct)) return null;
  if (!pre.htfUp?.[idx] && opts.requireHtfAlign !== false) return null;
  const rvol = rvolAt(pre, idx, bar);
  if (rvol < (opts.classicalMinRvol ?? 1.0)) return null;

  const br = computeLiquidityBrackets("BUY", bar.close, bar.low, pdh, opts);
  if (!br) return null;
  return {
    side: "BUY",
    action: "BUY",
    trigger: SETUP_TRIGGERS.CLASSICAL_PDL_RECLAIM,
    entry: bar.close,
    score: 7 + Math.min(3, rvol),
    techniques: ["situation", "classical_pdl"],
    ...br,
    situationMeta: { rvol },
  };
}

export function scanClassicalPdhReclaim(candles, idx, pre, _dayState, opts = {}) {
  const pdl = pre.prevDayLow?.[idx];
  const pdh = pre.prevDayHigh?.[idx];
  if (!(pdl > 0) || !(pdh > 0)) return null;
  const bar = candles[idx];
  const sweepPct = opts.sweepPct ?? 0.001;
  if (!sweepReclaim(bar, pdh, "SELL", sweepPct)) return null;
  if (!pre.htfDown?.[idx] && opts.requireHtfAlign !== false) return null;
  const rvol = rvolAt(pre, idx, bar);
  if (rvol < (opts.classicalMinRvol ?? 1.0)) return null;

  const br = computeLiquidityBrackets("SELL", bar.close, bar.high, pdl, opts);
  if (!br) return null;
  return {
    side: "SELL",
    action: "SELL",
    trigger: SETUP_TRIGGERS.CLASSICAL_PDH_RECLAIM,
    entry: bar.close,
    score: 7 + Math.min(3, rvol),
    techniques: ["situation", "classical_pdh"],
    ...br,
    situationMeta: { rvol },
  };
}

export function scanSessionExtremeFade(candles, idx, pre, dayState, opts = {}) {
  const bar = candles[idx];
  const sess = sessionLabel(bar.ts);
  const atr = pre.atrSeries?.[idx];
  const rvol = rvolAt(pre, idx, bar);
  if (!(atr > 0)) return null;
  const dayStart = dayStartIndex(candles, idx);
  const asianH = pre.asianHigh?.[idx];
  const asianL = pre.asianLow?.[idx];
  const pdh = pre.prevDayHigh?.[idx];
  const pdl = pre.prevDayLow?.[idx];

  let side = null;
  let level = null;
  if (sess === "ASIA" && asianH > 0 && bar.high >= asianH * 0.999 && bar.close < bar.open) {
    side = "SELL";
    level = asianH;
  } else if (sess === "ASIA" && asianL > 0 && bar.low <= asianL * 1.001 && bar.close > bar.open) {
    side = "BUY";
    level = asianL;
  } else if (sess === "LONDON" && pdh > 0 && bar.high >= pdh * 0.9995 && bar.close < bar.open) {
    side = "SELL";
    level = pdh;
  } else if (sess === "LONDON" && pdl > 0 && bar.low <= pdl * 1.0005 && bar.close > bar.open) {
    side = "BUY";
    level = pdl;
  }
  if (!side) return null;
  if (rvol < (opts.sessionMinRvol ?? 1.0)) return null;

  const slPrice =
    side === "SELL"
      ? swingExtreme(candles, idx, dayStart, "SELL", 3) + atr * 0.1
      : swingExtreme(candles, idx, dayStart, "BUY", 3) - atr * 0.1;
  return baseSetup(side, SETUP_TRIGGERS.SESSION_EXTREME_FADE, bar.close, slPrice, 7 + Math.min(2, rvol), [
    "session_fade",
    sess.toLowerCase(),
  ], { rvol, level });
}

export function scanSqueezeBreak(candles, idx, pre, _dayState, opts = {}) {
  const bar = candles[idx];
  const atr = pre.atrSeries?.[idx];
  const adx = pre.adxSeries?.[idx];
  if (!(atr > 0)) return null;
  const lookback = opts.donchLookback ?? 20;
  const start = Math.max(0, idx - lookback);
  const hh = Math.max(...candles.slice(start, idx).map((c) => c.high));
  const ll = Math.min(...candles.slice(start, idx).map((c) => c.low));
  const rvol = rvolAt(pre, idx, bar);
  let side = null;
  if (bar.close > hh && bar.close > bar.open && (adx ?? 0) >= (opts.squeezeMinAdx ?? 18)) side = "BUY";
  else if (bar.close < ll && bar.close < bar.open && (adx ?? 0) >= (opts.squeezeMinAdx ?? 18)) side = "SELL";
  if (!side) return null;
  if (rvol < (opts.squeezeMinRvol ?? 1.5)) return null;

  const dayStart = dayStartIndex(candles, idx);
  const slPrice =
    side === "BUY" ? ll - atr * 0.15 : hh + atr * 0.15;
  return baseSetup(side, SETUP_TRIGGERS.SQUEEZE_BREAK, bar.close, slPrice, 8 + Math.min(2, rvol), [
    "squeeze_break",
  ], { rvol });
}

export const SCANNER_MAP = {
  lh_fade_short: scanLhFadeShort,
  lh_fade_long: scanLhFadeLong,
  retest_short: scanRetestShort,
  retest_long: scanRetestLong,
  displacement_short: scanDisplacementShort,
  displacement_long: scanDisplacementLong,
  fail_short: scanFailShort,
  fail_long: scanFailLong,
  exhaustion_long: scanExhaustionLong,
  exhaustion_short: scanExhaustionShort,
  classical_pdl_reclaim: scanClassicalPdlReclaim,
  classical_pdh_reclaim: scanClassicalPdhReclaim,
  session_extreme_fade: scanSessionExtremeFade,
  squeeze_break: scanSqueezeBreak,
};

export function scanSetup(trigger, candles, idx, pre, dayState, opts = {}) {
  const fn = SCANNER_MAP[trigger];
  return fn ? fn(candles, idx, pre, dayState, opts) : null;
}
