/**
 * Bar-level order-flow patterns (guide-aligned proxies for footprint concepts).
 */

import { buildVolumeProfile } from "./volumeProfile.js";
import { buildSessionVwapSeries } from "./sessionVwap.js";
import { buildOrderFlowBrackets } from "./orderFlowBrackets.js";
import {
  barDelta,
  barDeltaMeta,
  buildCvdSeries,
  deltaImbalance,
  resolveSeriesDataTier,
} from "./orderFlow.js";
import { inOrderFlowKillzone } from "./sessionKillzones.js";

/** @typedef {'absorption'|'stacked_delta'|'cvd_divergence'|'delta_confirm'|'book_pressure'|'key_level'} OrderFlowPatternTag */

/**
 * @param {object} cfg
 * @returns {object}
 */
export function buildOrderFlowOpts(cfg = {}) {
  const rawMode = String(cfg.intradayOfConfluenceMode ?? "full").toLowerCase();
  const confluenceMode =
    rawMode === "layer3" || rawMode === "research" || rawMode === "full" ? rawMode : "full";
  return {
    confluenceMode,
    allowCvdOnly: cfg.intradayOfAllowCvdOnly === true,
    allowProxy: cfg.intradayOfAllowProxy === true,
    requireKeyLevel: cfg.intradayOfRequireKeyLevel !== false,
    requireConfirmation: cfg.intradayOfRequireConfirmation !== false,
    minStackBars: Math.max(2, Math.min(8, Math.round(Number(cfg.intradayOfMinStackBars ?? 3)))),
    minConfluence: Math.max(1, Math.min(4, Math.round(Number(cfg.intradayOfMinConfluence ?? 2)))),
    useOrderBook: cfg.intradayOfUseOrderBook !== false,
    killzoneMode: String(cfg.intradayOfKillzoneMode ?? "LONDON_NY").toUpperCase(),
    levelProximityPct: Math.max(
      0.0001,
      Number(cfg.intradayOfLevelProximityPct ?? cfg.sweepPct ?? cfg.srIntradaySweepPct ?? 0.0006),
    ),
    divergenceLookback: Math.max(6, Math.min(30, Math.round(Number(cfg.intradayOfDivergenceLookback ?? 12)))),
    absorptionVolMult: Math.max(1.1, Number(cfg.intradayOfAbsorptionVolMult ?? 1.5)),
    absorptionRangeAtrMult: Math.max(
      0.1,
      Number(cfg.intradayOfAbsorptionRangeAtrMult ?? (cfg.timeframe === "15m" ? 1.0 : 0.4)),
    ),
    /** Guide: 3:1 footprint imbalance ≈ 75% aggression on one side per bar. */
    stackDeltaRatio: Math.max(0.5, Number(cfg.intradayOfStackDeltaRatio ?? 0.75)),
    bookImbalanceMin: Math.max(0.5, Math.min(0.9, Number(cfg.intradayOfBookImbalanceMin ?? 0.65))),
    requirePremiumDiscount: cfg.intradayOfRequirePremiumDiscount !== false,
    approachLookback: Math.max(3, Math.min(20, Math.round(Number(cfg.intradayOfApproachLookback ?? 8)))),
  };
}

/** Guide Step 1: longs in discount (≤ VAL), shorts in premium (≥ VAH). */
export function passesPremiumDiscountZone(side, vp, price, ofOpts) {
  if (!ofOpts.requirePremiumDiscount || !vp) return true;
  const tol = 0.0025;
  if (side === "BUY") {
    return price <= vp.val * (1 + tol);
  }
  return price >= vp.vah * (1 - tol);
}

/** Guide Step 5–6: confirmation candle — delta + body holds beyond absorption. */
export function passesGuideConfirmation(candles, idx, side, absorptionIdx, pre, ofOpts) {
  if (absorptionIdx == null || idx <= absorptionIdx) return false;
  const confirmBar = candles[idx];
  const absorbBar = candles[absorptionIdx];
  const delta = barDelta(confirmBar, ofOpts);
  if (side === "BUY") {
    return delta > 0 && confirmBar.close > absorbBar.high * 0.9995;
  }
  return delta < 0 && confirmBar.close < absorbBar.low * 1.0005;
}

/** CVD diverging while price approaches level (guide Step 3). */
export function detectApproachCvdDivergence(candles, idx, side, pre, level, ofOpts) {
  if (level == null || !Number.isFinite(level)) return false;
  const lb = ofOpts.approachLookback;
  if (idx < lb) return false;
  const cvd = pre?.cvd ?? buildCvdSeries(candles, ofOpts);
  const start = idx - lb;
  let wasAway = false;
  for (let j = start; j < idx; j++) {
    const dist = Math.abs(candles[j].close - level) / level;
    if (dist > ofOpts.levelProximityPct * 2) wasAway = true;
  }
  if (!wasAway) return false;
  return detectCvdDivergence(candles, idx, side, pre, ofOpts);
}

/** Infer trade side from level bias + VP zone (solo path — skip RSI). */
export function inferOrderFlowSide(candles, idx, pre, cfg = {}, ofOpts = null) {
  const opts = ofOpts ?? buildOrderFlowOpts(cfg);
  const bar = candles[idx];
  const price = bar.close;
  const vpLookback = 192;
  const vp = buildVolumeProfile(candles, idx, { lookback: vpLookback });
  if (vp) {
    if (passesPremiumDiscountZone("BUY", vp, price, opts)) {
      const buyCtx = buildKeyLevelContext(candles, idx, pre, "BUY", opts);
      if (buyCtx.atKeyLevel || buyCtx.levels.some((l) => l.bias === "BUY")) return "BUY";
    }
    if (passesPremiumDiscountZone("SELL", vp, price, opts)) {
      const sellCtx = buildKeyLevelContext(candles, idx, pre, "SELL", opts);
      if (sellCtx.atKeyLevel || sellCtx.levels.some((l) => l.bias === "SELL")) return "SELL";
    }
  }
  return null;
}

function nearLevel(price, level, tolPct) {
  return level > 0 && Math.abs(price - level) / level <= tolPct;
}

/**
 * @param {object[]} candles
 * @param {number} idx
 * @param {object} pre — intraday precompute (session + cvd + atr)
 * @param {'BUY'|'SELL'} side
 * @param {object} ofOpts
 */
export function buildKeyLevelContext(candles, idx, pre, side, ofOpts) {
  const bar = candles[idx];
  const price = bar.close;
  const tol = ofOpts.levelProximityPct;
  const levels = [];

  const push = (name, level, bias) => {
    if (level == null || !Number.isFinite(level) || level <= 0) return;
    if (nearLevel(price, level, tol)) levels.push({ name, level, bias });
  };

  push("pdh", pre.prevDayHigh?.[idx], "SELL");
  push("pdl", pre.prevDayLow?.[idx], "BUY");
  push("asian_high", pre.asianHigh?.[idx], "SELL");
  push("asian_low", pre.asianLow?.[idx], "BUY");

  const vpLookback = 192;
  const vp = buildVolumeProfile(candles, idx, { lookback: vpLookback });
  const vwapSeries = pre?.sessionVwap ?? buildSessionVwapSeries(candles);
  const vwap = vwapSeries?.[idx] ?? null;
  push("vwap", vwap, "neutral");
  if (vp) {
    push("poc", vp.poc, "neutral");
    push("vah", vp.vah, "SELL");
    push("val", vp.val, "BUY");
  }

  const aligned = levels.filter((l) => l.bias === side || l.bias === "neutral");
  const nearest = levels.sort(
    (a, b) => Math.abs(price - a.level) - Math.abs(price - b.level),
  )[0];

  return {
    atKeyLevel: aligned.length > 0 || (ofOpts.requireKeyLevel === false && levels.length > 0),
    levels,
    nearestAligned: aligned[0] ?? null,
    nearest: nearest ?? null,
    vp,
    vwap,
  };
}

function volAvg(candles, idx, pre, look = 20) {
  const slice = pre?.volumes?.slice(Math.max(0, idx - look + 1), idx) ?? [];
  if (!slice.length) return 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/** High volume + tight range + delta opposing candle direction but close holds. */
export function detectAbsorption(candles, idx, side, pre, ofOpts) {
  const bar = candles[idx];
  const vol = Number(bar.volume) || 0;
  const avg = volAvg(candles, idx, pre);
  const atr = Number(pre?.atrSeries?.[idx]) || 0;
  const range = bar.high - bar.low;
  if (avg <= 0 || vol < avg * ofOpts.absorptionVolMult) return false;
  if (atr > 0 && range > atr * ofOpts.absorptionRangeAtrMult) return false;

  const delta = barDelta(bar, ofOpts);
  if (side === "BUY") {
    return delta < 0 && bar.close >= bar.open * 0.999;
  }
  return delta > 0 && bar.close <= bar.open * 1.001;
}

/** Consecutive bars with strong same-sign delta ratio (footprint stack proxy). */
export function detectStackedDelta(candles, idx, side, ofOpts) {
  const need = ofOpts.minStackBars;
  if (idx < need - 1) return false;
  for (let j = idx - need + 1; j <= idx; j++) {
    const m = barDeltaMeta(candles[j], ofOpts);
    const vol = Number(candles[j].volume) || 0;
    if (vol <= 0) return false;
    const ratio = Math.abs(m.delta) / vol;
    if (ratio < ofOpts.stackDeltaRatio) return false;
    if (side === "BUY" && m.delta <= 0) return false;
    if (side === "SELL" && m.delta >= 0) return false;
  }
  return true;
}

/** Price HH + CVD LH (bearish) or price LL + CVD HL (bullish). */
export function detectCvdDivergence(candles, idx, side, pre, ofOpts) {
  const lb = ofOpts.divergenceLookback;
  if (idx < lb) return false;
  const cvd = pre?.cvd ?? buildCvdSeries(candles, ofOpts);
  const start = idx - lb;
  let priceExtIdx = start;
  let cvdExtIdx = start;
  for (let j = start + 1; j <= idx; j++) {
    if (side === "SELL") {
      if (candles[j].high >= candles[priceExtIdx].high) priceExtIdx = j;
      if (cvd[j] >= cvd[cvdExtIdx]) cvdExtIdx = j;
    } else {
      if (candles[j].low <= candles[priceExtIdx].low) priceExtIdx = j;
      if (cvd[j] <= cvd[cvdExtIdx]) cvdExtIdx = j;
    }
  }
  if (side === "SELL") {
    return priceExtIdx === idx && cvdExtIdx !== idx && cvd[idx] < cvd[cvdExtIdx];
  }
  return priceExtIdx === idx && cvdExtIdx !== idx && cvd[idx] > cvd[cvdExtIdx];
}

/** Confirmation bar after absorption or stacked delta (guide Step 5). */
export function detectDeltaConfirmation(candles, idx, side, pre, ofOpts) {
  if (idx < 1) return false;
  let absorptionIdx = null;
  if (detectAbsorption(candles, idx - 1, side, pre, ofOpts)) {
    absorptionIdx = idx - 1;
  } else if (detectStackedDelta(candles, idx - 1, side, ofOpts)) {
    absorptionIdx = idx - 1;
  }
  if (absorptionIdx == null) return false;
  return passesGuideConfirmation(candles, idx, side, absorptionIdx, pre, ofOpts);
}

/**
 * Guide-aligned pass rules (order_flow_complete_guide §3–4).
 * Skips: CVD-only, absorption candle entry, Asian session handled by killzone.
 */
export function evaluateGuideConfluencePass(patterns, ctx = {}) {
  const {
    absorptionIdx = null,
    requireConfirmation = true,
    requireKeyLevel = true,
    confluenceMode = "full",
    allowCvdOnly = false,
  } = ctx;

  const hasKey = patterns.includes("key_level");
  const hasConfirm = patterns.includes("delta_confirm");
  const hasAbsorbPath = patterns.includes("absorption") || patterns.includes("stacked_delta");
  const hasCvd = patterns.includes("cvd_divergence") || patterns.includes("approach_cvd");

  if (requireKeyLevel && !hasKey) return false;
  if (hasCvd && !hasKey && !allowCvdOnly) return false;
  if (!hasAbsorbPath && !allowCvdOnly) return false;

  if (confluenceMode === "layer3") {
    if (requireConfirmation) return hasConfirm && absorptionIdx != null && hasKey;
    return hasKey && hasAbsorbPath;
  }

  if (confluenceMode === "research") {
    const n = patterns.filter((p) => p !== "key_level").length;
    return hasKey ? n >= 1 : allowCvdOnly && hasCvd;
  }

  /** full — guide §189: absorption + CVD + key level + confirmation */
  if (requireConfirmation && (!hasConfirm || absorptionIdx == null)) return false;
  if (!hasKey || !hasConfirm || !hasAbsorbPath) return false;
  return hasCvd;
}

/** Layer-3 composite gate (SMC + OF): key + confirm + absorption path, CVD optional. */
export function passesLayer3OrderFlow(patterns, absorptionIdx, ofOpts) {
  return evaluateGuideConfluencePass(patterns, {
    absorptionIdx,
    requireConfirmation: ofOpts.requireConfirmation,
    requireKeyLevel: ofOpts.requireKeyLevel,
    confluenceMode: "layer3",
    allowCvdOnly: false,
  });
}

/**
 * @param {'BUY'|'SELL'} side
 * @param {{ imbalanceRatio?: number, pressure?: string } | null | undefined} book
 * @param {object} ofOpts
 */
export function passesOrderBookPressure(side, book, ofOpts) {
  if (!ofOpts.useOrderBook || !book) return true;
  const imb = Number(book.imbalanceRatio);
  if (!Number.isFinite(imb)) return true;
  const min = ofOpts.bookImbalanceMin;
  if (side === "BUY") return imb >= min || book.pressure === "strong_buy";
  return imb <= 1 - min || book.pressure === "strong_sell";
}

/**
 * Full order-flow evaluation at a bar (Layer 3 entry confirmation).
 *
 * @returns {{
 *   pass: boolean,
 *   score: number,
 *   patterns: OrderFlowPatternTag[],
 *   dataTier: string,
 *   entryIdx: number,
 *   absorptionIdx: number | null,
 *   stopBeyond: number | null,
 *   keyLevel: string | null,
 * }}
 */
export function evaluateOrderFlowAtLevel(candles, idx, side, pre, cfg = {}, liveCtx = {}) {
  const ofOpts = buildOrderFlowOpts(cfg);
  const bar = candles[idx];
  const patterns = [];
  let score = 0;

  if (!inOrderFlowKillzone(bar.ts, { intradayOfKillzoneMode: ofOpts.killzoneMode })) {
    return { pass: false, score: 0, patterns: [], dataTier: "none", entryIdx: idx, absorptionIdx: null, stopBeyond: null, keyLevel: null };
  }

  const dataTier = resolveSeriesDataTier(candles.slice(Math.max(0, idx - 30), idx + 1), ofOpts);
  if (dataTier === "none") {
    return { pass: false, score: 0, patterns: [], dataTier, entryIdx: idx, absorptionIdx: null, stopBeyond: null, keyLevel: null };
  }

  const levelCtx = buildKeyLevelContext(candles, idx, pre, side, ofOpts);
  if (ofOpts.requireKeyLevel && !levelCtx.atKeyLevel) {
    return { pass: false, score: 0, patterns: [], dataTier, entryIdx: idx, absorptionIdx: null, stopBeyond: null, keyLevel: null, vp: levelCtx.vp };
  }
  if (!passesPremiumDiscountZone(side, levelCtx.vp, bar.close, ofOpts)) {
    return { pass: false, score: 0, patterns: [], dataTier, entryIdx: idx, absorptionIdx: null, stopBeyond: null, keyLevel: null, vp: levelCtx.vp };
  }
  if (levelCtx.nearestAligned || levelCtx.nearest) {
    patterns.push("key_level");
    score += 2;
  }

  const levelPrice = levelCtx.nearestAligned?.level ?? levelCtx.nearest?.level ?? null;
  const divergenceAtLevel = detectCvdDivergence(candles, idx, side, pre, ofOpts);
  const approachDiv = detectApproachCvdDivergence(candles, idx, side, pre, levelPrice, ofOpts);
  const absorption = detectAbsorption(candles, idx, side, pre, ofOpts);
  const stacked = detectStackedDelta(candles, idx, side, ofOpts);
  let absorptionIdx = absorption ? idx : null;

  if (approachDiv && !divergenceAtLevel) {
    patterns.push("approach_cvd");
    score += 2;
  }
  if (divergenceAtLevel || approachDiv) {
    if (!patterns.includes("approach_cvd")) patterns.push("cvd_divergence");
    if (!approachDiv || divergenceAtLevel) score += 2;
  }

  if (absorption) {
    patterns.push("absorption");
    score += 3;
  }
  if (stacked) {
    patterns.push("stacked_delta");
    score += 3;
  }

  const book = liveCtx.orderBookSnapshot ?? cfg.orderBookSnapshot ?? null;
  if (book && passesOrderBookPressure(side, book, ofOpts)) {
    patterns.push("book_pressure");
    score += 2;
  } else if (book && !passesOrderBookPressure(side, book, ofOpts)) {
    return {
      pass: false,
      score,
      patterns,
      dataTier,
      entryIdx: idx,
      absorptionIdx,
      stopBeyond: null,
      keyLevel: levelCtx.nearestAligned?.name ?? levelCtx.nearest?.name ?? null,
      vp: levelCtx.vp,
    };
  }

  let entryIdx = idx;
  let signalBarIdx = idx;
  if (ofOpts.requireConfirmation) {
    const confirmNow = detectDeltaConfirmation(candles, idx, side, pre, ofOpts);
    const absorbPrev = idx > 0 && detectAbsorption(candles, idx - 1, side, pre, ofOpts);
    const stackPrev = idx > 0 && detectStackedDelta(candles, idx - 1, side, ofOpts);
    if ((absorbPrev || stackPrev) && confirmNow) {
      if (absorbPrev && !patterns.includes("absorption")) {
        patterns.push("absorption");
        score += 3;
      }
      if (stackPrev && !patterns.includes("stacked_delta")) {
        patterns.push("stacked_delta");
        score += 3;
      }
      patterns.push("delta_confirm");
      score += 2;
      absorptionIdx = idx - 1;
      signalBarIdx = idx;
      entryIdx = idx + 1;
    } else if (absorption && !confirmNow) {
      return {
        pass: false,
        score,
        patterns,
        dataTier,
        entryIdx: idx,
        signalBarIdx: idx,
        absorptionIdx,
        stopBeyond: side === "BUY" ? bar.low : bar.high,
        keyLevel: levelCtx.nearestAligned?.name ?? null,
        vp: levelCtx.vp,
      };
    } else if (!confirmNow) {
      return {
        pass: false,
        score,
        patterns,
        dataTier,
        entryIdx: idx,
        signalBarIdx: idx,
        absorptionIdx,
        stopBeyond: absorption ? (side === "BUY" ? bar.low : bar.high) : null,
        keyLevel: levelCtx.nearestAligned?.name ?? null,
        vp: levelCtx.vp,
      };
    }
  }

  let stopBeyond = null;
  if (absorptionIdx != null) {
    const abBar = candles[absorptionIdx];
    stopBeyond = side === "BUY" ? abBar.low : abBar.high;
  } else if (stacked) {
    stopBeyond = side === "BUY" ? bar.low : bar.high;
  } else if (divergenceAtLevel || approachDiv) {
    stopBeyond = side === "BUY" ? bar.low : bar.high;
  }

  const pass = evaluateGuideConfluencePass(patterns, {
    absorptionIdx,
    requireConfirmation: ofOpts.requireConfirmation,
    requireKeyLevel: ofOpts.requireKeyLevel,
    confluenceMode: ofOpts.confluenceMode,
    allowCvdOnly: ofOpts.allowCvdOnly,
  });

  if (entryIdx >= candles.length) {
    return {
      pass: false,
      score,
      patterns,
      dataTier,
      entryIdx,
      signalBarIdx,
      absorptionIdx,
      stopBeyond: null,
      keyLevel: levelCtx.nearestAligned?.name ?? levelCtx.nearest?.name ?? null,
      vp: levelCtx.vp,
    };
  }

  const ofMeta = {
    dataTier,
    patterns,
    keyLevel: levelCtx.nearestAligned?.name ?? levelCtx.nearest?.name ?? null,
    stopBeyond,
    entryIdx,
    signalBarIdx,
    vp: levelCtx.vp,
  };
  const entryBar = candles[Math.min(entryIdx, candles.length - 1)];
  const entryPx = entryBar?.close ?? bar.close;
  const brackets = pass ? buildOrderFlowBrackets(side, entryPx, ofMeta, levelCtx.vp, cfg) : null;

  return {
    pass: pass && Boolean(brackets),
    score,
    patterns,
    dataTier,
    entryIdx,
    signalBarIdx,
    absorptionIdx,
    stopBeyond,
    keyLevel: ofMeta.keyLevel,
    vp: levelCtx.vp,
    ofMeta,
    ofBrackets: brackets,
  };
}

/**
 * Confluence-mode check: veto when gate ON and OF fails.
 * @returns {{ ok: boolean, score: number, patterns: string[], techniques: string[], dataTier: string, ofMeta?: object }}
 */
export function applyOrderFlowGate(candles, idx, side, pre, cfg = {}, liveCtx = {}) {
  const result = evaluateOrderFlowAtLevel(candles, idx, side, pre, cfg, liveCtx);
  const techniques = [];
  if (result.patterns.includes("absorption")) techniques.push(side === "BUY" ? "of_absorb_long" : "of_absorb_short");
  if (result.patterns.includes("stacked_delta")) techniques.push(side === "BUY" ? "cvd_long" : "cvd_short");
  if (result.patterns.includes("cvd_divergence")) techniques.push(side === "BUY" ? "of_cvd_div_long" : "of_cvd_div_short");
  if (result.patterns.includes("delta_confirm")) techniques.push("of_confirm");
  if (result.patterns.includes("book_pressure")) techniques.push("of_book");

  const vetoMode = cfg.intradayOfVetoMode === true;
  const minPartial = Math.max(2, Number(cfg.intradayOfMinPartialScore ?? 4));
  const softOk =
    !vetoMode &&
    result.score >= minPartial &&
    result.patterns.includes("key_level") &&
    result.patterns.includes("delta_confirm") &&
    (result.patterns.includes("absorption") || result.patterns.includes("stacked_delta"));
  const ok = result.pass || softOk;

  if (!ok) {
    return { ok: false, score: result.score, patterns: result.patterns, techniques, dataTier: result.dataTier };
  }

  return {
    ok: true,
    score: result.score,
    patterns: result.patterns,
    techniques,
    dataTier: result.dataTier,
    ofMeta: result.ofMeta,
    ofBrackets: result.ofBrackets,
  };
}

/** Solo order-flow setup scan at idx (side from level + VP zone). */
export function evaluateOrderFlowSoloSetup(candles, idx, pre, cfg = {}, liveCtx = {}) {
  const inferred = inferOrderFlowSide(candles, idx, pre, cfg);
  const sides = inferred ? [inferred] : ["BUY", "SELL"];
  let best = null;
  for (const side of sides) {
    const r = evaluateOrderFlowAtLevel(candles, idx, side, pre, cfg, liveCtx);
    if (!r.pass) continue;
    if (!best || r.score > best.score) {
      best = {
        action: side,
        side,
        score: r.score,
        patterns: r.patterns,
        dataTier: r.dataTier,
        keyLevel: r.keyLevel,
        stopBeyond: r.stopBeyond,
        entryIdx: r.entryIdx,
        signalBarIdx: r.signalBarIdx ?? idx,
        ofMeta: r.ofMeta,
        ofBrackets: r.ofBrackets,
        techniques: [
          "of_solo",
          ...r.patterns.map((p) => `of_${p}`),
          side === "BUY" ? "cvd_long" : "cvd_short",
        ],
      };
    }
  }
  if (!best || !best.ofBrackets) return null;
  const minScore = Math.max(4, Number(cfg.intradayOfSoloMinScore ?? cfg.srIntradayMinScore ?? 5));
  if (best.score < minScore) return null;
  if ((best.signalBarIdx ?? idx) !== idx) return null;
  const entryIdx = best.entryIdx ?? idx;
  const brackets = best.ofBrackets;
  return {
    action: best.action,
    reason: `ipro_of_${best.patterns.slice(0, 3).join("+")}`,
    score: best.score,
    techniques: best.techniques,
    tier: best.score >= minScore + 2 ? "A" : "B",
    vetoPassed: true,
    ofMeta: best.ofMeta,
    entryIdx,
    signalBarIdx: best.signalBarIdx,
    ofBrackets: brackets,
    liqBrackets: brackets
      ? { slPct: brackets.slPct, tpPct: brackets.tp2Pct, rr: brackets.rr, partialTp: brackets.partialTp }
      : best.stopBeyond
        ? {
            slPct: Math.abs(candles[idx].close - best.stopBeyond) / candles[idx].close,
            tpPct: null,
            rr: null,
          }
        : null,
  };
}

/**
 * Guide Step 8: exit when delta is strongly against the position for 2 bars.
 * Ignores weak/noisy bars and the post-confirmation grace window (confirmation
 * requires a delta flip, so immediate bars often look "against" without meaning
 * the trade failed).
 */
export function orderFlowExitSignal(candles, idx, side, cfg = {}, entryIdx = -1) {
  if (idx < 1) return false;
  const grace = Math.max(0, Math.round(Number(cfg.intradayOfExitGraceBars ?? 3)));
  if (entryIdx >= 0 && idx - entryIdx < grace) return false;

  const ofOpts = buildOrderFlowOpts(cfg);
  const minRatio = Math.max(0.25, Number(cfg.intradayOfExitMinDeltaRatio ?? 0.4));

  const stronglyAgainst = (i) => {
    const m = barDeltaMeta(candles[i], ofOpts);
    const vol = Number(candles[i].volume) || 0;
    if (vol <= 0 || m.tier === "none") return false;
    const ratio = Math.abs(m.delta) / vol;
    if (ratio < minRatio) return false;
    return side === "BUY" ? m.delta < 0 : m.delta > 0;
  };

  return stronglyAgainst(idx) && stronglyAgainst(idx - 1);
}
