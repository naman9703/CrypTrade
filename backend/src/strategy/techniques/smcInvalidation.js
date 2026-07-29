/**
 * SMC/ICT invalidation — prerequisite rules that cancel a setup after it formed.
 *
 * Distinct from inducement (`smcInducement.js`): inducement is a wick pierce then
 * return into the array (valid liquidity grab). Invalidation is a decisive close
 * that kills the structure/array — do not enter.
 *
 * Frozen definitions (see docs/SMC_ICT_FROZEN_RULESET.md):
 *   - Reclaimed CHoCH: close back through the CHoCH break level after chochIdx
 *   - Blown OB: close through the OB protective edge after the OB printed
 *   - Mitigated FVG: wick through the far edge between form and entry
 *   - Continuation sweep: after reclaim, close beyond the swept wick again
 */

import { isFvgMitigated } from "./fairValueGap.js";

/**
 * Master switch. Default ON when CHoCH is required or full/balanced profile —
 * those paths claim ICT sequence fidelity. Sweep/lite without CHoCH stays OFF
 * so BNB reclaim baselines are unchanged.
 */
export function resolveEnforceInvalidation(opts = {}, requireChoch = false) {
  if (opts.intradaySmcEnforceInvalidation === false) return false;
  if (opts.intradaySmcEnforceInvalidation === true) return true;
  const p = String(opts.intradaySmcIctProfile ?? "").toLowerCase();
  if (p === "full" || p === "ict2022" || p === "balanced" || p === "daily") return true;
  return requireChoch === true;
}

export function resolveInvalidateReclaimedChoch(opts = {}, enforce = false) {
  if (opts.intradaySmcInvalidateReclaimedChoch === false) return false;
  if (opts.intradaySmcInvalidateReclaimedChoch === true) return true;
  return enforce;
}

export function resolveInvalidateBlownOb(opts = {}, enforce = false) {
  if (opts.intradaySmcInvalidateBlownOb === false) return false;
  if (opts.intradaySmcInvalidateBlownOb === true) return true;
  return enforce;
}

export function resolveRequireUnmitigatedFvgAtEntry(opts = {}, enforce = false) {
  if (opts.intradaySmcRequireUnmitigatedFvgAtEntry === false) return false;
  if (opts.intradaySmcRequireUnmitigatedFvgAtEntry === true) return true;
  return enforce;
}

export function resolveRejectContinuationSweeps(opts = {}, enforce = false) {
  if (opts.intradaySmcRejectContinuationSweeps === false) return false;
  if (opts.intradaySmcRejectContinuationSweeps === true) return true;
  return enforce;
}

/**
 * CHoCH still valid at entry? False if any post-CHoCH close reclaims the break.
 * BUY (bullish CHoCH): close < chochLevel. SELL: close > chochLevel.
 */
export function isChochReclaimed(candles, chochIdx, chochLevel, side, entryIdx) {
  if (chochIdx == null || !Number.isFinite(Number(chochLevel))) return false;
  const level = Number(chochLevel);
  const from = Math.floor(chochIdx) + 1;
  const to = Math.min(candles.length - 1, Math.floor(entryIdx));
  for (let j = from; j <= to; j++) {
    const c = Number(candles[j]?.close);
    if (!Number.isFinite(c)) continue;
    if (side === "BUY" && c < level) return true;
    if (side === "SELL" && c > level) return true;
  }
  return false;
}

/**
 * OB blown through — decisive close beyond protective edge (not wick-only pierce).
 * BUY OB: close < bottom. SELL OB: close > top.
 */
export function isObBlownThrough(candles, ob, side, fromIdx, toIdx) {
  if (!ob || !candles?.length) return false;
  const lo = Math.min(Number(ob.bottom), Number(ob.top));
  const hi = Math.max(Number(ob.bottom), Number(ob.top));
  if (!(lo > 0) || !(hi >= lo)) return false;
  const from = Math.max(0, Math.floor(fromIdx));
  const to = Math.min(candles.length - 1, Math.floor(toIdx));
  for (let j = from + 1; j <= to; j++) {
    const c = Number(candles[j]?.close);
    if (!Number.isFinite(c)) continue;
    if (side === "BUY" && c < lo) return true;
    if (side === "SELL" && c > hi) return true;
  }
  return false;
}

/** FVG fully mitigated between form and entry (wick through far edge). */
export function isFvgInvalidAtEntry(candles, fvg, side, entryIdx) {
  if (!fvg) return false;
  return isFvgMitigated(candles, fvg, entryIdx, side);
}

/**
 * Sweep → continuation rather than reversal: after reclaim, a close prints
 * beyond the swept wick again (fade thesis failed).
 */
export function isSweepContinuation(candles, cycle, side, entryIdx) {
  if (!cycle || !candles?.length) return false;
  const reclaimIdx = Number(cycle.reclaimIdx);
  const wick = Number(cycle.wick);
  const level = Number(cycle.level);
  if (!Number.isFinite(reclaimIdx) || !Number.isFinite(wick)) return false;
  const edge = Number.isFinite(level)
    ? side === "BUY"
      ? Math.min(wick, level)
      : Math.max(wick, level)
    : wick;
  const from = Math.floor(reclaimIdx) + 1;
  const to = Math.min(candles.length - 1, Math.floor(entryIdx));
  for (let j = from; j <= to; j++) {
    const c = Number(candles[j]?.close);
    if (!Number.isFinite(c)) continue;
    if (side === "BUY" && c < edge) return true;
    if (side === "SELL" && c > edge) return true;
  }
  return false;
}

/**
 * Run all enabled invalidation checks for one candidate cycle.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkSmcInvalidation({
  candles,
  side,
  entryIdx,
  cycle,
  chochIdx,
  chochLevel,
  fvg,
  ob,
  opts = {},
  requireChoch = false,
}) {
  const enforce = resolveEnforceInvalidation(opts, requireChoch);

  if (resolveRejectContinuationSweeps(opts, enforce) && isSweepContinuation(candles, cycle, side, entryIdx)) {
    return { ok: false, reason: "sweep_continuation" };
  }

  if (
    chochIdx != null &&
    resolveInvalidateReclaimedChoch(opts, enforce) &&
    isChochReclaimed(candles, chochIdx, chochLevel, side, entryIdx)
  ) {
    return { ok: false, reason: "choch_reclaimed" };
  }

  if (fvg && resolveRequireUnmitigatedFvgAtEntry(opts, enforce) && isFvgInvalidAtEntry(candles, fvg, side, entryIdx)) {
    return { ok: false, reason: "fvg_mitigated" };
  }

  if (ob && resolveInvalidateBlownOb(opts, enforce)) {
    const formed = Number(ob.obIdx ?? ob.displacementIdx ?? -1);
    if (formed >= 0 && isObBlownThrough(candles, ob, side, formed, entryIdx)) {
      return { ok: false, reason: "ob_blown" };
    }
  }

  return { ok: true };
}
