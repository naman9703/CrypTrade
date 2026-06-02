/**
 * Swing-based Fibonacci retracement — pivot legs + golden-zone rejection.
 *
 * Professional use: trade pullbacks in the direction of the last impulse leg,
 * entering at 0.5–0.618 (golden pocket) after a wick rejection, with HTF trend aligned.
 */

import { rejectionWickRatio } from "./liquidity.js";
import { buildFibEntryContext } from "../intradayFibContext.js";
import { applyFibVetoes } from "../intradayFibLearnedRules.js";

export const FIB_RATIOS = Object.freeze({
  shallow: 0.382,
  mid: 0.5,
  golden: 0.618,
  deep: 0.786,
});

const DEFAULT_ALLOWED = [FIB_RATIOS.mid, FIB_RATIOS.golden];

/** @deprecated Use findImpulseLeg — rolling window extrema (loose). */
export function swingHighLow(candles, endIdx, lookback = 48) {
  const start = Math.max(0, endIdx - lookback + 1);
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = start; i <= endIdx; i++) {
    hi = Math.max(hi, candles[i].high);
    lo = Math.min(lo, candles[i].low);
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) return null;
  return { high: hi, low: lo, range: hi - lo };
}

export function isPivotHigh(candles, i, left = 3, right = 3) {
  const h = candles[i].high;
  for (let j = i - left; j <= i + right; j++) {
    if (j === i || j < 0 || j >= candles.length) continue;
    if (candles[j].high > h) return false;
  }
  return true;
}

export function isPivotLow(candles, i, left = 3, right = 3) {
  const l = candles[i].low;
  for (let j = i - left; j <= i + right; j++) {
    if (j === i || j < 0 || j >= candles.length) continue;
    if (candles[j].low < l) return false;
  }
  return true;
}

/**
 * Last confirmed pivot high/low inside lookback — forms the active impulse leg.
 * @returns {{ direction: 'up'|'down', high: number, low: number, highIdx: number, lowIdx: number, range: number } | null}
 */
export function findImpulseLeg(candles, endIdx, opts = {}) {
  const left = Math.max(1, Math.round(Number(opts.pivotLeft ?? 3)));
  const right = Math.max(1, Math.round(Number(opts.pivotRight ?? 3)));
  const lookback = Math.max(20, Math.round(Number(opts.lookback ?? 80)));
  const start = Math.max(0, endIdx - lookback);

  let lastHigh = null;
  let lastLow = null;

  for (let i = endIdx - right; i >= start + left; i--) {
    if (isPivotHigh(candles, i, left, right)) {
      if (!lastHigh || i > lastHigh.i) lastHigh = { i, price: candles[i].high };
    }
    if (isPivotLow(candles, i, left, right)) {
      if (!lastLow || i > lastLow.i) lastLow = { i, price: candles[i].low };
    }
  }

  if (!lastHigh || !lastLow) return null;

  if (lastHigh.i > lastLow.i) {
    const range = lastHigh.price - lastLow.price;
    if (range <= 0) return null;
    return {
      direction: "up",
      high: lastHigh.price,
      low: lastLow.price,
      highIdx: lastHigh.i,
      lowIdx: lastLow.i,
      range,
    };
  }
  if (lastLow.i > lastHigh.i) {
    const range = lastHigh.price - lastLow.price;
    if (range <= 0) return null;
    return {
      direction: "down",
      high: lastHigh.price,
      low: lastLow.price,
      highIdx: lastHigh.i,
      lowIdx: lastLow.i,
      range,
    };
  }
  return null;
}

/** Uptrend pullback: levels from swing low → high. Downtrend: high → low. */
export function fibLevels(swing, direction = "up") {
  if (!swing) return [];
  const { high, low, range } = swing;
  const ratios = swing.ratios ?? [0.382, 0.5, 0.618, 0.786];
  if (direction === "up") {
    return ratios.map((r) => ({ ratio: r, price: high - range * r, kind: "retrace_up" }));
  }
  return ratios.map((r) => ({ ratio: r, price: low + range * r, kind: "retrace_down" }));
}

export function nearFibLevel(price, levels, tolPct = 0.0022) {
  if (!levels?.length || !Number.isFinite(price)) return null;
  for (const lv of levels) {
    if (lv.price > 0 && Math.abs(price - lv.price) / lv.price <= tolPct) {
      return lv;
    }
  }
  return null;
}

/**
 * Bar must interact with fib zone (wick through level) and close back in trade direction.
 */
/**
 * Reject the main loss pattern: 0.5 level tag while close is in the golden pocket (or vice versa).
 */
export function fibHitMatchesRetrace(hit, retrace, opts = {}) {
  if (!hit || !Number.isFinite(retrace)) return false;
  const goldenLo = Number(opts.intradayFibGoldenRetraceMin ?? 0.55);
  const goldenHi = Number(opts.intradayFibGoldenRetraceMax ?? 0.68);
  const midLo = Number(opts.intradayFibMidRetraceMin ?? 0.45);
  const midHi = Number(opts.intradayFibMidRetraceMax ?? 0.54);
  const isGoldenHit = Math.abs(hit.ratio - FIB_RATIOS.golden) < 0.001;
  const isMidHit = Math.abs(hit.ratio - FIB_RATIOS.mid) < 0.001;
  if (isGoldenHit) return retrace >= goldenLo && retrace <= goldenHi;
  if (isMidHit) return retrace >= midLo && retrace <= midHi;
  return true;
}

export function fibZoneRejection(bar, levels, side, tolPct = 0.0018) {
  if (!levels?.length || !bar) return null;
  for (const lv of levels) {
    if (!Number.isFinite(lv.price) || lv.price <= 0) continue;
    const tol = lv.price * tolPct;
    if (side === "BUY") {
      const touched = bar.low <= lv.price + tol;
      const held = bar.close >= lv.price - tol && bar.close > bar.open;
      if (touched && held) return lv;
    } else {
      const touched = bar.high >= lv.price - tol;
      const held = bar.close <= lv.price + tol && bar.close < bar.open;
      if (touched && held) return lv;
    }
  }
  return null;
}

function normalizeAllowedRatios(raw) {
  const src = Array.isArray(raw) && raw.length ? raw : DEFAULT_ALLOWED;
  return src.map((r) => Number(r)).filter((r) => Number.isFinite(r) && r > 0 && r < 1);
}

/**
 * Core fib pullback rules for a single bar (no confirmation bar).
 * @returns {ReturnType<evaluateFibRetraceSetup> | null}
 */
export function evaluateFibRetraceBar(candles, idx, opts = {}, pre = null) {
  const bar = candles[idx];
  if (!bar || idx < 20) return null;

  const leg = findImpulseLeg(candles, idx, {
    pivotLeft: opts.intradayFibPivotLeft,
    pivotRight: opts.intradayFibPivotRight,
    lookback: opts.intradayFibLookback ?? 80,
  });
  if (!leg) return null;

  const maxBarsSinceSwing = Math.max(8, Math.round(Number(opts.intradayFibMaxBarsSinceSwing ?? 28)));
  const swingEndIdx = leg.direction === "up" ? leg.highIdx : leg.lowIdx;
  if (idx - swingEndIdx > maxBarsSinceSwing) return null;

  const atr =
    pre?.atrSeries?.[idx] ??
    (bar.close > 0 && Number.isFinite(bar.close) ? bar.close * 0.002 : null);
  if (!Number.isFinite(atr) || atr <= 0) return null;

  const minLegAtr = Math.max(1.2, Number(opts.intradayFibMinLegAtrMult ?? 2));
  if (leg.range < atr * minLegAtr) return null;

  const minRet = Number(opts.intradayFibMinRetraceRatio ?? 0.48);
  const maxRet = Number(opts.intradayFibMaxRetraceRatio ?? 0.72);
  const allowed = normalizeAllowedRatios(opts.intradayFibAllowedRatios);
  const tolPct = Math.max(0.0008, Number(opts.intradayFibTolPct ?? 0.0016));
  const minWick = Number(opts.intradayFibMinWickRatio ?? 0.4);
  const minAdx = Number(opts.intradayFibMinAdx ?? 22);

  if (pre?.adxSeries?.[idx] != null && Number.isFinite(pre.adxSeries[idx]) && pre.adxSeries[idx] < minAdx) {
    return null;
  }

  const htfMode = String(opts.intradayFibHtfAlignMode ?? "").toLowerCase();
  const requireHtf =
    htfMode === "required" ||
    (htfMode !== "soft" && htfMode !== "off" && opts.intradayFibRequireHtfAlign !== false);
  const minHtfSep = Number(opts.intradayFibMinHtfSep ?? 0.00055);
  const side = leg.direction === "up" ? "BUY" : "SELL";

  if (htfMode !== "off" && requireHtf && pre) {
    if (side === "BUY" && !pre.htfUp[idx]) return null;
    if (side === "SELL" && !pre.htfDown[idx]) return null;
    if (Number.isFinite(pre.htfSep?.[idx]) && pre.htfSep[idx] < minHtfSep) return null;
  } else if (htfMode === "soft" && pre) {
    if (side === "BUY" && pre.htfDown[idx] && (pre.htfSep?.[idx] ?? 0) >= minHtfSep) return null;
    if (side === "SELL" && pre.htfUp[idx] && (pre.htfSep?.[idx] ?? 0) >= minHtfSep) return null;
  }

  const ema9 = pre?.ema9?.[idx];
  if (Number.isFinite(ema9)) {
    if (side === "BUY" && bar.close < ema9 * 0.9995) return null;
    if (side === "SELL" && bar.close > ema9 * 1.0005) return null;
  }

  const hour = Math.floor((bar.ts % 86_400_000) / 3_600_000);
  const sessStart = Number(opts.intradayFibSessionStartHour ?? 8);
  const sessEnd = Number(opts.intradayFibSessionEndHour ?? 20);
  if (hour < sessStart || hour >= sessEnd) return null;

  const retrace =
    leg.direction === "up"
      ? (leg.high - bar.close) / leg.range
      : (bar.close - leg.low) / leg.range;

  if (retrace < minRet || retrace > maxRet) return null;

  const levels = fibLevels(leg, leg.direction === "up" ? "up" : "down").filter((l) =>
    allowed.some((r) => Math.abs(r - l.ratio) < 0.001),
  );
  const hit = fibZoneRejection(bar, levels, side, tolPct);
  if (!hit) return null;
  if (opts.intradayFibRequireRetraceCoherence !== false && !fibHitMatchesRetrace(hit, retrace, opts)) {
    return null;
  }

  const wick = rejectionWickRatio(bar, side);
  if (wick < minWick) return null;

  if (opts.intradayFibRequireRsiAlign !== false && pre?.rsiSeries) {
    const rsi = pre.rsiSeries[idx];
    const recent = pre.rsiSeries.slice(Math.max(0, idx - 10), idx + 1);
    if (!Number.isFinite(rsi)) return null;
    if (side === "BUY") {
      if (!recent.some((r) => r <= 44)) return null;
      if (rsi < 36 || rsi > 54) return null;
    } else {
      if (!recent.some((r) => r >= 56)) return null;
      if (rsi > 64 || rsi < 46) return null;
    }
  }

  if (side === "BUY" && bar.low < leg.low * (1 - tolPct * 2)) return null;
  if (side === "SELL" && bar.high > leg.high * (1 + tolPct * 2)) return null;

  const close = bar.close;
  const swing = computeFibSwingBrackets(side, leg, close, tolPct, opts);
  if (!swing) return null;
  const { slPct, tpPct, slPrice, tpPrice, tpMode, rr } = swing;

  const minRr = Number(opts.intradayFibMinRr ?? 1.25);
  if (rr < minRr) return null;

  let score = 8;
  if (Math.abs(hit.ratio - FIB_RATIOS.golden) < 0.001) score += 2;
  if (pre?.htfSep?.[idx] >= 0.0007) score += 1;
  if (wick >= 0.5) score += 1;

  const draft = {
    side,
    ratio: hit.ratio,
    retrace,
    score,
    techniques: [`fib_${hit.ratio}`],
    slPct,
    tpPct,
    slPrice,
    tpPrice,
    tpMode,
    rr,
    leg,
  };

  if (opts.intradayFibLearnedRulesEnabled !== false) {
    const ctx = buildFibEntryContext(candles, idx, pre, draft, opts);
    const veto = applyFibVetoes(ctx, opts);
    if (!veto.allow) return null;
  }

  return draft;
}

/**
 * Swing-based fib brackets: SL beyond impulse extreme, TP at leg target (or partial leg).
 * Fibonacci entries always use this — never UI fixed %.
 */
export function computeFibSwingBrackets(side, leg, close, tolPct, opts = {}) {
  if (!leg || !Number.isFinite(close) || close <= 0) return null;
  const tpMode = String(opts.intradayFibTpMode ?? "leg").toLowerCase();
  let slPrice;
  let tpPrice;

  if (tpMode === "partial_leg") {
    const frac = Math.max(0.15, Math.min(0.55, Number(opts.intradayFibPartialLegFrac ?? 0.32)));
    if (side === "BUY") {
      slPrice = leg.low * (1 - tolPct);
      tpPrice = close + (leg.high - close) * frac;
    } else {
      slPrice = leg.high * (1 + tolPct);
      tpPrice = close - (close - leg.low) * frac;
    }
  } else if (tpMode === "extension") {
    /** 127.2% / 161.8% style target beyond the impulse extreme (trend continuation). */
    const extMult = Math.max(0.15, Math.min(0.85, Number(opts.intradayFibExtensionFrac ?? 0.272)));
    const ext = leg.range * extMult;
    if (side === "BUY") {
      slPrice = leg.low * (1 - tolPct);
      tpPrice = leg.high + ext;
    } else {
      slPrice = leg.high * (1 + tolPct);
      tpPrice = leg.low - ext;
    }
  } else {
    if (side === "BUY") {
      slPrice = leg.low * (1 - tolPct);
      tpPrice = leg.high;
    } else {
      slPrice = leg.high * (1 + tolPct);
      tpPrice = leg.low;
    }
  }

  let slPct;
  let tpPct;
  if (side === "BUY") {
    slPct = Math.max(0.002, (close - slPrice) / close);
    tpPct = Math.max(slPct * 1.35, (tpPrice - close) / close);
  } else {
    slPct = Math.max(0.002, (slPrice - close) / close);
    tpPct = Math.max(slPct * 1.35, (close - tpPrice) / close);
  }

  const rr = slPct > 0 ? tpPct / slPct : 0;
  return {
    slPct,
    tpPct,
    slPrice,
    tpPrice,
    tpMode: tpMode === "partial_leg" ? "partial_leg" : tpMode === "extension" ? "extension" : "leg",
    rr,
  };
}

/**
 * Fib SL/TP at fill — always swing structure from signal; repriced to % at actual entry.
 * Trading Panel fixed SL/TP is ignored when fibBrackets are present.
 */
export function resolveFibEntryBrackets(_cfg = {}, barSignal = null, entryFill = null, side = null) {
  const baked = barSignal?.fibBrackets;
  if (!baked || !(Number(baked.slPct) > 0)) return null;

  const tradeSide = side || barSignal?.action;
  const fill = Number(entryFill);
  let slPct = baked.slPct;
  let tpPct = baked.tpPct;
  let slPrice = Number(baked.slPrice);
  let tpPrice = Number(baked.tpPrice);
  const tpMode = baked.tpMode ?? "leg";

  if (fill > 0 && (tradeSide === "BUY" || tradeSide === "SELL")) {
    if (Number.isFinite(slPrice) && slPrice > 0 && Number.isFinite(tpPrice) && tpPrice > 0) {
      if (tradeSide === "BUY") {
        slPct = Math.max(0.0005, (fill - slPrice) / fill);
        tpPct = Math.max(0.0005, (tpPrice - fill) / fill);
      } else {
        slPct = Math.max(0.0005, (slPrice - fill) / fill);
        tpPct = Math.max(0.0005, (fill - tpPrice) / fill);
      }
    }
  }

  return {
    slPct,
    tpPct,
    slPrice: Number.isFinite(slPrice) && slPrice > 0 ? slPrice : null,
    tpPrice: Number.isFinite(tpPrice) && tpPrice > 0 ? tpPrice : null,
    rr: slPct > 0 ? tpPct / slPct : baked.rr,
    source: "swing",
    tpMode,
  };
}

/**
 * High-selectivity fib pullback entry (solo fib gate / strict mode).
 * Optional 2-bar confirmation: prior bar tags fib zone, entry bar breaks its high/low.
 */
export function evaluateFibRetraceSetup(candles, idx, opts = {}, pre = null) {
  const confirm = opts.intradayFibConfirmNextBar !== false;
  if (confirm && idx > 0) {
    const setup = evaluateFibRetraceBar(candles, idx - 1, opts, pre);
    if (!setup) return null;
    const bar = candles[idx];
    if (setup.side === "BUY") {
      if (bar.close <= candles[idx - 1].high) return null;
      if (bar.close <= bar.open) return null;
    } else {
      if (bar.close >= candles[idx - 1].low) return null;
      if (bar.close >= bar.open) return null;
    }
    const legFresh = findImpulseLeg(candles, idx, {
      pivotLeft: opts.intradayFibPivotLeft,
      pivotRight: opts.intradayFibPivotRight,
      lookback: opts.intradayFibLookback ?? 80,
    });
    if (!legFresh || legFresh.direction !== setup.leg?.direction) return null;
    const tolPct = Math.max(0.0008, Number(opts.intradayFibTolPct ?? 0.0016));
    const swing = computeFibSwingBrackets(setup.side, legFresh, bar.close, tolPct, opts);
    if (!swing) return null;
    const minRr = Number(opts.intradayFibMinRr ?? 1.25);
    if (swing.rr < minRr) return null;
    return {
      ...setup,
      ...swing,
      leg: legFresh,
      score: setup.score + 1,
      techniques: [...setup.techniques, "fib_confirm"],
    };
  }
  return evaluateFibRetraceBar(candles, idx, opts, pre);
}
