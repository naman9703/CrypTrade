/**
 * SMC/ICT intraday orchestrator — ICT 2022 reversal model.
 *
 * Sequence (all evidence at or before the entry bar — no lookahead):
 *   1. HTF bias aligned with trade side
 *   2. Liquidity sweep of PDH/PDL or session cluster + reclaim
 *   3. CHoCH — change of character after the sweep (optional / soft)
 *   4. MSS — displacement candle breaking structure (BOS + displacement)
 *   5. PD array — FVG or OB from the displacement leg only
 *   6. ENTRY on retrace into FVG/OB after MSS bar
 *   7. SL beyond swept wick / structure, TP at opposing liquidity (capped R)
 */

import {
  scanSessionLiquidityCycles,
  resolveSessionExtremeLevel,
  dayStartIndex,
} from "./techniques/liquidity.js";
import { passesConfirmationCandle } from "./techniques/confirmationCandles.js";
import {
  detectMssInRange,
  detectChochInRange,
  detectBosInRange,
} from "./techniques/bosChoch.js";
import { passesSmcHtfBias, attachSmcHtfToPre, getSmcHtfBiasMeta } from "./techniques/htfBias.js";
import { inSmcKillzone, killzoneLabel } from "./techniques/sessionKillzones.js";
import { passesSmcVolatilityFilter } from "./techniques/smcVolatility.js";
import {
  findActiveFvg,
  findFvgFromDisplacement,
  priceInFvgZone,
  priceAtFvgMidpoint,
} from "./techniques/fairValueGap.js";
import {
  findOrderBlock,
  findObFromDisplacement,
  priceInObZone,
} from "./techniques/orderBlock.js";
import { buildSmcBrackets } from "./techniques/smcBrackets.js";
import { passesSmcRegimeFilter } from "./techniques/smcRegime.js";
import {
  findDealingRange,
  passesPremiumDiscount,
  resolveRequirePremiumDiscount,
  getDealingRangeMeta,
} from "./techniques/dealingRange.js";
import { rankSmcCycle, reclaimBodyStrength } from "./smcCandidateRank.js";
import { applyOrderFlowGate } from "./techniques/orderFlowPatterns.js";

/**
 * @param {object} [opts]
 */
export function isSmcIctMode(opts = {}) {
  return opts.intradayGateSmcIct === true || opts.intradaySmcIctMode === true;
}

/** Full ICT 2022 profile — all structure gates on. */
export function isFullSmcIctProfile(opts = {}) {
  const p = String(opts.intradaySmcIctProfile ?? "").toLowerCase();
  return p === "full" || p === "ict2022";
}

/** MSS + retrace + optional soft CHoCH. */
export function isBalancedSmcIctProfile(opts = {}) {
  const p = String(opts.intradaySmcIctProfile ?? "").toLowerCase();
  return p === "balanced" || p === "daily";
}

export function isSweepSmcIctProfile(opts = {}) {
  const p = String(opts.intradaySmcIctProfile ?? "").toLowerCase();
  return p === "sweep" || p === "lite";
}

function useDisplacementPdArray(opts) {
  return isFullSmcIctProfile(opts) || isBalancedSmcIctProfile(opts) || opts.intradaySmcRequireMss === true;
}

export function resolveRequireChoch(opts) {
  if (opts.intradaySmcRequireChoch === false) return false;
  if (opts.intradaySmcRequireChoch === true) return true;
  if (isFullSmcIctProfile(opts)) return true;
  return false;
}

function resolveChochStrict(opts) {
  if (opts.intradaySmcChochStrict === true) return true;
  if (opts.intradaySmcChochStrict === false) return false;
  return isFullSmcIctProfile(opts);
}

/** CHoCH eval opts — strict mode requires prior trend alignment (no soft bypass). */
function chochEvalOpts(opts) {
  const strict = resolveChochStrict(opts);
  if (strict) {
    return {
      ...opts,
      intradaySmcChochRequireTrend: opts.intradaySmcChochRequireTrend !== false,
    };
  }
  return { ...opts, intradaySmcChochRequireTrend: false };
}

function resolveRequireMss(opts) {
  if (isFullSmcIctProfile(opts) || isBalancedSmcIctProfile(opts)) return true;
  return opts.intradaySmcRequireMss === true;
}

function resolveRequireBos(opts) {
  if (isFullSmcIctProfile(opts)) return true;
  return opts.intradaySmcRequireBos === true;
}

/** FVG retrace: explicit false wins; balanced/full default on; else FvgRetrace flag. */
export function resolveRequireRetrace(opts) {
  if (opts.intradaySmcRequireRetrace === false) return false;
  if (isFullSmcIctProfile(opts) || isBalancedSmcIctProfile(opts)) return true;
  if (opts.intradaySmcRequireRetrace != null) return opts.intradaySmcRequireRetrace !== false;
  return opts.intradaySmcRequireFvgRetrace === true;
}

/** `midpoint` | `ce` = ICT CE at 50% of displacement FVG; default full-zone/OB retrace. */
export function resolveFvgEntryMode(opts) {
  const m = String(opts.intradaySmcFvgEntryMode ?? "zone").toLowerCase();
  return m === "midpoint" || m === "ce" ? "midpoint" : "zone";
}

function collectRecentSweepCycles(candles, idx, side, pre, opts, dayStart, minReclaim) {
  const sweepPct = Number(
    opts.sweepPct ?? opts.srIntradaySweepPct ?? pre?.adaptive?.sweepPct ?? 0.001,
  );
  const pdh = pre.prevDayHigh?.[idx];
  const pdl = pre.prevDayLow?.[idx];
  const sessionLevel = side === "BUY" ? pdl : pdh;
  const sessionOpposing = side === "BUY" ? pdh : pdl;
  const sessionType = side === "BUY" ? "pdl" : "pdh";
  const out = [];

  const pushInWindow = (cycles) => {
    for (const c of cycles) {
      if (c.reclaimIdx >= minReclaim && c.reclaimIdx <= idx) out.push(c);
    }
  };

  if (sessionLevel > 0 && sessionOpposing > 0) {
    pushInWindow(
      scanSessionLiquidityCycles(
        candles, idx, side, sessionLevel, sessionOpposing, sessionType, sweepPct, dayStart, opts,
      ),
    );
  }

  const extreme = resolveSessionExtremeLevel(candles, idx, side, dayStart, opts);
  if (
    extreme &&
    sessionLevel > 0 &&
    Math.abs(extreme.level - sessionLevel) / sessionLevel >
      Number(opts.intradayLiqSessionExtremeMinDistFromSession ?? 0.005)
  ) {
    const opp = side === "BUY" ? pdh : pdl;
    if (opp > 0) {
      pushInWindow(
        scanSessionLiquidityCycles(
          candles, idx, side, extreme.level, opp, extreme.levelType, sweepPct, dayStart, opts,
        ),
      );
    }
  }

  out.sort((a, b) => b.reclaimIdx - a.reclaimIdx);
  return out;
}

function cycleLiqQuality(cycle) {
  const ext = Math.max(0, Number(cycle.extension) || 0) * 1000;
  const bonus = cycle.levelType === "pdh" || cycle.levelType === "pdl" ? 20 : 0;
  return ext + bonus;
}

function resolvePdArrays(candles, mssIdx, sweepReclaimIdx, side, pre, opts, entryZoneMode) {
  const anchored = useDisplacementPdArray(opts);
  const minIdx = sweepReclaimIdx;

  let fvg = null;
  let ob = null;

  if (entryZoneMode === "FVG" || entryZoneMode === "EITHER") {
    fvg = anchored
      ? findFvgFromDisplacement(candles, mssIdx, side, opts, minIdx)
      : findActiveFvg(candles, mssIdx, side, opts);
  }
  if (entryZoneMode === "OB" || (entryZoneMode === "EITHER" && !fvg)) {
    ob = anchored
      ? findObFromDisplacement(candles, mssIdx, side, pre, opts, minIdx)
      : findOrderBlock(candles, mssIdx, side, pre, opts);
  }
  if (entryZoneMode === "EITHER" && !fvg && ob) {
    fvg = null;
  }

  return { fvg, ob };
}

function profileLabel(opts) {
  if (isFullSmcIctProfile(opts)) return "full";
  if (isBalancedSmcIctProfile(opts)) return "balanced";
  if (isSweepSmcIctProfile(opts)) return "sweep";
  return "custom";
}

/**
 * @param {object[]} candles
 * @param {number} idx candidate entry bar
 * @param {'BUY'|'SELL'} side
 * @param {object} pre
 * @param {object} opts
 */
export function evaluateSmcIctSetup(candles, idx, side, pre, opts = {}) {
  if (idx < 2 || !candles?.length) return null;
  if (!pre._smcHtf) attachSmcHtfToPre(candles, pre, opts);

  if (opts.intradaySmcRequireHtfBias !== false && !passesSmcHtfBias(side, pre, idx, opts)) {
    return null;
  }
  const bar = candles[idx];
  if (!inSmcKillzone(bar.ts, opts)) return null;
  if (!passesSmcVolatilityFilter(candles, idx, pre, opts)) return null;
  if (!passesSmcRegimeFilter(candles, idx, pre, opts)) return null;

  const requireChoch = resolveRequireChoch(opts);
  const requireMss = resolveRequireMss(opts);
  const requireBos = resolveRequireBos(opts);
  const requireRetrace = resolveRequireRetrace(opts);
  const fvgEntryMode = resolveFvgEntryMode(opts);
  const fvgMidpointEntry = fvgEntryMode === "midpoint" && requireRetrace;
  const requireConfirm = opts.intradaySmcRequireConfirm === true;
  const requirePremiumDiscount = resolveRequirePremiumDiscount(opts);
  const entryZoneMode = String(opts.intradaySmcEntryZoneMode ?? "EITHER").toUpperCase();
  const lookback = Math.max(3, Number(opts.intradaySmcLookbackBars ?? 30));
  const maxBarsAfterReclaim = Math.max(
    0,
    Number(opts.intradaySmcMaxBarsAfterReclaim ?? opts.intradaySmcBosMaxBars ?? 12),
  );

  const dayStart = dayStartIndex(candles, idx);
  const minReclaim = Math.max(dayStart, idx - lookback);
  const cycles = collectRecentSweepCycles(candles, idx, side, pre, opts, dayStart, minReclaim);
  if (!cycles.length) return null;

  let best = null;
  let bestRank = -Infinity;

  for (const cyc of cycles) {
    const sweepReclaimIdx = cyc.reclaimIdx;
    if (idx < sweepReclaimIdx) continue;
    if (maxBarsAfterReclaim > 0 && idx - sweepReclaimIdx > maxBarsAfterReclaim) continue;

    let chochIdx = null;
    let chochLevel = null;
    let chochType = null;
    if (requireChoch) {
      const choch = detectChochInRange(candles, sweepReclaimIdx, idx, side, chochEvalOpts(opts));
      if (!choch.ok) continue;
      chochIdx = choch.chochIdx;
      chochLevel = choch.chochLevel;
      chochType = choch.type;
    }

    const structureFrom = chochIdx != null ? chochIdx : sweepReclaimIdx;

    let mssIdx = structureFrom;
    let mssLevel = null;
    let mssType = null;
    let bosIdx = null;
    let bosLevel = null;
    let bosType = null;

    if (requireMss) {
      const mss = detectMssInRange(candles, structureFrom, idx, side, opts, pre);
      if (!mss.ok) continue;
      mssIdx = mss.mssIdx;
      mssLevel = mss.mssLevel;
      mssType = mss.type;
      bosIdx = mssIdx;
      bosLevel = mssLevel;
      bosType = mssType;
    } else if (requireBos) {
      const bos = detectBosInRange(candles, structureFrom, idx, side, opts);
      if (!bos.ok) continue;
      bosIdx = bos.bosIdx;
      bosLevel = bos.bosLevel;
      bosType = bos.type;
      mssIdx = bosIdx;
      mssLevel = bosLevel;
    }

    if (chochIdx != null && mssIdx < chochIdx) continue;

    const { fvg, ob } = resolvePdArrays(candles, mssIdx, sweepReclaimIdx, side, pre, opts, entryZoneMode);
    if (fvgMidpointEntry) {
      if (!fvg) continue;
    } else if (entryZoneMode === "FVG" && !fvg) continue;
    else if (entryZoneMode === "OB" && !ob) continue;
    else if (entryZoneMode === "EITHER" && !fvg && !ob) continue;

    let inZone = false;
    let entryZone = "reclaim";
    if (fvgMidpointEntry) {
      inZone = priceAtFvgMidpoint(candles, idx, fvg, side, opts);
      entryZone = "fvg_mid";
    } else {
      inZone =
        (fvg && priceInFvgZone(candles, idx, fvg, side, opts)) ||
        (ob && priceInObZone(candles, idx, ob, side, opts));
      if (fvg && priceInFvgZone(candles, idx, fvg, side, opts)) entryZone = "fvg";
      else if (ob && priceInObZone(candles, idx, ob, side, opts)) entryZone = "ob";
    }

    if (requireRetrace) {
      if (!inZone) continue;
      if (idx <= mssIdx) continue;
    } else if (!inZone && idx !== mssIdx) {
      continue;
    }

    if (requireConfirm) {
      const prev = idx > 0 ? candles[idx - 1] : null;
      if (!passesConfirmationCandle(bar, prev, side, opts)) continue;
    }

    let entry = Number(bar.close);
    if (fvgMidpointEntry && fvg) {
      entry = Number(fvg.mid ?? (fvg.top + fvg.bottom) / 2);
    }
    let dealingRangeMeta = null;
    if (requirePremiumDiscount) {
      const dr = findDealingRange(candles, idx, opts);
      if (!dr || !passesPremiumDiscount(side, entry, dr, opts)) continue;
      dealingRangeMeta = getDealingRangeMeta(dr);
    }
    const brackets = buildSmcBrackets(
      side,
      entry,
      {
        wick: cyc.wick,
        opposing: cyc.opposing,
        opposingLevel: cyc.opposing,
        reclaimIdx: sweepReclaimIdx,
      },
      candles,
      idx,
      opts,
    );
    if (!brackets) continue;

    let smcOfTechniques = [];
    if (opts.intradaySmcUseOrderFlow === true) {
      const of = applyOrderFlowGate(candles, idx, side, pre, opts, {
        orderBookSnapshot: opts.orderBookSnapshot ?? opts._orderBookSnapshot,
      });
      if (!of.ok) continue;
      smcOfTechniques = of.techniques;
    }

    const liqQuality = cycleLiqQuality(cyc);
    const reclaimBodyRatio = reclaimBodyStrength(candles, sweepReclaimIdx, side);
    const rank = rankSmcCycle(candles, side, cyc, {
      inZone,
      chochIdx,
      fvg,
      ob,
      brackets,
      reclaimIdx: sweepReclaimIdx,
    });

    const techniques = ["smc_ict", "liq_sweep", cyc.levelType];
    if (chochIdx != null) techniques.push("smc_choch");
    if (requireMss) techniques.push("smc_mss");
    else if (requireBos) techniques.push("smc_bos");
    if (fvg) techniques.push("smc_fvg");
    if (ob) techniques.push("smc_ob");
    if (requireRetrace) techniques.push("smc_retrace");
    if (requirePremiumDiscount) techniques.push("smc_premium_discount");
    techniques.push(...smcOfTechniques);

    const sweepStartIdx = cyc.sweepStartIdx ?? Math.max(0, sweepReclaimIdx - 8);
    let sweepWickIdx = sweepStartIdx;
    if (side === "BUY") {
      for (let j = sweepStartIdx; j <= sweepReclaimIdx; j++) {
        if (candles[j]?.low <= cyc.wick) sweepWickIdx = j;
      }
    } else {
      for (let j = sweepStartIdx; j <= sweepReclaimIdx; j++) {
        if (candles[j]?.high >= cyc.wick) sweepWickIdx = j;
      }
    }

    const opposingLevel = Number(brackets.opposingLevel ?? cyc.opposing ?? 0);
    const tp2Price = Number(brackets.tp2Price ?? brackets.tpPrice ?? 0);
    const smcMeta = {
      ...getSmcHtfBiasMeta(pre, idx, opts),
      levelType: cyc.levelType ?? null,
      sweepLevel: cyc.level,
      opposingLevel: opposingLevel > 0 ? opposingLevel : null,
      plannedRr: brackets.rr ?? null,
      slPrice: brackets.slPrice ?? null,
      tp2Price: tp2Price > 0 ? tp2Price : null,
      tp2Mode: brackets.tp2Mode ?? null,
      internalTpLevel: brackets.internalTpLevel ?? null,
      sessionOpposingLevel: brackets.sessionOpposingLevel ?? opposingLevel,
      tpCappedByMaxRr:
        opposingLevel > 0 &&
        tp2Price > 0 &&
        Math.abs(tp2Price - opposingLevel) / opposingLevel > 0.005,
      sweepExtensionPct: cyc.extension,
      sweepStartIdx,
      sweepStartTs: candles[sweepStartIdx]?.ts ?? null,
      sweepWickIdx,
      sweepWickTs: candles[sweepWickIdx]?.ts ?? null,
      sweepReclaimIdx,
      sweepReclaimTs: candles[sweepReclaimIdx]?.ts ?? null,
      reclaimBodyRatio,
      chochLevel,
      chochType,
      chochIdx,
      chochTs: chochIdx != null ? candles[chochIdx]?.ts ?? null : null,
      bosLevel: mssLevel ?? bosLevel,
      bosType: mssType ?? bosType,
      mssIdx,
      mssTs: candles[mssIdx]?.ts ?? null,
      bosIdx,
      entryIdx: idx,
      entryBarTs: candles[idx]?.ts ?? null,
      sweepReclaimIdx,
      fvgTop: fvg?.top ?? null,
      fvgBottom: fvg?.bottom ?? null,
      fvgFormedIdx: fvg?.formedIdx ?? null,
      fvgFormedTs: fvg?.formedIdx != null ? candles[fvg.formedIdx]?.ts ?? null : null,
      obTop: ob?.top ?? null,
      obBottom: ob?.bottom ?? null,
      obIdx: ob?.obIdx ?? null,
      obTs: ob?.obIdx != null ? candles[ob.obIdx]?.ts ?? null : null,
      obDisplacementIdx: ob?.displacementIdx ?? null,
      obDispTs: ob?.displacementIdx != null ? candles[ob.displacementIdx]?.ts ?? null : null,
      killzone: killzoneLabel(opts),
      ictProfile: profileLabel(opts),
      barsAfterReclaim: idx - sweepReclaimIdx,
      entryZone,
      fvgEntryMode: fvgMidpointEntry ? "midpoint" : fvgEntryMode,
      fvgMid: fvg?.mid ?? null,
      ...(dealingRangeMeta ?? {}),
    };

    const enriched = {
      side,
      action: side,
      level: cyc.level,
      levelType: cyc.levelType,
      wick: cyc.wick,
      sweepWick: cyc.wick,
      opposing: cyc.opposing,
      extension: cyc.extension,
      reclaimIdx: sweepReclaimIdx,
      sweepReclaimIdx,
      entryIdx: idx,
      chochIdx,
      mssIdx,
      bosIdx: bosIdx ?? mssIdx,
      bosLevel: mssLevel ?? bosLevel,
      liqQuality,
      liqBrackets: brackets,
      techniques,
      smcMeta,
      entryReason: [
        "smc_ict",
        chochIdx != null ? "choch" : null,
        requireMss ? "mss" : requireBos ? "bos" : null,
        fvg ? "fvg" : ob ? "ob" : null,
        requireRetrace ? "retrace" : "reclaim",
      ]
        .filter(Boolean)
        .join("+"),
      score: Math.min(
        16,
        Math.round(
          9 +
            liqQuality / 35 +
            (chochIdx != null ? 1 : 0) +
            (requireMss || requireBos ? 1 : 0) +
            (requireRetrace && inZone ? 2 : 0),
        ),
      ),
    };

    if (rank > bestRank) {
      bestRank = rank;
      best = enriched;
    }
  }

  return best;
}

export function evaluateBestSmcIctAtBar(candles, idx, pre, opts = {}) {
  let best = null;
  for (const side of ["BUY", "SELL"]) {
    const s = evaluateSmcIctSetup(candles, idx, side, pre, opts);
    if (!s) continue;
    if (!best || (s.liqQuality ?? 0) > (best.liqQuality ?? 0)) best = s;
  }
  return best;
}

/** Funnel stage counts aligned with evaluateSmcIctSetup (for tuning scripts). */
export function countSmcFunnelStages(candles, idx, side, pre, opts = {}) {
  const out = {
    passHtf: false,
    passKz: false,
    passVol: false,
    hasCycle: false,
    passChoch: false,
    passMss: false,
    hasPd: false,
    inZone: false,
    passSetup: false,
  };
  if (idx < 2 || !candles?.length) return out;
  if (!pre._smcHtf) attachSmcHtfToPre(candles, pre, opts);
  if (opts.intradaySmcRequireHtfBias !== false && !passesSmcHtfBias(side, pre, idx, opts)) {
    return out;
  }
  out.passHtf = true;
  if (!inSmcKillzone(candles[idx].ts, opts)) return out;
  out.passKz = true;
  if (!passesSmcVolatilityFilter(candles, idx, pre, opts)) return out;
  out.passVol = true;

  const lookback = Math.max(3, Number(opts.intradaySmcLookbackBars ?? 30));
  const dayStart = dayStartIndex(candles, idx);
  const minReclaim = Math.max(dayStart, idx - lookback);
  const cycles = collectRecentSweepCycles(candles, idx, side, pre, opts, dayStart, minReclaim);
  if (!cycles.length) return out;
  out.hasCycle = true;

  const requireChoch = resolveRequireChoch(opts);
  const requireMss = resolveRequireMss(opts);
  const entryZoneMode = String(opts.intradaySmcEntryZoneMode ?? "EITHER").toUpperCase();

  let anyChoch = false;
  let anyMss = false;
  let anyPd = false;
  let anyZone = false;
  let anySetup = false;

  for (const cyc of cycles) {
    const sweepReclaimIdx = cyc.reclaimIdx;
    if (idx < sweepReclaimIdx) continue;

    let chochIdx = null;
    if (requireChoch) {
      const choch = detectChochInRange(candles, sweepReclaimIdx, idx, side, chochEvalOpts(opts));
      if (!choch.ok) continue;
      chochIdx = choch.chochIdx;
      anyChoch = true;
    }

    const structureFrom = chochIdx != null ? chochIdx : sweepReclaimIdx;
    let mssIdx = structureFrom;
    if (requireMss) {
      const mss = detectMssInRange(candles, structureFrom, idx, side, opts, pre);
      if (!mss.ok) continue;
      mssIdx = mss.mssIdx;
      anyMss = true;
    }

    const { fvg, ob } = resolvePdArrays(candles, mssIdx, sweepReclaimIdx, side, pre, opts, entryZoneMode);
    if (!fvg && !ob) continue;
    anyPd = true;

    const inZone =
      (fvg && priceInFvgZone(candles, idx, fvg, side, opts)) ||
      (ob && priceInObZone(candles, idx, ob, side, opts));
    if (inZone) anyZone = true;

    if (evaluateSmcIctSetup(candles, idx, side, pre, opts)) anySetup = true;
  }

  out.passChoch = !requireChoch || anyChoch;
  out.passMss = !requireMss || anyMss;
  out.hasPd = anyPd;
  out.inZone = anyZone;
  out.passSetup = anySetup;
  return out;
}
