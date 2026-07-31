/**
 * MLCTS — multi-layer confluence engine (Layers 1–7 + composite + brackets).
 * Composes existing technique modules; causal (closed-bar only).
 */
import { ema, atr as atrSeries, adx as adxSeries } from "../indicators.js";
import {
  getConfirmedSwings,
  lastSwingHighBefore,
  lastSwingLowBefore,
  prevSwingHighBefore,
  prevSwingLowBefore,
} from "./marketStructure.js";
import { detectMarketBos } from "./bosChoch.js";
import { passesDisplacementAt } from "./displacement.js";
import { barDeltaMeta, buildCvdSeries } from "./orderFlow.js";
import { detectCvdDivergence, detectAbsorption, buildOrderFlowOpts } from "./orderFlowPatterns.js";
import { precomputeIntraday } from "../intradayPro.js";
import { buildRollingLiquidityPools } from "./liquidityMap.js";

export const MLCTS_WARMUP = 120;
/** Minimum bars to populate the live layer panel (trade logic still uses MLCTS_WARMUP). */
export const MLCTS_DISPLAY_WARMUP = 50;
export const MLCTS_PAD_BARS = 240;

export const MLCTS_DEFAULTS = Object.freeze({
  swingLeft: 3,
  swingRight: 3,
  swingConfirmBars: 2,
  sweepPct: 0.0006,
  equalHighTolAtr: 0.15,
  minAdx: 20,
  strongAdx: 25,
  scoreThreshold: 75,
  minLayerScore: 50,
  /** L6 positioning uses a lower bar (optional layer weight in composite). */
  minPositioningScore: 45,
  volGateAtrMult: 1.0,
  volGateRvol: 1.5,
  targetRr: 2,
  slAtrBuffer: 0.25,
  weightTrend: 20,
  weightLiquidity: 20,
  weightTrigger: 15,
  weightOrderFlow: 15,
  weightBook: 10,
  weightOi: 10,
  weightFunding: 5,
  requireOrderBook: false,
  requireOi: false,
});

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/** L5 internal blend slots — sum is the fixed denominator (never shrink when a slot is absent). */
export const MLCTS_L5_BLEND_WEIGHTS = Object.freeze({
  delta: 0.3,
  div: 0.3,
  abs: 0.2,
  book: 0.2,
});
export const MLCTS_L5_BLEND_DENOM =
  MLCTS_L5_BLEND_WEIGHTS.delta +
  MLCTS_L5_BLEND_WEIGHTS.div +
  MLCTS_L5_BLEND_WEIGHTS.abs +
  MLCTS_L5_BLEND_WEIGHTS.book;
export const MLCTS_L5_CORE_DENOM =
  MLCTS_L5_BLEND_WEIGHTS.delta + MLCTS_L5_BLEND_WEIGHTS.div + MLCTS_L5_BLEND_WEIGHTS.abs;

/**
 * Weighted blend with a fixed denominator.
 * null/undefined → slot counts as scored 0 (still in denominator).
 * Numeric 0 → scored 0 (same). Prevents co-component weight expansion when a slot is sparse/absent.
 */
export function fixedDenominatorWeightedScore(parts, totalDenominator) {
  const denom = num(totalDenominator, 0);
  if (!(denom > 0)) return 0;
  let numerator = 0;
  for (const p of parts) {
    const w = num(p.w, 0);
    const s = p.s == null ? 0 : num(p.s, 0);
    numerator += w * s;
  }
  return numerator / denom;
}

function layerResult(score, pass, detail = {}) {
  return { score: Math.round(Math.max(0, Math.min(100, score))), pass: Boolean(pass), detail };
}

function swingOptsFromMlcts(opts) {
  return {
    intradaySmcSwingLeft: num(opts.swingLeft, 3),
    intradaySmcSwingRight: num(opts.swingRight, 3),
    intradaySmcSwingConfirmBars: num(opts.swingConfirmBars, 2),
  };
}

function lookupSeriesAt(series, ts) {
  if (!Array.isArray(series) || !series.length) return null;
  let best = null;
  for (const row of series) {
    const t = num(row?.ts);
    if (t <= ts) best = row;
    else break;
  }
  return best;
}

function swingStructureBias(lastH, prevH, lastL, prevL) {
  if (!(lastH && prevH && lastL && prevL)) return "RANGE";
  const hh = lastH.price > prevH.price;
  const hl = lastL.price > prevL.price;
  const lh = lastH.price < prevH.price;
  const ll = lastL.price < prevL.price;
  if (hh && hl) return "BULL";
  if (lh && ll) return "BEAR";
  return "RANGE";
}

function emaTrendBias(e20, e50, e200, close) {
  const emaBull = e20 > e50 && e50 > e200;
  const emaBear = e20 < e50 && e50 < e200;
  if (emaBull && close > e200) return "BULL";
  if (emaBear && close < e200) return "BEAR";
  return "RANGE";
}

/**
 * Require swing structure and EMA stack to agree; RANGE on conflict.
 * Invalidates bear structure when close breaks above swing high (and bull mirror).
 */
export function resolveTrendBias({
  structureBias,
  emaBias,
  close,
  swingHigh = null,
  swingLow = null,
}) {
  let struct = structureBias;
  let structureInvalidated = null;

  if (struct === "BEAR" && swingHigh != null && close > swingHigh) {
    structureInvalidated = "bear_break_above_swing_high";
    struct = "RANGE";
  }
  if (struct === "BULL" && swingLow != null && close < swingLow) {
    structureInvalidated = "bull_break_below_swing_low";
    struct = "RANGE";
  }

  if (struct === "BULL" || struct === "BEAR") {
    if (emaBias === "RANGE") {
      return { bias: "RANGE", structureBias, emaBias, structureInvalidated, biasReason: "ema_mixed" };
    }
    if (struct === emaBias) {
      return { bias: struct, structureBias, emaBias, structureInvalidated, biasReason: "aligned" };
    }
    return { bias: "RANGE", structureBias, emaBias, structureInvalidated, biasReason: "structure_ema_conflict" };
  }

  if (structureInvalidated) {
    if (emaBias === "RANGE") {
      return {
        bias: "RANGE",
        structureBias,
        emaBias,
        structureInvalidated,
        biasReason: "structure_invalidated_ema_mixed",
      };
    }
    return { bias: emaBias, structureBias, emaBias, structureInvalidated, biasReason: structureInvalidated };
  }
  if (emaBias !== "RANGE") {
    return { bias: emaBias, structureBias, emaBias, structureInvalidated, biasReason: "ema_only" };
  }
  return { bias: "RANGE", structureBias, emaBias, structureInvalidated, biasReason: "no_signal" };
}

/** @param {object[]} candles @param {number} idx */
function evaluateTrendLayer(candles, idx, opts, pre) {
  const swingOpts = swingOptsFromMlcts(opts);
  const closes = candles.slice(0, idx + 1).map((c) => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);
  const i = closes.length - 1;
  const adxVal = num(pre?.adxSeries?.[idx], 0);
  const close = num(candles[idx]?.close);

  const lastH = lastSwingHighBefore(candles, idx, swingOpts);
  const prevH = prevSwingHighBefore(candles, idx, swingOpts);
  const lastL = lastSwingLowBefore(candles, idx, swingOpts);
  const prevL = prevSwingLowBefore(candles, idx, swingOpts);

  const structureBias = swingStructureBias(lastH, prevH, lastL, prevL);
  const emaBull = e20[i] > e50[i] && e50[i] > e200[i];
  const emaBear = e20[i] < e50[i] && e50[i] < e200[i];
  const emaBias = emaTrendBias(e20[i], e50[i], e200[i], close);
  const resolved = resolveTrendBias({
    structureBias,
    emaBias,
    close,
    swingHigh: lastH?.price ?? null,
    swingLow: lastL?.price ?? null,
  });
  const bias = resolved.bias;

  const adxStrength = clamp01(adxVal / 50);
  const emaSpread = e200[i] > 0 ? Math.abs(e20[i] - e200[i]) / e200[i] : 0;
  const emaStrength = clamp01(emaSpread / 0.05);
  const score = 60 * adxStrength + 40 * emaStrength;
  const pass = bias !== "RANGE" && adxVal >= num(opts.minAdx, 20) && score >= num(opts.minLayerScore, 50);

  return layerResult(score, pass, {
    bias,
    structureBias,
    emaBias,
    biasReason: resolved.biasReason,
    structureInvalidated: resolved.structureInvalidated,
    adx: adxVal,
    minAdx: num(opts.minAdx, 20),
    strongAdx: num(opts.strongAdx, 25),
    close,
    ema20: e20[i],
    ema50: e50[i],
    ema200: e200[i],
    emaStack: emaBull ? "BULL" : emaBear ? "BEAR" : "MIXED",
    priceAboveEma200: close > e200[i],
    swingHigh: lastH?.price ?? null,
    swingLow: lastL?.price ?? null,
    prevSwingHigh: prevH?.price ?? null,
    prevSwingLow: prevL?.price ?? null,
    hh: lastH && prevH ? lastH.price > prevH.price : null,
    hl: lastL && prevL ? lastL.price > prevL.price : null,
    lh: lastH && prevH ? lastH.price < prevH.price : null,
    ll: lastL && prevL ? lastL.price < prevL.price : null,
  });
}

function pushLevel(levels, price, type, strength = 1, extra = {}) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return;
  const touches = Number(extra.touches);
  levels.push({
    price: p,
    type,
    strength,
    touches: Number.isFinite(touches) && touches > 0 ? touches : null,
  });
}

/** Same UTC week id as `buildSessionLevels` in intradayPro.js */
function utcWeekId(ts) {
  return Math.floor(Number(ts) / (7 * 86_400_000));
}

/** Completed calendar weeks strictly before the current bar's week (causal). */
function completedUtcWeekBars(candles, idx) {
  const curWeek = utcWeekId(candles[idx]?.ts);
  /** @type {Map<number, { high: number, low: number }>} */
  const byWeek = new Map();
  for (let j = 0; j < idx; j++) {
    const w = utcWeekId(candles[j]?.ts);
    if (w >= curWeek) continue;
    const hi = num(candles[j].high);
    const lo = num(candles[j].low);
    const row = byWeek.get(w) ?? { high: -Infinity, low: Infinity };
    row.high = Math.max(row.high, hi);
    row.low = Math.min(row.low, lo);
    byWeek.set(w, row);
  }
  return [...byWeek.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({
      high: v.high > -Infinity ? v.high : null,
      low: v.low < Infinity ? v.low : null,
    }));
}

/**
 * Weekly H/L priority:
 * 1) Binance 1w REST cache (works on any intraday TF)
 * 2) Local resample when ≥2 completed UTC weeks in buffer
 * 3) pre.prevWeekHigh/Low after one week rollover in buffer
 */
function resolveWeeklyLevels(candles, idx, pre, externalWeekly = null) {
  if (externalWeekly && Number(externalWeekly.high) > 0 && Number(externalWeekly.low) > 0) {
    return {
      weeklyHigh: Number(externalWeekly.high),
      weeklyLow: Number(externalWeekly.low),
      weeklyReady: true,
      weeklySource: externalWeekly.source ?? "binance_1w",
      weeklyCompletedWeeks: completedUtcWeekBars(candles, idx).length,
    };
  }

  const weeklyBars = completedUtcWeekBars(candles, idx);
  const sessionHigh = pre?.prevWeekHigh?.[idx];
  const sessionLow = pre?.prevWeekLow?.[idx];
  const sessionOk =
    Number.isFinite(Number(sessionHigh)) &&
    Number(sessionHigh) > 0 &&
    Number.isFinite(Number(sessionLow)) &&
    Number(sessionLow) > 0;

  if (weeklyBars.length >= 2) {
    const prev = weeklyBars[weeklyBars.length - 1];
    if (prev.high > 0 && prev.low > 0) {
      return {
        weeklyHigh: prev.high,
        weeklyLow: prev.low,
        weeklyReady: true,
        weeklySource: "resample",
        weeklyCompletedWeeks: weeklyBars.length,
      };
    }
  }

  if (sessionOk) {
    return {
      weeklyHigh: Number(sessionHigh),
      weeklyLow: Number(sessionLow),
      weeklyReady: true,
      weeklySource: "session",
      weeklyCompletedWeeks: weeklyBars.length,
    };
  }

  return {
    weeklyHigh: null,
    weeklyLow: null,
    weeklyReady: false,
    weeklySource: null,
    weeklyCompletedWeeks: weeklyBars.length,
    weeklyReason:
      weeklyBars.length === 0
        ? "need_7d_history"
        : weeklyBars.length === 1
          ? "need_2nd_week"
          : "need_binance_1w",
  };
}

/** Completed HTF buckets strictly before the current bar's bucket (causal). */
function completedTfBars(candles, idx, stepMs) {
  const currentBucket = Math.floor(Number(candles[idx]?.ts) / stepMs) * stepMs;
  const out = [];
  let cur = null;
  for (let j = 0; j < idx; j++) {
    const c = candles[j];
    if (!c || Number(c.ts) >= currentBucket) continue;
    const bucket = Math.floor(Number(c.ts) / stepMs) * stepMs;
    if (!cur || cur.ts !== bucket) {
      if (cur) out.push(cur);
      cur = { ts: bucket, high: num(c.high), low: num(c.low) };
    } else {
      cur.high = Math.max(cur.high, num(c.high));
      cur.low = Math.min(cur.low, num(c.low));
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Max base strength assigned to any level type (equal highs/lows). */
export const MLCTS_MAX_LEVEL_STRENGTH = 30;

/**
 * ATR-normalized proximity for the trade-side target (0 at ≥3×ATR away, 1 at the level).
 * Instrument-adaptive — same principle as L3 sweep depth/ATR.
 */
export function proximityLinearForLevel(close, levelPrice, atrVal) {
  const dist = Math.abs(close - levelPrice);
  if (atrVal > 0) return clamp01(1 - dist / (atrVal * 3));
  return clamp01(1 - dist / Math.max(close, 1e-9));
}

/** @deprecated alias — proximity factor equals linear ATR proximity (no floor). */
export function proximityFactorForLevel(close, levelPrice, atrVal) {
  return proximityLinearForLevel(close, levelPrice, atrVal);
}

function diversityBaseForType(type) {
  const t = String(type ?? "");
  if (t.includes("equal")) return 1;
  if (t.startsWith("p") || t.startsWith("w")) return 0.85;
  if (t === "vwap") return 0.7;
  return 0.6;
}

/** Primary-type diversity base 0–1 (no confluence — see confluenceCountForLevel). */
export function primaryTypeStrengthForLevel(lv) {
  return diversityBaseForType(lv?.type);
}

/** Distinct level kinds merged to the same price (independent signals agreeing). */
export function confluenceCountForLevel(lv) {
  const types = Array.isArray(lv?.mergedTypes) && lv.mergedTypes.length ? lv.mergedTypes : [lv?.type].filter(Boolean);
  return types.length;
}

function touchScoreForLevel(lv) {
  const touches = num(lv?.touches, 0);
  if (touches >= 2) return clamp01(touches / 5);
  const t = String(lv?.type ?? "");
  if (t === "pdh" || t === "pdl") return 1;
  if (t.startsWith("weekly")) return 0.9;
  if (t === "vwap") return 0.75;
  if (t === "round") return 0.5;
  return 0.5;
}

/**
 * Additive structural significance 0–100 (touch + primary type; no distance gate).
 * Confluence is logged separately — not collapsed into this score (see confluenceCount).
 */
export function structuralStrengthForLevel(lv) {
  const touch = touchScoreForLevel(lv);
  const typeBase = primaryTypeStrengthForLevel(lv);
  return Math.round(100 * ((0.4 * touch + 0.25 * typeBase) / 0.65));
}

/** Tradeable-now strength: base(type) × ATR proximity. Capped at MLCTS_MAX_LEVEL_STRENGTH. */
export function effectiveLevelStrength(lv, close, atrVal) {
  const base = num(lv?.strength, 0);
  if (!(base > 0)) return 0;
  const eff = base * proximityLinearForLevel(close, num(lv.price), atrVal);
  return Math.round(Math.min(MLCTS_MAX_LEVEL_STRENGTH, eff));
}

/** Map effective strength (0–30) to the L2 layer score (0–100) used by minLayerScore / composite. */
export function strengthToLayerScore(strength) {
  return Math.round((num(strength, 0) / MLCTS_MAX_LEVEL_STRENGTH) * 100);
}

/** Round-number levels within ~max(6×ATR, 3.5% of price) — causal, no look-ahead. */
function buildPsychRoundLevels(close, atrVal) {
  if (!(close > 0)) return [];
  const band = Math.max(num(atrVal) * 6, close * 0.035);
  const lo = close - band;
  const hi = close + band;
  const inc =
    close >= 50_000 ? 1_000
    : close >= 10_000 ? 500
    : close >= 2_000 ? 100
    : close >= 200 ? 10
    : 1;
  const prices = [];
  const start = Math.floor(lo / inc) * inc;
  for (let p = start; p <= hi + 1e-9; p += inc) {
    if (p > 0) prices.push(p);
  }
  return prices;
}

/** Collapse near-duplicate prices; union distinct types; keep strongest primary type. */
function mergeLiquidityLevels(levels, tolPct = 0.0003) {
  const merged = [];
  for (const lv of levels) {
    const hit = merged.find((m) => Math.abs(m.price - lv.price) / Math.max(lv.price, 1e-9) <= tolPct);
    if (hit) {
      if (!hit.mergedTypes.includes(lv.type)) hit.mergedTypes.push(lv.type);
      if (lv.strength > hit.strength || (lv.strength === hit.strength && num(lv.touches, 0) > num(hit.touches, 0))) {
        hit.strength = lv.strength;
        hit.type = lv.type;
        hit.touches = lv.touches ?? hit.touches ?? null;
      }
    } else {
      merged.push({
        price: lv.price,
        type: lv.type,
        strength: lv.strength,
        touches: lv.touches ?? null,
        mergedTypes: [lv.type],
      });
    }
  }
  return merged;
}

function collectLiquidityLevels(candles, idx, pre, opts, externalWeekly = null) {
  const levels = [];
  const close = num(candles[idx]?.close);
  const atrVal = num(pre?.atrSeries?.[idx], 0);
  const atrPct = close > 0 ? atrVal / close : 0;

  pushLevel(levels, pre?.prevDayHigh?.[idx], "pdh", 25);
  pushLevel(levels, pre?.prevDayLow?.[idx], "pdl", 25);

  const weekly = resolveWeeklyLevels(candles, idx, pre, externalWeekly);
  if (weekly.weeklyReady) {
    pushLevel(levels, weekly.weeklyHigh, "weekly_high", 20);
    pushLevel(levels, weekly.weeklyLow, "weekly_low", 20);
  }

  pushLevel(levels, pre?.sessionVwap?.[idx], "vwap", 15);

  // Equal highs/lows: pivot highs cluster separately from pivot lows (min 2 touches).
  const eqPools = buildRollingLiquidityPools(candles, idx, {
    liqMapLookbackBars: Math.max(8, Math.min(48, idx)),
    liqMapSwingLeft: num(opts.swingLeft, 3),
    liqMapSwingRight: num(opts.swingRight, 3),
    liqMapMinTouches: 2,
    liqMapEqualTolPct: Math.max(0.0008, num(opts.equalHighTolAtr, 0.15) * atrPct),
    refAtrPct: atrPct,
    liqMapNormalizeThresholds: atrPct > 0,
  });
  for (const p of eqPools) {
    if (p.type === "equal_high") pushLevel(levels, p.level, "equal_high", 30, { touches: p.touches });
    if (p.type === "equal_low") pushLevel(levels, p.level, "equal_low", 30, { touches: p.touches });
  }

  for (const p of buildPsychRoundLevels(close, atrVal)) {
    pushLevel(levels, p, "round", 10);
  }

  const merged = mergeLiquidityLevels(levels, Math.max(0.0003, atrPct * 0.5));

  return {
    levels: merged,
    weeklyHigh: weekly.weeklyHigh,
    weeklyLow: weekly.weeklyLow,
    weeklyReady: weekly.weeklyReady,
    weeklySource: weekly.weeklySource,
    weeklyCompletedWeeks: weekly.weeklyCompletedWeeks,
    weeklyReason: weekly.weeklyReason ?? null,
  };
}

function evaluateLiquidityLayer(candles, idx, opts, pre, side, externalWeekly = null) {
  const close = num(candles[idx]?.close);
  const collected = collectLiquidityLevels(candles, idx, pre, opts, externalWeekly);
  const { levels, weeklyHigh, weeklyLow, weeklyReady, weeklySource, weeklyCompletedWeeks, weeklyReason } =
    collected;
  if (!levels.length) return layerResult(0, false, { levels: 0 });

  const atrVal = num(pre?.atrSeries?.[idx], 0);

  const targetLevel =
    side === "BUY"
      ? levels.filter((l) => l.price < close).sort((a, b) => b.price - a.price)[0] ?? null
      : levels.filter((l) => l.price > close).sort((a, b) => a.price - b.price)[0] ?? null;

  const baseStrength = targetLevel?.strength ?? null;
  const targetStrength = targetLevel ? effectiveLevelStrength(targetLevel, close, atrVal) : 0;
  const structuralStrength = targetLevel ? structuralStrengthForLevel(targetLevel) : 0;
  const targetScore = strengthToLayerScore(targetStrength);
  const pass = targetScore >= num(opts.minLayerScore, 50) && targetLevel != null;

  const byType = (t) => levels.find((l) => l.type === t)?.price ?? null;
  const countType = (t) => levels.filter((l) => l.type === t).length;

  const targetPrice = num(targetLevel?.price);
  const distancePct = targetPrice > 0 ? (Math.abs(close - targetPrice) / Math.max(close, 1e-9)) * 100 : null;
  const distanceAtr = targetPrice > 0 && atrVal > 0 ? Math.abs(close - targetPrice) / atrVal : null;
  const proxLinear = targetPrice > 0 ? proximityLinearForLevel(close, targetPrice, atrVal) : null;
  const levelBreakdown = {
    pdh: countType("pdh"),
    pdl: countType("pdl"),
    weekly: countType("weekly_high") + countType("weekly_low"),
    vwap: countType("vwap"),
    vwapMerged: 0,
    round: countType("round"),
    equal: countType("equal_high") + countType("equal_low"),
  };

  const sessionVwap = num(pre?.sessionVwap?.[idx]);
  const vwapStandalone = byType("vwap");
  const targetMerged = targetLevel?.mergedTypes ?? [];
  const vwapMergedIntoTarget =
    countType("vwap") === 0 && sessionVwap > 0 && targetMerged.includes("vwap");
  if (vwapMergedIntoTarget) levelBreakdown.vwapMerged = 1;

  return layerResult(targetScore, pass, {
    close,
    atr14: atrVal > 0 ? atrVal : null,
    level: targetLevel?.price ?? null,
    levelType: targetLevel?.type ?? null,
    baseStrength,
    targetStrength,
    structuralStrength,
    targetTouches: targetLevel?.touches ?? null,
    mergedTypes: targetLevel?.mergedTypes ?? (targetLevel?.type ? [targetLevel.type] : []),
    confluenceCount: targetLevel ? confluenceCountForLevel(targetLevel) : 0,
    primaryTypeStrength: targetLevel ? primaryTypeStrengthForLevel(targetLevel) : null,
    proximityFactor: proxLinear,
    proxLinear,
    distancePct,
    distanceAtr,
    proxBandAtr: 3,
    levelCount: levels.length,
    levelBreakdown,
    roundCount: countType("round"),
    pdh: byType("pdh"),
    pdl: byType("pdl"),
    weeklyHigh,
    weeklyLow,
    weeklyReady,
    weeklySource,
    weeklyCompletedWeeks,
    weeklyReason,
    vwap: vwapStandalone,
    sessionVwap: sessionVwap > 0 ? sessionVwap : null,
    vwapMergedIntoTarget,
    equalHighCount: countType("equal_high"),
    equalLowCount: countType("equal_low"),
    nearestEqualHigh:
      levels
        .filter((l) => l.type === "equal_high")
        .sort((a, b) => Math.abs(a.price - close) - Math.abs(b.price - close))[0]?.price ?? null,
    nearestEqualLow:
      levels
        .filter((l) => l.type === "equal_low")
        .sort((a, b) => Math.abs(a.price - close) - Math.abs(b.price - close))[0]?.price ?? null,
  });
}

export function sweepPoked(bar, level, side, sweepPct) {
  if (side === "BUY") return num(bar.low) < level * (1 - sweepPct);
  return num(bar.high) > level * (1 + sweepPct);
}

export function sweepReclaimedClose(bar, level, side) {
  if (side === "BUY") return num(bar.close) > level;
  return num(bar.close) < level;
}

/** How far close reclaimed past the level, as fraction of level price (pct as decimal). */
export function reclaimCloseBackPct(bar, level, side) {
  const close = num(bar.close);
  if (side === "BUY") {
    if (!(close > level)) return 0;
    return (close - level) / Math.max(level, 1e-9);
  }
  if (!(close < level)) return 0;
  return (level - close) / Math.max(level, 1e-9);
}

/**
 * Graded reclaim quality 0–maxPts: decisive close-back inside the level.
 * ATR-normalized when available (0.5×ATR inside = full marks); else pct fallback.
 */
export function reclaimScoreGraded(bar, level, side, atrVal, maxPts = 25) {
  const dist = side === "BUY" ? num(bar.close) - level : level - num(bar.close);
  if (!(dist > 0)) return 0;
  const pct = reclaimCloseBackPct(bar, level, side);
  const quality = atrVal > 0 ? clamp01(dist / (atrVal * 0.5)) : clamp01(pct / 0.002);
  return quality * maxPts;
}

/** Graded confirm 0–maxPts from swept level pedigree (base type + structural strength). */
export function confirmScoreFromLevel(baseStrength, structuralStrength, maxPts = 15) {
  const base = clamp01(num(baseStrength, 0) / MLCTS_MAX_LEVEL_STRENGTH);
  const structural = clamp01(num(structuralStrength, 0) / 100);
  return (0.55 * base + 0.45 * structural) * maxPts;
}

function normalizeLiqTarget(liqTarget) {
  if (liqTarget != null && typeof liqTarget === "object") {
    return {
      price: num(liqTarget.price ?? liqTarget.level),
      baseStrength: num(liqTarget.baseStrength, 15),
      structuralStrength: num(liqTarget.structuralStrength, 50),
      levelType: liqTarget.levelType ?? null,
      confluenceCount: num(liqTarget.confluenceCount, 1),
    };
  }
  return {
    price: num(liqTarget),
    baseStrength: 15,
    structuralStrength: 50,
    levelType: null,
    confluenceCount: 1,
  };
}

function evaluateSweepLayer(candles, idx, opts, pre, side, liqTarget) {
  const target = normalizeLiqTarget(liqTarget);
  const level = target.price;
  if (!(level > 0)) return layerResult(0, false, { reason: "no_level" });

  const bar = candles[idx];
  const sweepPct = num(opts.sweepPct, 0.0006);
  const swept = sweepPoked(bar, level, side, sweepPct);
  const reclaim = sweepReclaimedClose(bar, level, side);
  const ok = swept && reclaim;
  const atrVal = num(pre?.atrSeries?.[idx], 0);
  const wick = side === "BUY" ? num(bar.low) : num(bar.high);
  const close = num(bar.close);
  if (!ok) {
    return layerResult(0, false, {
      level,
      levelType: target.levelType,
      side,
      swept,
      reclaim,
      close,
      wick,
      sweepPct,
      sweepDepthAtr: null,
      closeBackPct: reclaim ? reclaimCloseBackPct(bar, level, side) : 0,
      atr: atrVal,
      reason: swept ? "no_reclaim" : reclaim ? "no_sweep_poke" : "no_sweep_reclaim",
    });
  }

  const depth = side === "BUY" ? (level - wick) / Math.max(atrVal, 1e-9) : (wick - level) / Math.max(atrVal, 1e-9);
  const depthScore = clamp01(depth / 0.5) * 60;
  const closeBackPct = reclaimCloseBackPct(bar, level, side);
  const reclaimScore = reclaimScoreGraded(bar, level, side, atrVal, 25);
  const confirmScore = confirmScoreFromLevel(target.baseStrength, target.structuralStrength, 15);
  const score = depthScore + reclaimScore + confirmScore;
  const pass = score >= num(opts.minLayerScore, 50);

  return layerResult(score, pass, {
    level,
    levelType: target.levelType,
    side,
    swept,
    reclaim,
    close,
    wick,
    sweepPct,
    sweepDepthAtr: depth,
    closeBackPct,
    levelBaseStrength: target.baseStrength,
    levelStructuralStrength: target.structuralStrength,
    confluenceCount: target.confluenceCount,
    atr: atrVal,
    depthScore: Math.round(depthScore),
    reclaimScore: Math.round(reclaimScore * 10) / 10,
    confirmScore: Math.round(confirmScore * 10) / 10,
  });
}

function evaluateStructureLayer(candles, idx, opts, pre, side) {
  const swingOpts = swingOptsFromMlcts(opts);
  const bos = detectMarketBos(candles, idx, side, swingOpts);
  const bar = candles[idx];
  const range = Math.max(1e-9, bar.high - bar.low);
  const bodyPct = Math.abs(bar.close - bar.open) / range;
  const disp = passesDisplacementAt(candles, idx, side, swingOpts, pre);
  const atrVal = num(pre?.atrSeries?.[idx], 0);
  const bodyAtr = atrVal > 0 ? Math.abs(bar.close - bar.open) / atrVal : 0;

  const breakScore = bos.ok ? 30 : 0;
  const bodyScore = 55 * clamp01(bodyPct / 0.7);
  const dispScore = disp ? 15 : 0;
  const score = breakScore + bodyScore + dispScore;
  const bodyGatePassed = bodyPct >= 0.7 || bodyAtr >= 1.5;
  const pass = bos.ok && bodyGatePassed && score >= num(opts.minLayerScore, 50);

  return layerResult(score, pass, {
    bos: bos.ok,
    bosType: bos.type ?? null,
    bosLevel: bos.ok ? bos.bosLevel : null,
    close: num(bar.close),
    bodyPct,
    bodyAtr,
    bodyPctMin: 0.7,
    bodyAtrMin: 1.5,
    bodyGatePassed,
    displacement: disp,
    displacementRequired: false,
    breakScore,
    bodyScore: Math.round(bodyScore),
    dispScore,
    range: num(bar.high) - num(bar.low),
  });
}

// Full order-flow opts (divergence lookback, absorption vol/range gates) — a bare
// `{ allowProxy: true }` leaves those thresholds undefined and silently breaks the detectors.
const MLCTS_OF_OPTS = buildOrderFlowOpts({ intradayOfAllowProxy: true, timeframe: "15m" });
/** Below this bar volume (buy+sell), treat aggTrade delta as placeholder / non-informative. */
const MLCTS_OF_THIN_VOL = 10;

function isThinOrderFlowBar(delta) {
  const total = num(delta.buy) + num(delta.sell);
  if (delta.tier === "none") return true;
  if (delta.tier === "aggtrade" && total <= MLCTS_OF_THIN_VOL) return true;
  return false;
}

/**
 * Book imbalance score 0–100 (continuous, no step cliffs).
 * imb = bidVolume / askVolume; imb=1 is balanced → score 50 for either side.
 *
 * score = 50 + 50 × tanh(dir × ln(imb) × k)
 *   dir = +1 BUY (favors imb>1), −1 SELL (favors imb<1)
 *   k = 1.25 (steepness; tuned so strong imbalance → ~100, inverse → ~0–15)
 *
 * Examples (SELL): 0.55→~83, 0.67→~78, 0.671→~78, 1.0→50, 3.0→~6
 * Examples (BUY):  0.55→~17, 0.99→~48, 1.0→50, 1.01→~52, 1.5→100, 3.0→~94
 */
export function orderFlowBookScore(imb, side) {
  if (!(imb > 0)) return null;
  const logI = Math.log(imb);
  const dir = side === "BUY" ? 1 : -1;
  const score = 50 + 50 * Math.tanh(dir * logI * 1.25);
  return Math.round(Math.max(0, Math.min(100, score)));
}

function orderFlowDeltaScore(deltaVal, side) {
  if (deltaVal === 0) return 0;
  const favorable = side === "BUY" ? deltaVal > 0 : deltaVal < 0;
  return favorable ? 70 : 30;
}

function evaluateOrderFlowLayer(candles, idx, pre, side, extras = {}) {
  const ofOpts = MLCTS_OF_OPTS;
  const delta = barDeltaMeta(candles[idx], ofOpts);
  const cvdDiv = detectCvdDivergence(candles, idx, side, pre, ofOpts);
  const absorption = detectAbsorption(candles, idx, side, pre, ofOpts);
  const cvd = num(pre?.cvd?.[idx], NaN);
  const thinData = isThinOrderFlowBar(delta);
  const imb = num(extras.orderBookImbalance, 0);

  const bookScore = orderFlowBookScore(imb, side);
  const deltaScore = thinData ? 0 : orderFlowDeltaScore(delta.delta, side);
  const divScore = cvdDiv ? 85 : 0;
  const absScore = absorption ? 75 : 0;

  const parts = [
    { w: MLCTS_L5_BLEND_WEIGHTS.delta, s: deltaScore, key: "delta" },
    { w: MLCTS_L5_BLEND_WEIGHTS.div, s: divScore, key: "div" },
    { w: MLCTS_L5_BLEND_WEIGHTS.abs, s: absScore, key: "abs" },
    { w: MLCTS_L5_BLEND_WEIGHTS.book, s: bookScore, key: "book" },
  ];
  const score = fixedDenominatorWeightedScore(parts, MLCTS_L5_BLEND_DENOM);
  const pass = !thinData && score >= 50;

  return layerResult(score, pass, {
    side,
    delta: delta.delta,
    buyVol: delta.buy,
    sellVol: delta.sell,
    deltaTier: delta.tier,
    thinData,
    cvd: Number.isFinite(cvd) ? cvd : null,
    cvdDivergence: cvdDiv,
    absorption,
    bookImbalance: imb > 0 ? imb : null,
    bookScore: bookScore ?? 0,
    deltaScore,
    divScore,
    absScore,
    bookBullMin: 1.5,
    bookBearMax: 0.67,
  });
}

function classifyOiPrice(priceChg, oiChg) {
  if (priceChg > 0 && oiChg > 0) return "fresh_longs";
  if (priceChg < 0 && oiChg > 0) return "fresh_shorts";
  if (priceChg > 0 && oiChg < 0) return "short_covering";
  if (priceChg < 0 && oiChg < 0) return "long_liquidation";
  return "neutral";
}

/** Price change over roughly `ms` looking back via bar timestamps (matches the OI change horizon). */
function priceChangeOverMs(candles, idx, ms) {
  const t0 = num(candles[idx]?.ts) - ms;
  let j = idx;
  while (j > 0 && num(candles[j - 1]?.ts) >= t0) j--;
  const p0 = num(candles[j]?.close);
  const p1 = num(candles[idx]?.close);
  return p0 > 0 ? (p1 - p0) / p0 : 0;
}

function evaluatePositioningLayer(candles, idx, side, extras = {}, opts = {}) {
  const oiChg = num(extras.oiChangePct, NaN);
  const funding = num(extras.fundingRate, NaN);
  // OI change is a ~4h delta; compare against the same price horizon, not a single bar.
  const priceChg = priceChangeOverMs(candles, idx, 4 * 3_600_000);

  if (!Number.isFinite(oiChg) && !Number.isFinite(funding)) {
    return layerResult(50, true, { optional: true, reason: "no_positioning_data" });
  }

  const oiClass = Number.isFinite(oiChg) ? classifyOiPrice(priceChg, oiChg) : "neutral";
  let oiScore = 50;
  if (side === "BUY") {
    if (oiClass === "short_covering" || oiClass === "fresh_longs") oiScore = 80;
    else if (oiClass === "long_liquidation") oiScore = 65;
    else if (oiClass === "fresh_shorts") oiScore = 35;
  } else {
    if (oiClass === "long_liquidation" || oiClass === "fresh_shorts") oiScore = 80;
    else if (oiClass === "short_covering") oiScore = 65;
    else if (oiClass === "fresh_longs") oiScore = 35;
  }

  let fundScore = 50;
  if (Number.isFinite(funding)) {
    const fBps = funding * 100;
    if (side === "BUY") {
      if (fBps <= -0.03) fundScore = 90;
      else if (fBps <= -0.01) fundScore = 75;
      else if (fBps >= 0.03) fundScore = 25;
      else if (fBps >= 0.01) fundScore = 40;
    } else {
      if (fBps >= 0.03) fundScore = 90;
      else if (fBps >= 0.01) fundScore = 75;
      else if (fBps <= -0.03) fundScore = 25;
      else if (fBps <= -0.01) fundScore = 40;
    }
  }

  const score = 0.65 * oiScore + 0.35 * fundScore;
  const pass = score >= num(opts.minPositioningScore, MLCTS_DEFAULTS.minPositioningScore);
  return layerResult(score, pass, {
    optional: !Number.isFinite(oiChg) && !Number.isFinite(funding),
    side,
    priceChangePct: priceChg * 100,
    oiChangePct: Number.isFinite(oiChg) ? oiChg : null,
    oiClass,
    oiScore,
    fundingRate: Number.isFinite(funding) ? funding : null,
    fundingRatePct: Number.isFinite(funding) ? funding * 100 : null,
    fundScore,
    minPositioningScore: num(opts.minPositioningScore, MLCTS_DEFAULTS.minPositioningScore),
  });
}

function barVolumeAt(candles, pre, j) {
  const fromPre = num(pre?.volumes?.[j], NaN);
  if (Number.isFinite(fromPre) && fromPre > 0) return fromPre;
  return num(candles[j]?.volume, 0);
}

function rollingVolumeAvg(candles, pre, idx, look) {
  let sum = 0;
  let n = 0;
  const start = Math.max(0, idx - look + 1);
  for (let j = start; j < idx; j++) {
    const v = barVolumeAt(candles, pre, j);
    if (v > 0) {
      sum += v;
      n++;
    }
  }
  return { avg: n > 0 ? sum / n : 0, n, windowBars: idx - start };
}

function evaluateVolatilityGate(candles, idx, pre, opts) {
  const atrVal = num(pre?.atrSeries?.[idx], 0);
  const close = num(candles[idx]?.close);
  const look = 20;
  let atrSum = 0;
  let n = 0;
  for (let j = Math.max(0, idx - look + 1); j <= idx; j++) {
    const a = num(pre?.atrSeries?.[j], 0);
    if (a > 0) {
      atrSum += a;
      n++;
    }
  }
  const atrAvg = n ? atrSum / n : atrVal;
  const atrExpansion = atrAvg > 0 ? atrVal / atrAvg : 0;

  const volRoll = rollingVolumeAvg(candles, pre, idx, look);
  const volAvg = volRoll.avg;
  const curVol = barVolumeAt(candles, pre, idx);
  const volDataOk = volRoll.n >= Math.min(10, Math.max(1, volRoll.windowBars - 1));
  const rvol = volDataOk && volAvg > 0 ? curVol / volAvg : null;

  const gatePassed =
    atrExpansion >= num(opts.volGateAtrMult, 1) &&
    rvol != null &&
    rvol >= num(opts.volGateRvol, 1.5);
  const expansionScore = Math.min(60, atrExpansion * 40);
  const rvolScore = rvol != null ? Math.min(40, (rvol / num(opts.volGateRvol, 1.5)) * 40) : 0;
  const score = gatePassed ? 100 : Math.round(expansionScore + rvolScore);

  return layerResult(score, gatePassed, {
    gate: true,
    gatePassed,
    atr14: atrVal,
    atrAvg20: atrAvg,
    atrExpansion,
    atrGateMin: num(opts.volGateAtrMult, 1),
    rvol: rvol ?? 0,
    rvolUnavailable: rvol == null,
    rvolGateMin: num(opts.volGateRvol, 1.5),
    volAvg20: volAvg,
    volAvgBars: volRoll.n,
    volDataOk,
    curVol,
    expansionScore: Math.round(expansionScore * 10) / 10,
    rvolScore: Math.round(rvolScore * 10) / 10,
    atrPct: close > 0 ? atrVal / close : 0,
  });
}

/** L5 delta/CVD/abs only — book is a separate composite term (weightBook). */
export function orderFlowCoreScore(orderflow) {
  const d = orderflow?.detail ?? {};
  return fixedDenominatorWeightedScore(
    [
      { w: MLCTS_L5_BLEND_WEIGHTS.delta, s: d.deltaScore },
      { w: MLCTS_L5_BLEND_WEIGHTS.div, s: d.divScore },
      { w: MLCTS_L5_BLEND_WEIGHTS.abs, s: d.absScore },
    ],
    MLCTS_L5_CORE_DENOM,
  );
}

/**
 * Weighted composite — one term per configured weight key.
 * L3+L4 share weightTrigger (averaged); L6 OI and funding are separate sub-scores.
 * Returns a 0–100 weighted average: sum(weight × componentScore) / sum(weights).
 * Weights sum to 95 (L7 is gate-only); a perfect 100/100/… bar yields composite 100, not 95.
 */
export function computeMlctsCompositeScore(layers, opts = {}) {
  const o = { ...MLCTS_DEFAULTS, ...opts };
  const trigger = (num(layers.sweep?.score) + num(layers.structure?.score)) / 2;
  const wTrend = num(o.weightTrend, 20);
  const wLiq = num(o.weightLiquidity, 20);
  const wTrig = num(o.weightTrigger, 15);
  const wOf = num(o.weightOrderFlow, 15);
  const wBook = num(o.weightBook, 10);
  const wOi = num(o.weightOi, 10);
  const wFund = num(o.weightFunding, 5);
  const wSum = wTrend + wLiq + wTrig + wOf + wBook + wOi + wFund;

  const posDetail = layers.positioning?.detail ?? {};
  const posFallback = num(layers.positioning?.score, 50);
  const bookScore = num(layers.orderflow?.detail?.bookScore, 50);
  const oiScore = num(posDetail.oiScore, posFallback);
  const fundScore = num(posDetail.fundScore, posFallback);
  const coreOf = orderFlowCoreScore(layers.orderflow);

  const breakdown = {
    trend: wTrend * num(layers.trend?.score),
    liquidity: wLiq * num(layers.liquidity?.score),
    trigger: wTrig * trigger,
    orderFlow: wOf * coreOf,
    book: wBook * bookScore,
    oi: wOi * oiScore,
    funding: wFund * fundScore,
  };
  const raw = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const score = wSum > 0 ? raw / wSum : 0;

  return {
    score,
    breakdown,
    triggerAvg: trigger,
    orderFlowCore: coreOf,
    bookScore,
    oiScore,
    fundScore,
    weightSum: wSum,
    /** True 0–100 ceiling when every component scores 100 (divide-by-wSum normalization). */
    scoreScale: "0-100_weighted_average",
  };
}

function compositeScore(layers, opts) {
  return computeMlctsCompositeScore(layers, opts).score;
}

/** L5–L7 confidence composite (L1–L4 excluded — use with mandatory layer gates). */
export function computeMlctsConfidenceScore(layers, opts = {}) {
  const o = { ...MLCTS_DEFAULTS, ...opts };
  const wOf = num(o.weightOrderFlow, 15);
  const wBook = num(o.weightBook, 10);
  const wOi = num(o.weightOi, 10);
  const wFund = num(o.weightFunding, 5);
  const wVol = num(o.weightVolatility, 15);
  const wSum = wOf + wBook + wOi + wFund + wVol;

  const posDetail = layers.positioning?.detail ?? {};
  const posFallback = num(layers.positioning?.score, 50);
  const bookScore = num(layers.orderflow?.detail?.bookScore, 50);
  const oiScore = num(posDetail.oiScore, posFallback);
  const fundScore = num(posDetail.fundScore, posFallback);
  const coreOf = orderFlowCoreScore(layers.orderflow);
  const volScore = num(layers.volatility?.score, 0);

  const breakdown = {
    orderFlow: wOf * coreOf,
    book: wBook * bookScore,
    oi: wOi * oiScore,
    funding: wFund * fundScore,
    volatility: wVol * volScore,
  };
  const raw = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const score = wSum > 0 ? raw / wSum : 0;

  return {
    score,
    breakdown,
    orderFlowCore: coreOf,
    bookScore,
    oiScore,
    fundScore,
    volScore,
    weightSum: wSum,
    scoreScale: "L567_confidence_0-100",
  };
}

/** Side-specific L5–L7 scores (no L1–L4). For microstructure-only research. */
export function evaluateMlctsMicroScores(candles, idx, opts = {}, extras = {}) {
  const o = { ...MLCTS_DEFAULTS, ...opts };
  if (!candles?.length || idx < MLCTS_WARMUP || idx >= candles.length) {
    return null;
  }
  const pre = extras.pre ?? precomputeIntraday(candles.slice(0, idx + 1));
  const barTs = num(candles[idx]?.ts);
  const oiRow = lookupSeriesAt(extras.oiSeries, barTs);
  const fundRow = lookupSeriesAt(extras.fundingSeries, barTs);
  const oiExtras = {
    oiChangePct: oiRow?.changePct ?? oiRow?.change4hPct ?? null,
    fundingRate: fundRow?.rate ?? fundRow?.current ?? null,
    orderBookImbalance: extras.orderBookImbalance ?? null,
  };

  const sides = {};
  for (const side of ["BUY", "SELL"]) {
    const orderflow = evaluateOrderFlowLayer(candles, idx, pre, side, oiExtras);
    const positioning = evaluatePositioningLayer(candles, idx, side, oiExtras, o);
    const volatility = evaluateVolatilityGate(candles, idx, pre, o);
    const layers = { orderflow, positioning, volatility };
    const conf = computeMlctsConfidenceScore(layers, o);
    const d = orderflow.detail ?? {};
    const p = positioning.detail ?? {};
    sides[side] = {
      layers,
      confidence: conf.score,
      deltaScore: d.deltaScore ?? 0,
      divScore: d.divScore ?? 0,
      absScore: d.absScore ?? 0,
      bookScore: d.bookScore ?? 0,
      orderflowScore: orderflow.score,
      orderflowCore: orderFlowCoreScore(orderflow),
      oiScore: p.oiScore ?? 50,
      fundScore: p.fundScore ?? 50,
      positioningScore: positioning.score,
      volatilityScore: volatility.score,
      oiClass: p.oiClass ?? null,
      fundingRate: p.fundingRate ?? null,
    };
  }
  return { idx, ts: barTs, sides };
}

/** L1–L4 must pass on same bar (strict). For sequential ICT use detectSequentialL1234Formation. */
export function mandatoryLayersPass(layers, direction) {
  return (
    Boolean(direction) &&
    layers.trend?.pass === true &&
    layers.liquidity?.pass === true &&
    layers.sweep?.pass === true &&
    layers.structure?.pass === true
  );
}

/**
 * Sequential ICT formation completing on `entryIdx` (typically the BOS bar).
 * L1: directional bias (BULL/BEAR) in window before sweep — ADX not required on entry bar.
 * L2: liquidity proximity at sweep bar (score >= minL2Score).
 * L3: sweep + reclaim at sweep bar.
 * L4: BOS on entryIdx within maxBosLag bars after sweep (first BOS after sweep only).
 *
 * @returns {null | { entryIdx, sweepIdx, bosIdx, side, layersAtEntry, sweepLevel, levelType }}
 */
export function detectSequentialL1234Formation(candles, entryIdx, opts = {}, extras = {}, cfg = {}) {
  const o = { ...MLCTS_DEFAULTS, ...opts };
  const lookback = num(cfg.lookbackBars, 32);
  const maxBosLag = num(cfg.maxBosLagBars, 8);
  const biasLookback = num(cfg.biasLookbackBars, 16);
  const minL2 = num(cfg.minL2Score, 40);
  const minL3 = num(cfg.minL3Score, 50);
  const minL4 = num(cfg.minL4Score, 50);

  if (!candles?.length || entryIdx < MLCTS_WARMUP || entryIdx >= candles.length) return null;

  const pre = extras.pre ?? precomputeIntraday(candles.slice(0, entryIdx + 1));
  const baseExtras = { ...extras, pre };
  const evalAt =
    extras.evalAt ??
    ((i) =>
      evaluateMlctsLayers(candles, i, o, {
        ...baseExtras,
        pre,
        orderBookImbalance:
          lookupSeriesAt(extras.bookImbalanceSeries, num(candles[i]?.ts)) ??
          extras.orderBookImbalance ??
          null,
      }));

  const start = Math.max(MLCTS_WARMUP, entryIdx - lookback);
  const evEntry = evalAt(entryIdx);
  const Lentry = evEntry.layers ?? {};
  if (!Lentry.structure?.detail?.bos) return null;
  if (!Lentry.structure?.pass && num(Lentry.structure?.score, 0) < minL4) return null;

  const side =
    evEntry.direction ??
    (Lentry.trend?.detail?.bias === "BULL"
      ? "BUY"
      : Lentry.trend?.detail?.bias === "BEAR"
        ? "SELL"
        : null);
  if (!side) return null;

  for (let sweepIdx = entryIdx; sweepIdx >= Math.max(start, entryIdx - maxBosLag); sweepIdx--) {
    const evS = evalAt(sweepIdx);
    const Ls = evS.layers ?? {};
    const dS = Ls.sweep?.detail ?? {};
    if (!dS.swept || !dS.reclaim) continue;
    if (!Ls.sweep?.pass && num(Ls.sweep?.score, 0) < minL3) continue;

    const sweepSide =
      evS.direction ??
      (Ls.trend?.detail?.bias === "BULL"
        ? "BUY"
        : Ls.trend?.detail?.bias === "BEAR"
          ? "SELL"
          : null);
    if (sweepSide !== side) continue;

    if (!Ls.liquidity?.pass && num(Ls.liquidity?.score, 0) < minL2) continue;

    let alignedBias = false;
    for (let j = Math.max(start, sweepIdx - biasLookback); j <= entryIdx; j++) {
      const bias = evalAt(j).layers?.trend?.detail?.bias;
      if (side === "BUY" && bias === "BULL") alignedBias = true;
      if (side === "SELL" && bias === "BEAR") alignedBias = true;
    }
    if (!alignedBias) continue;

    let earlierBos = false;
    for (let k = sweepIdx + 1; k < entryIdx; k++) {
      if (evalAt(k).layers?.structure?.detail?.bos) {
        earlierBos = true;
        break;
      }
    }
    if (earlierBos) continue;

    return {
      entryIdx,
      sweepIdx,
      bosIdx: entryIdx,
      side,
      layersAtEntry: Lentry,
      sweepLevel: dS.level ?? null,
      levelType: dS.levelType ?? null,
      biasAtEntry: Lentry.trend?.detail?.bias ?? null,
    };
  }

  return null;
}

export function buildMlctsBrackets(candles, idx, side, layers, opts, pre) {
  return buildBrackets(candles, idx, side, layers, opts, pre);
}

function buildBrackets(candles, idx, side, layers, opts, pre) {
  const entry = num(candles[idx]?.close);
  const atrVal = num(pre?.atrSeries?.[idx], 0);
  const buffer = atrVal * num(opts.slAtrBuffer, 0.25);
  const sweepWick = layers.sweep?.detail?.wick ?? (side === "BUY" ? candles[idx].low : candles[idx].high);
  const rr = num(opts.targetRr, 2);

  let slPrice;
  if (side === "BUY") slPrice = Math.min(sweepWick, entry) - buffer;
  else slPrice = Math.max(sweepWick, entry) + buffer;

  const slDist = Math.abs(entry - slPrice);
  if (!(slDist > 0)) return null;
  const tpPrice = side === "BUY" ? entry + slDist * rr : entry - slDist * rr;

  return {
    slPct: slDist / entry,
    tpPct: Math.abs(tpPrice - entry) / entry,
    slPrice,
    tpPrice,
    entryPrice: entry,
    sweepWick,
  };
}

/**
 * Evaluate all MLCTS layers at bar index `idx` (causal — uses candles[0..idx] only).
 * @param {object[]} candles
 * @param {number} idx
 * @param {object} [opts]
 * @param {{ oiSeries?: object[], fundingSeries?: object[], orderBookImbalance?: number, pre?: object }} [extras]
 */
function inferDisplaySide(trend) {
  const bias = trend.detail?.bias;
  if (bias === "BULL") return "BUY";
  if (bias === "BEAR") return "SELL";
  const stack = trend.detail?.emaStack;
  if (stack === "BULL") return "BUY";
  if (stack === "BEAR") return "SELL";
  if (trend.detail?.priceAboveEma200 === true) return "BUY";
  if (trend.detail?.priceAboveEma200 === false) return "SELL";
  return "BUY";
}

function stampAwaitingBias(layer, tradeSide) {
  if (tradeSide) return layer;
  return {
    ...layer,
    pass: false,
    detail: { ...(layer.detail ?? {}), awaitingBias: true },
  };
}

/**
 * @param {object[]} candles
 * @param {number} idx
 * @param {object} opts
 * @param {{ forDisplay?: boolean, pre?: object, weeklyLiquidity?: object, oiSeries?: array, fundingSeries?: array, orderBookImbalance?: number }} extras
 */
export function evaluateMlctsLayers(candles, idx, opts = {}, extras = {}) {
  const o = { ...MLCTS_DEFAULTS, ...opts };
  const forDisplay = extras.forDisplay === true;
  const minWarmup = forDisplay ? MLCTS_DISPLAY_WARMUP : MLCTS_WARMUP;

  if (!candles?.length || idx >= candles.length) {
    return {
      layers: {},
      score: 0,
      direction: null,
      allRequiredGreen: false,
      ready: false,
      brackets: null,
      featureVector: {},
    };
  }

  if (idx < minWarmup) {
    return {
      layers: {},
      score: 0,
      direction: null,
      allRequiredGreen: false,
      ready: false,
      brackets: null,
      featureVector: {},
      warmingUp: true,
      barsNeeded: minWarmup,
      barCount: candles.length,
    };
  }

  const tradeReady = idx >= MLCTS_WARMUP;

  const pre = extras.pre ?? precomputeIntraday(candles.slice(0, idx + 1));
  const barTs = num(candles[idx]?.ts);

  const oiRow = lookupSeriesAt(extras.oiSeries, barTs);
  const fundRow = lookupSeriesAt(extras.fundingSeries, barTs);
  const oiExtras = {
    oiChangePct: oiRow?.changePct ?? oiRow?.change4hPct ?? null,
    fundingRate: fundRow?.rate ?? fundRow?.current ?? null,
    orderBookImbalance: extras.orderBookImbalance ?? null,
  };

  const trend = evaluateTrendLayer(candles, idx, o, pre);
  const bias = trend.detail?.bias;
  const tradeSide = bias === "BULL" ? "BUY" : bias === "BEAR" ? "SELL" : null;
  const displaySide = tradeSide ?? inferDisplaySide(trend);

  let liquidity = evaluateLiquidityLayer(candles, idx, o, pre, displaySide, extras.weeklyLiquidity ?? null);
  liquidity = stampAwaitingBias(liquidity, tradeSide);

  let sweep = evaluateSweepLayer(candles, idx, o, pre, displaySide, {
    price: liquidity.detail?.level,
    baseStrength: liquidity.detail?.baseStrength,
    structuralStrength: liquidity.detail?.structuralStrength,
    levelType: liquidity.detail?.levelType,
    confluenceCount: liquidity.detail?.confluenceCount,
  });
  sweep = stampAwaitingBias(sweep, tradeSide);

  let structure = evaluateStructureLayer(candles, idx, o, pre, displaySide);
  structure = stampAwaitingBias(structure, tradeSide);

  let orderflow = evaluateOrderFlowLayer(candles, idx, pre, displaySide, oiExtras);
  orderflow = stampAwaitingBias(orderflow, tradeSide);

  let positioning = evaluatePositioningLayer(candles, idx, displaySide, oiExtras, o);
  positioning = stampAwaitingBias(positioning, tradeSide);

  const volatility = evaluateVolatilityGate(candles, idx, pre, o);

  const layers = { trend, liquidity, sweep, structure, orderflow, positioning, volatility };
  const score = compositeScore(layers, o);

  const layersAllPass =
    tradeReady &&
    tradeSide &&
    trend.pass &&
    liquidity.pass &&
    sweep.pass &&
    structure.pass &&
    orderflow.pass &&
    positioning.pass &&
    volatility.pass;

  const hardVetoesOk = tradeReady && tradeSide != null && volatility.pass;
  const scoreOk = score >= num(o.scoreThreshold, 75);
  const bracketsCandidate =
    hardVetoesOk && scoreOk && tradeSide ? buildBrackets(candles, idx, tradeSide, layers, o, pre) : null;
  const signalOk = hardVetoesOk && scoreOk && bracketsCandidate != null;
  /** @deprecated alias — entry gate is signalOk; layersAllPass is diagnostic only */
  const allRequiredGreen = signalOk;

  const featureVector = {
    trendBias: bias,
    trendScore: trend.score,
    adx: trend.detail?.adx,
    liquidityScore: liquidity.score,
    liquidityStructuralStrength: liquidity.detail?.structuralStrength,
    liquidityPrimaryTypeStrength: liquidity.detail?.primaryTypeStrength,
    liquidityConfluenceCount: liquidity.detail?.confluenceCount,
    liquidityMergedTypes: liquidity.detail?.mergedTypes,
    liquidityLevel: liquidity.detail?.level,
    sweepDepthAtr: sweep.detail?.sweepDepthAtr,
    sweepSwept: sweep.detail?.swept,
    sweepReclaim: sweep.detail?.reclaim,
    sweepCloseBackPct: sweep.detail?.closeBackPct,
    sweepReclaimScore: sweep.detail?.reclaimScore,
    sweepConfirmScore: sweep.detail?.confirmScore,
    bos: structure.detail?.bos,
    bosBodyGate: structure.detail?.bodyGatePassed,
    bosDisplacement: structure.detail?.displacement,
    delta: orderflow.detail?.delta,
    cvdDivergence: orderflow.detail?.cvdDivergence,
    oiChangePct: positioning.detail?.oiChangePct,
    fundingRate: positioning.detail?.fundingRate,
    atrExpansion: volatility.detail?.atrExpansion,
    rvol: volatility.detail?.rvol,
    compositeScore: Math.round(score),
  };

  return {
    layers,
    score: Math.round(score),
    direction: tradeSide,
    displayDirection: displaySide,
    signalOk,
    layersAllPass,
    hardVetoesOk,
    scoreOk,
    allRequiredGreen,
    ready: tradeReady,
    warmingUp: !tradeReady,
    brackets: bracketsCandidate,
    featureVector,
  };
}

/** Build per-bar signal series for backtest adapter. */
export function buildMlctsSeries(candles, opts = {}, extras = {}) {
  const series = new Array(candles.length).fill(null);
  const pre = precomputeIntraday(candles);
  for (let idx = MLCTS_WARMUP; idx < candles.length; idx++) {
    const barTs = num(candles[idx]?.ts);
    const bookRow = lookupSeriesAt(extras.bookImbalanceSeries, barTs);
    const orderBookImbalance =
      bookRow?.imbalanceRatio ?? extras.orderBookImbalance ?? null;
    const ev = evaluateMlctsLayers(candles, idx, opts, {
      ...extras,
      pre,
      orderBookImbalance,
    });
    if (!ev.signalOk || !ev.direction) continue;
    const action = ev.direction;
    series[idx] = {
      action,
      reason: `mlcts_score_${ev.score}`,
      trigger: "mlcts_confluence",
      playbook: "MLCTS",
      liqBrackets: ev.brackets,
      mlctsContext: ev.featureVector,
      mlctsLayers: ev.layers,
    };
  }
  return { series };
}
