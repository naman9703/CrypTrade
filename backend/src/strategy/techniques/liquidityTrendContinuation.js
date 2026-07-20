/**
 * Trend-day continuation — catch 1–2 moves/day when classical PDH/PDL sweep+reclaim
 * does not fire (common on breakdown days: price never sweeps PDH for shorts).
 *
 * SHORT after PDL break + bear HTF: fade rally to EMA9 or displacement bar.
 * LONG after PDH break + bull HTF: fade dip to EMA9 or displacement bar.
 */

import { computeLiquidityBrackets, dayStartIndex, utcDayId } from "./liquidity.js";
import { inSmcKillzone } from "./sessionKillzones.js";

function avgVolume(volumes, idx, lookback = 20) {
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

function barsBelowLevel(candles, idx, dayStart, level) {
  let n = 0;
  for (let j = dayStart; j <= idx; j++) {
    if (candles[j].close < level) n++;
  }
  return n;
}

function barsAboveLevel(candles, idx, dayStart, level) {
  let n = 0;
  for (let j = dayStart; j <= idx; j++) {
    if (candles[j].close > level) n++;
  }
  return n;
}

function dayExtreme(candles, idx, dayStart, pick) {
  let v = pick === "low" ? Infinity : -Infinity;
  for (let j = dayStart; j <= idx; j++) {
    v = pick === "low" ? Math.min(v, candles[j].low) : Math.max(v, candles[j].high);
  }
  return Number.isFinite(v) ? v : 0;
}

/**
 * @param {object[]} candles
 * @param {number} idx
 * @param {'BUY'|'SELL'} side
 * @param {object} pre
 * @param {object} opts
 */
export function evaluateTrendContinuationSetup(candles, idx, side, pre, opts = {}) {
  if (opts.intradayLiqTrendContinuation !== true) return null;
  if (opts.intradayLiqTrendSellOnly === true && side === "BUY") return null;
  if (!candles?.length || idx < 5) return null;

  const bar = candles[idx];
  const pdh = pre.prevDayHigh?.[idx];
  const pdl = pre.prevDayLow?.[idx];
  if (!(pdh > 0) || !(pdl > 0)) return null;

  const requireHtf = opts.intradayLiqTrendRequireHtf !== false;
  if (requireHtf) {
    if (side === "SELL" && !pre.htfDown?.[idx]) return null;
    if (side === "BUY" && !pre.htfUp?.[idx]) return null;
  }

  const dayStart = dayStartIndex(candles, idx);
  const minBarsBelow = Math.max(2, Number(opts.intradayLiqTrendMinBarsBeyondLevel ?? 2));
  const minAdx = Number(opts.intradayLiqTrendMinAdx ?? 18);
  const adx = pre.adxSeries?.[idx];
  if (minAdx > 0 && (!Number.isFinite(adx) || adx < minAdx)) return null;

  const e9 = fadeEma(pre, idx, opts);
  if (!Number.isFinite(e9)) return null;

  const rsi = pre.rsiSeries?.[idx];
  const rsiMinShort = Number(opts.intradayLiqTrendRsiMinShort ?? 34);
  const rsiMaxShort = Number(opts.intradayLiqTrendRsiMaxShort ?? 55);
  const rsiMinLong = Number(opts.intradayLiqTrendRsiMinLong ?? 42);
  const rsiMaxLong = Number(opts.intradayLiqTrendRsiMaxLong ?? 58);

  const atr = pre.atrSeries?.[idx];
  const atrPct = atr > 0 && bar.close > 0 ? atr / bar.close : 0;
  const minDispAtr = Number(opts.intradayLiqTrendMinDispAtr ?? 0.45);
  const minRvol = Number(opts.intradayLiqTrendMinRvol ?? 1.0);
  const volAvg = avgVolume(pre.volumes, idx);
  const rvol = volAvg > 0 ? Number(bar.volume) / volAvg : 1;
  const fadeMinRvol = Number(opts.intradayLiqTrendFadeMinRvol ?? minRvol);

  let broken = false;
  if (side === "SELL") {
    broken = barsBelowLevel(candles, idx, dayStart, pdl) >= minBarsBelow || bar.close < pdl;
  } else {
    broken = barsAboveLevel(candles, idx, dayStart, pdh) >= minBarsBelow || bar.close > pdh;
  }
  if (!broken) return null;

  const kz = String(opts.intradayLiqTrendKillzone ?? "").toUpperCase();
  if (kz && kz !== "ALL" && !inSmcKillzone(candles[idx].ts, kz)) return null;

  const trendOnlyBreakdown = opts.intradayLiqTrendOnlyBreakdownDays === true;
  const onBreakdown = isBreakdownDay(candles, idx, pre);
  const onBreakout = isBreakoutDay(candles, idx, pre);
  if (trendOnlyBreakdown) {
    if (side === "SELL" && !onBreakdown) return null;
    if (side === "BUY" && !onBreakout) return null;
  }

  if (opts.intradayLiqBreakdownDayBias !== false) {
    if (side === "BUY" && onBreakdown) return null;
    if (side === "SELL" && onBreakout) return null;
  }

  const body = Math.abs(bar.close - bar.open);
  const range = Math.max(1e-9, bar.high - bar.low);
  const bodyRatio = body / range;
  const bearish = bar.close < bar.open;
  const bullish = bar.close > bar.open;

  const dayLow = dayExtreme(candles, idx, dayStart, "low");
  const dayHigh = dayExtreme(candles, idx, dayStart, "high");
  const dayOpen = candles[dayStart]?.open ?? bar.open;
  const dayRangePct =
    dayOpen > 0 ? (dayHigh - dayLow) / dayOpen : 0;
  const minDayRangePct = Number(opts.intradayLiqTrendMinDayRangePct ?? 0);
  if (minDayRangePct > 0 && dayRangePct < minDayRangePct) return null;

  const dayHighBuffer = Number(opts.intradayLiqTrendDayHighBuffer ?? 3);

  const lhFadeShort =
    onBreakdown || bar.high < dayHigh - dayHighBuffer;
  const fadeShort =
    side === "SELL" &&
    bar.high >= e9 * 0.997 &&
    bar.close < e9 &&
    bearish &&
    bodyRatio >= Number(opts.intradayLiqTrendMinBodyRatio ?? 0.35) &&
    (!Number.isFinite(rsi) || (rsi >= rsiMinShort && rsi <= rsiMaxShort)) &&
    lhFadeShort;
  const fadeLong =
    side === "BUY" &&
    bar.low <= e9 * 1.003 &&
    bar.close > e9 &&
    bullish &&
    bodyRatio >= Number(opts.intradayLiqTrendMinBodyRatio ?? 0.35) &&
    (!Number.isFinite(rsi) || (rsi >= rsiMinLong && rsi <= rsiMaxLong));
  const displacementShort =
    side === "SELL" &&
    bearish &&
    atr > 0 &&
    body >= minDispAtr * atr &&
    rvol >= minRvol &&
    bar.close < bar.low + range * 0.35 &&
    (!Number.isFinite(rsi) || rsi <= rsiMaxShort + 5);
  const displacementLong =
    side === "BUY" &&
    bullish &&
    atr > 0 &&
    body >= minDispAtr * atr &&
    rvol >= minRvol &&
    bar.close > bar.high - range * 0.35 &&
    (!Number.isFinite(rsi) || rsi >= rsiMinLong - 5);

  if (!(fadeShort || fadeLong || displacementShort || displacementLong)) return null;
  if (fadeShort && fadeMinRvol > 0 && rvol < fadeMinRvol) return null;
  if (fadeLong && fadeMinRvol > 0 && rvol < fadeMinRvol) return null;
  const fadeHighAdxMin = Number(opts.intradayLiqTrendFadeHighAdxMin ?? 0);
  const fadeExemptDayRange =
    fadeHighAdxMin > 0 && Number.isFinite(adx) && adx >= fadeHighAdxMin;
  const dispOnly = opts.intradayLiqTrendDisplacementOnly === true;
  const fadeOk = (fadeShort || fadeLong) && fadeExemptDayRange;
  if (dispOnly && !(displacementShort || displacementLong || fadeOk)) return null;
  const fadeMinAdx = Number(opts.intradayLiqTrendFadeMinAdx ?? 0);
  if (fadeShort && fadeMinAdx > 0 && (!Number.isFinite(adx) || adx < fadeMinAdx) && !displacementShort)
    return null;
  const minLiqQ = Number(opts.intradayLiqTrendMinLiqQuality ?? 0);

  const lookback = Math.max(2, Math.min(8, Number(opts.intradayLiqTrendSwingLookback ?? 4)));
  const slice = candles.slice(Math.max(dayStart, idx - lookback + 1), idx + 1);
  const sweepWick =
    side === "SELL"
      ? Math.max(...slice.map((c) => c.high))
      : Math.min(...slice.map((c) => c.low));

  const maxFadeDayRange = Number(opts.intradayLiqTrendFadeMaxDayRangePct ?? 0.035);
  if (fadeShort && maxFadeDayRange > 0 && dayRangePct > maxFadeDayRange && !fadeExemptDayRange)
    return null;
  if (fadeLong && maxFadeDayRange > 0 && dayRangePct > maxFadeDayRange && !fadeExemptDayRange)
    return null;

  const opposing =
    side === "SELL"
      ? Math.min(dayLow, pdl * 0.998)
      : Math.max(dayHigh, pdh * 1.002);

  const isDisp = displacementShort || displacementLong;
  const br = resolveTrendBrackets(side, bar.close, sweepWick, opposing, atr, opts, isDisp);
  if (!br) return null;
  const liqQuality = 50 + (displacementShort || displacementLong ? 25 : 10) + Math.min(20, rvol * 5);
  if (minLiqQ > 0 && liqQuality < minLiqQ) return null;

  const trigger = displacementShort || displacementLong ? "trend_disp" : "trend_fade";
  const techniques = ["liq_trend_cont", side === "SELL" ? "pdl_break" : "pdh_break", trigger];

  return {
    side,
    action: side,
    level: side === "SELL" ? pdl : pdh,
    levelType: side === "SELL" ? "pdl_break" : "pdh_break",
    wick: sweepWick,
    sweepWick: sweepWick,
    sweepStartIdx: Math.max(dayStart, idx - lookback),
    reclaimIdx: idx,
    entry: bar.close,
    extension: side === "SELL" ? (sweepWick - pdl) / pdl : (pdh - sweepWick) / pdh,
    liqQuality,
    ...br,
    techniques,
    score: Math.min(
      14,
      Math.round(7 + (displacementShort || displacementLong ? 3 : 1) + Math.min(3, rvol)),
    ),
    trendMeta: { trigger, rvol, adx, broken, opposing },
  };
}

/** Liquidity TP first; ATR fallback only when pool brackets are null (late breakdown). */
function resolveTrendBrackets(side, entry, sweepWick, opposingLevel, atr, opts = {}, isDisplacement = false) {
  const br = computeLiquidityBrackets(side, entry, sweepWick, opposingLevel, opts);
  if (br) return br;

  const fallbackOnlyDisp = opts.intradayLiqTrendAtrDispOnly !== false;
  if (
    opts.intradayLiqTrendAtrFallback === false ||
    !(atr > 0) ||
    (fallbackOnlyDisp && !isDisplacement)
  ) {
    return null;
  }

  const mult = Number(opts.intradayLiqTrendAtrTpMult ?? 2.0);
  const fill = Number(entry);
  const atrOpposing = side === "SELL" ? fill - mult * atr : fill + mult * atr;
  const relaxed = {
    ...opts,
    intradayLiqMinRr: Number(opts.intradayLiqTrendAtrMinRr ?? 1.2),
  };
  const atrBr = computeLiquidityBrackets(side, entry, sweepWick, atrOpposing, relaxed);
  if (atrBr) atrBr.tpMode = `${atrBr.tpMode || "session_liquidity"}_atr_fallback`;
  return atrBr;
}

function fadeEma(pre, idx, opts) {
  const period = Number(opts.intradayLiqTrendFadeEma ?? 21);
  if (period === 9) return pre.ema9?.[idx];
  return pre.ema21?.[idx] ?? pre.ema9?.[idx];
}

/** Breakdown / breakout day — block classical counter-trend liquidity fades. */
export function isBreakdownDay(candles, idx, pre) {
  const pdl = pre.prevDayLow?.[idx];
  if (!(pdl > 0)) return false;
  const dayStart = dayStartIndex(candles, idx);
  return barsBelowLevel(candles, idx, dayStart, pdl) >= 4;
}

export function isBreakoutDay(candles, idx, pre) {
  const pdh = pre.prevDayHigh?.[idx];
  if (!(pdh > 0)) return false;
  const dayStart = dayStartIndex(candles, idx);
  return barsAboveLevel(candles, idx, dayStart, pdh) >= 4;
}

/** Gate classical PDH/PDL reclaims on trend days. Trend continuation uses levelType pdl_break/pdh_break. */
export function vetoClassicalLiqOnTrendDay(setup, candles, idx, pre, opts = {}) {
  if (opts.intradayLiqBreakdownDayBias === false || !setup) return false;
  const isTrend = setup.levelType === "pdl_break" || setup.levelType === "pdh_break";
  if (isTrend) return false;
  if (opts.intradayLiqClassicOnTrendDays === false) {
    if (isBreakdownDay(candles, idx, pre) || isBreakoutDay(candles, idx, pre)) return true;
  }
  if (setup.side === "BUY" && setup.levelType === "pdl" && isBreakdownDay(candles, idx, pre)) return true;
  if (setup.side === "SELL" && setup.levelType === "pdh" && isBreakoutDay(candles, idx, pre)) return true;
  return false;
}

/**
 * Skip counter-trend liquidity fades when HTF disagrees.
 * Applies to PDH/PDL and session clusters — same knife/rally + trend-day rules.
 */
export function vetoCounterTrendLiqSetup(setup, candles, idx, pre, opts = {}) {
  if (opts.intradayLiqVetoCounterTrend !== true || !setup) return false;

  const fadeLow =
    setup.side === "BUY" &&
    (setup.levelType === "pdl" || setup.levelType === "session_low");
  const fadeHigh =
    setup.side === "SELL" &&
    (setup.levelType === "pdh" || setup.levelType === "session_high");

  if (fadeLow && pre.htfDown?.[idx]) return true;
  if (fadeHigh && pre.htfUp?.[idx]) return true;

  if (opts.intradayLiqBreakdownDayBias !== false) {
    if (fadeLow && isBreakoutDay(candles, idx, pre)) return true;
    if (fadeHigh && isBreakdownDay(candles, idx, pre)) return true;
  }

  if (setup.side === "BUY" && setup.levelType === "pdl") {
    if (opts.intradayLiqClassicRequireHtfUp === true && !pre.htfUp?.[idx]) return true;
  }

  const isTrend = setup.levelType === "pdl_break" || setup.levelType === "pdh_break";
  if (opts.intradayLiqTrendSellOnly === true && setup.side === "BUY" && isTrend) return true;
  return false;
}
