import { roundTo } from "./math.js";

/**
 * Trailing SL for autotrade:
 * 1) Fee breakeven lock (~round-trip taker fee on entry price).
 * 2) First scalping: always fee-equivalent (second fee notch from entry: ±4×feeRate).
 * 3) Up to 3 optional extra locks at user % of entry (each level is entry × (1 ± pct/100)).
 */

export function clampFeeRate(r) {
  const x = Number(r);
  if (!Number.isFinite(x) || x < 0) return 0.0004;
  return Math.min(0.01, Math.max(0, x));
}

/** Approximate stop price that nets ~zero after entry+exit taker fees (same notional). */
export function feeCoverageLockPx({ entryPx, isLong, feeRate }) {
  const E = Number(entryPx);
  const r = clampFeeRate(feeRate);
  if (!Number.isFinite(E) || E <= 0) return null;
  if (isLong) return E * (1 + 2 * r);
  return E * (1 - 2 * r);
}

/**
 * First scalping lock after breakeven: price move from entry equal to another ~round-trip fee
 * (cumulative 4× feeRate from entry; complements the breakeven step at 2× feeRate).
 */
export function firstScalpingFeeEquivLockPx({ entryPx, isLong, feeRate }) {
  const E = Number(entryPx);
  const r = clampFeeRate(feeRate);
  if (!Number.isFinite(E) || E <= 0) return null;
  if (isLong) return E * (1 + 4 * r);
  return E * (1 - 4 * r);
}

/** Lock at `pctOfEntry` percent from entry (e.g. 0.35 → 0.35%). */
export function pctOfEntryLockPx({ entryPx, isLong, pctOfEntry }) {
  const E = Number(entryPx);
  const p = Number(pctOfEntry) / 100;
  if (!Number.isFinite(E) || E <= 0 || !Number.isFinite(p) || p <= 0) return null;
  if (isLong) return E * (1 + p);
  return E * (1 - p);
}

/**
 * @param {number[]} extraScalpingPctsOfEntry 0–3 values, each % of entry (e.g. 0.5 = 0.5%)
 * @returns {{ kind: string; lockPx: number; pct?: number }[]} sorted for activation (long: ascending by lockPx)
 */
export function buildTrailLockPrices({ entryPx, isLong, feeRate, extraScalpingPctsOfEntry = [] }) {
  const E = Number(entryPx);
  const r = clampFeeRate(feeRate);
  if (!Number.isFinite(E) || E <= 0) return [];

  const extras = (Array.isArray(extraScalpingPctsOfEntry) ? extraScalpingPctsOfEntry : [])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0)
    .slice(0, 3);

  const out = [];
  const feePx = feeCoverageLockPx({ entryPx: E, isLong, feeRate: r });
  if (feePx != null) out.push({ kind: "fee_breakeven", lockPx: feePx });

  const fsPx = firstScalpingFeeEquivLockPx({ entryPx: E, isLong, feeRate: r });
  if (fsPx != null) {
    const feeEquivPct = 2 * r * 100;
    out.push({ kind: "fee_first_scalp", lockPx: fsPx, feeEquivPct });
  }

  for (const pct of extras) {
    const px = pctOfEntryLockPx({ entryPx: E, isLong, pctOfEntry: pct });
    if (px != null) out.push({ kind: "user_scalp", lockPx: px, pct });
  }

  const eps = E * 1e-10;
  out.sort((a, b) => (isLong ? a.lockPx - b.lockPx : b.lockPx - a.lockPx));
  const dedup = [];
  for (const row of out) {
    const last = dedup[dedup.length - 1];
    if (last && Math.abs(last.lockPx - row.lockPx) <= eps) continue;
    dedup.push(row);
  }
  return dedup.slice(0, 5);
}

/** Max trail index (1–5): breakeven + first fee-scalp + up to 3 user % locks. */
export function maxTrailStepsForConfig(extraScalpingPctsOfEntry) {
  const n = Math.min(
    3,
    (Array.isArray(extraScalpingPctsOfEntry) ? extraScalpingPctsOfEntry : [])
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x > 0).length,
  );
  return Math.min(5, 2 + n);
}

/**
 * Advance trail state from a new mark / extreme.
 * @returns {{ trailStep: number, extremePx: number, proposedSl: number|null, advanced: boolean }}
 */
export function advanceTrailingStopState({
  entryPx,
  isLong,
  trailStep,
  extremePx,
  markPx,
  feeRate,
  extraScalpingPctsOfEntry,
}) {
  const E = Number(entryPx);
  const mark = Number(markPx);
  if (!Number.isFinite(E) || E <= 0 || !Number.isFinite(mark)) {
    return { trailStep: 0, extremePx: Number(extremePx) || mark, proposedSl: null, advanced: false };
  }
  const ext0 = Number.isFinite(Number(extremePx)) ? Number(extremePx) : mark;
  const hwm = isLong ? Math.max(ext0, mark) : Math.min(ext0, mark);

  const levels = buildTrailLockPrices({
    entryPx: E,
    isLong,
    feeRate,
    extraScalpingPctsOfEntry,
  });
  const n = levels.length;
  if (!n) return { trailStep: Number(trailStep) || 0, extremePx: hwm, proposedSl: null, advanced: false };

  let step = Math.max(0, Math.min(n, Math.floor(Number(trailStep) || 0)));
  let proposedSl = null;
  let advanced = false;

  for (let k = step; k < n; k++) {
    const L = levels[k];
    const crossed = isLong ? hwm >= L.lockPx : hwm <= L.lockPx;
    if (!crossed) break;
    step = k + 1;
    proposedSl = L.lockPx;
    advanced = true;
  }

  return { trailStep: step, extremePx: hwm, proposedSl, advanced };
}

/** Long: SL only moves up; short: only down. */
export function mergeStopWithTrail({ isLong, currentStopPx, trailSlPx }) {
  const cur = Number(currentStopPx);
  const tr = Number(trailSlPx);
  if (!Number.isFinite(tr) || tr <= 0) return Number.isFinite(cur) ? cur : null;
  if (!Number.isFinite(cur) || cur <= 0) return tr;
  if (isLong) return Math.max(cur, tr);
  return Math.min(cur, tr);
}

export function roundStopPx(px, tickSize) {
  const p = Number(px);
  const t = Number(tickSize);
  if (!Number.isFinite(p) || p <= 0) return p;
  if (!Number.isFinite(t) || t <= 0) return roundTo(p, 8);
  const steps = Math.round(p / t);
  return roundTo(steps * t, 12);
}

/**
 * Mutates Binance USD-M in-memory bracket state (local fallback + display targets).
 * @param {{ enabled: boolean; feeRate: number; extraScalpingPcts: number[]; maxTrailSteps: number }} [opts.trailingOpts]
 */
export function applyTrailingStopBinanceMemory(opts) {
  const sym = String(opts.symbol || "").toUpperCase();
  const markPx = Number(opts.markPx);
  const trailingOpts = opts.trailingOpts;
  const trailingBySymbol = opts.trailingBySymbol;
  const localBrackets = opts.localBrackets;
  const placedBracketTargets = opts.placedBracketTargets;
  const tickSize = opts.tickSize != null ? Number(opts.tickSize) : null;
  const onTrailingSlAdvance = opts.onTrailingSlAdvance;

  if (!sym || !Number.isFinite(markPx) || markPx <= 0) return false;
  if (!trailingOpts?.enabled || !trailingBySymbol) return false;

  const tr = trailingBySymbol[sym];
  if (!tr || !tr.entryPrice) return false;

  const isLong = Boolean(tr.isLong);
  const r = advanceTrailingStopState({
    entryPx: tr.entryPrice,
    isLong,
    trailStep: tr.trailStep ?? 0,
    extremePx: tr.extremePx ?? tr.entryPrice,
    markPx,
    feeRate: trailingOpts.feeRate,
    extraScalpingPctsOfEntry: trailingOpts.extraScalpingPcts,
  });

  if (r.proposedSl == null || !r.advanced) return false;

  let nextSl = r.proposedSl;
  if (tickSize != null && Number.isFinite(tickSize) && tickSize > 0) {
    nextSl = roundStopPx(nextSl, tickSize);
  } else {
    nextSl = roundTo(nextSl, 8);
  }

  const b = localBrackets[sym];
  if (b) {
    const prevSl = Number(b.stopLoss);
    const merged = mergeStopWithTrail({ isLong, currentStopPx: b.stopLoss, trailSlPx: nextSl });
    tr.trailStep = r.trailStep;
    tr.extremePx = r.extremePx;
    if (merged == null || merged === b.stopLoss) return false;
    b.stopLoss = merged;
    if (placedBracketTargets && placedBracketTargets[sym]) {
      placedBracketTargets[sym] = { ...placedBracketTargets[sym], stopLoss: merged };
    }
    onTrailingSlAdvance?.({
      symbol: sym,
      venue: "FUTURES",
      prevStopLoss: prevSl,
      newStopLoss: merged,
      trailStep: tr.trailStep,
      maxTrailSteps: trailingOpts.maxTrailSteps,
      isLong,
      entryPrice: tr.entryPrice,
      source: "binance_usdm_local_bracket",
    });
    return true;
  }
  if (placedBracketTargets && placedBracketTargets[sym]) {
    const cur = placedBracketTargets[sym].stopLoss;
    const prevSl = Number(cur);
    const merged = mergeStopWithTrail({ isLong, currentStopPx: cur, trailSlPx: nextSl });
    tr.trailStep = r.trailStep;
    tr.extremePx = r.extremePx;
    if (merged == null || merged === cur) return false;
    placedBracketTargets[sym] = { ...placedBracketTargets[sym], stopLoss: merged };
    onTrailingSlAdvance?.({
      symbol: sym,
      venue: "FUTURES",
      prevStopLoss: prevSl,
      newStopLoss: merged,
      trailStep: tr.trailStep,
      maxTrailSteps: trailingOpts.maxTrailSteps,
      isLong,
      entryPrice: tr.entryPrice,
      source: "binance_usdm_bracket_targets",
    });
    return true;
  }
  return false;
}
