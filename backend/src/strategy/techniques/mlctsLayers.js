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

  let bias = "RANGE";
  if (lastH && prevH && lastL && prevL) {
    const hh = lastH.price > prevH.price;
    const hl = lastL.price > prevL.price;
    const lh = lastH.price < prevH.price;
    const ll = lastL.price < prevL.price;
    if (hh && hl) bias = "BULL";
    else if (lh && ll) bias = "BEAR";
  }

  const emaBull = e20[i] > e50[i] && e50[i] > e200[i];
  const emaBear = e20[i] < e50[i] && e50[i] < e200[i];
  if (bias === "RANGE") {
    if (emaBull && close > e200[i]) bias = "BULL";
    else if (emaBear && close < e200[i]) bias = "BEAR";
  }

  const adxStrength = clamp01(adxVal / 50);
  const emaSpread = e200[i] > 0 ? Math.abs(e20[i] - e200[i]) / e200[i] : 0;
  const emaStrength = clamp01(emaSpread / 0.05);
  const score = 60 * adxStrength + 40 * emaStrength;
  const pass = bias !== "RANGE" && adxVal >= num(opts.minAdx, 20) && score >= num(opts.minLayerScore, 50);

  return layerResult(score, pass, {
    bias,
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

function evaluateOrderFlowLayer(candles, idx, pre, side, extras = {}) {
  const ofOpts = MLCTS_OF_OPTS;
  const delta = barDeltaMeta(candles[idx], ofOpts);
  const cvdDiv = detectCvdDivergence(candles, idx, side, pre, ofOpts);
  const absorption = detectAbsorption(candles, idx, side, pre, ofOpts);
  const cvd = num(pre?.cvd?.[idx], NaN);

  let bookScore = 50;
  const imb = num(extras.orderBookImbalance, 0);
  if (imb > 0) {
    if (side === "BUY") bookScore = imb >= 1.5 ? 100 : imb >= 1 ? 70 : 30;
    else bookScore = imb <= 0.67 ? 100 : imb <= 1 ? 70 : 30;
  }

  const deltaSign = side === "BUY" ? delta.delta > 0 : delta.delta < 0;
  const deltaScore = deltaSign ? 70 : 30;
  const divScore = cvdDiv ? 85 : 40;
  const absScore = absorption ? 75 : 45;
  const score = 0.3 * deltaScore + 0.3 * divScore + 0.2 * absScore + 0.2 * bookScore;
  const pass = score >= 50;

  return layerResult(score, pass, {
    side,
    delta: delta.delta,
    buyVol: delta.buy,
    sellVol: delta.sell,
    deltaTier: delta.tier,
    cvd: Number.isFinite(cvd) ? cvd : null,
    cvdDivergence: cvdDiv,
    absorption,
    bookImbalance: imb > 0 ? imb : null,
    bookScore,
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

  const volSlice = pre?.volumes?.slice(Math.max(0, idx - look), idx) ?? [];
  const volAvg = volSlice.length ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 0;
  const curVol = num(pre?.volumes?.[idx], num(candles[idx]?.volume));
  const rvol = volAvg > 0 ? curVol / volAvg : 0;

  const gatePassed =
    atrExpansion >= num(opts.volGateAtrMult, 1) && rvol >= num(opts.volGateRvol, 1.5);
  const score = gatePassed ? 100 : Math.round(clamp01((atrExpansion + rvol / 2) / 2) * 100);

  return layerResult(score, gatePassed, {
    gate: true,
    gatePassed,
    atr14: atrVal,
    atrAvg20: atrAvg,
    atrExpansion,
    atrGateMin: num(opts.volGateAtrMult, 1),
    rvol,
    rvolGateMin: num(opts.volGateRvol, 1.5),
    volAvg20: volAvg,
    curVol,
    atrPct: close > 0 ? atrVal / close : 0,
  });
}

function compositeScore(layers, opts) {
  const trigger = (num(layers.sweep?.score) + num(layers.structure?.score)) / 2;
  const wTrend = num(opts.weightTrend, 20);
  const wLiq = num(opts.weightLiquidity, 20);
  const wTrig = num(opts.weightTrigger, 15);
  const wOf = num(opts.weightOrderFlow, 15);
  const wBook = num(opts.weightBook, 10);
  const wOi = num(opts.weightOi, 10);
  const wFund = num(opts.weightFunding, 5);
  const wSum = wTrend + wLiq + wTrig + wOf + wBook + wOi + wFund;

  const bookScore = num(layers.orderflow?.detail?.bookScore, 50);

  const raw =
    wTrend * num(layers.trend?.score) +
    wLiq * num(layers.liquidity?.score) +
    wTrig * trigger +
    wOf * num(layers.orderflow?.score) +
    wBook * bookScore +
    wOi * num(layers.positioning?.score) +
    wFund * num(layers.positioning?.score);

  return wSum > 0 ? raw / wSum : 0;
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

  const hierarchicalOk =
    tradeReady &&
    tradeSide &&
    trend.pass &&
    liquidity.pass &&
    sweep.pass &&
    structure.pass &&
    orderflow.pass &&
    positioning.pass &&
    volatility.pass;

  const scoreOk = score >= num(o.scoreThreshold, 75);
  const allRequiredGreen = hierarchicalOk && scoreOk && tradeSide != null;

  const brackets = allRequiredGreen && tradeSide ? buildBrackets(candles, idx, tradeSide, layers, o, pre) : null;

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
    allRequiredGreen,
    ready: tradeReady,
    warmingUp: !tradeReady,
    brackets,
    featureVector,
  };
}

/** Build per-bar signal series for backtest adapter. */
export function buildMlctsSeries(candles, opts = {}, extras = {}) {
  const series = new Array(candles.length).fill(null);
  const pre = precomputeIntraday(candles);
  for (let idx = MLCTS_WARMUP; idx < candles.length; idx++) {
    const ev = evaluateMlctsLayers(candles, idx, opts, { ...extras, pre });
    if (!ev.allRequiredGreen || !ev.direction) continue;
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
