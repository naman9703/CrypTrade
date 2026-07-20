/**
 * Per-bar trailing-stop simulator for the backtest engine.
 *
 * Wraps the same primitives the live bot uses
 * (`backend/src/lib/trailingStopLoss.js` + `supertrendTrailingSl.js`)
 * so a backtest produces the same SL ladder a live position would walk.
 *
 * Modes mirror live `futuresTrailingStopMode`:
 *   - "SUPERTREND" (default): tiered T01 / T02 / post-T02 ladder when fee-BE +
 *     advanced trail are both on (live default). Falls back to the legacy
 *     `computeSupertrendTrailingSlUpdate` path when one is off.
 *   - "FEE_LADDER": `advanceTrailingStopState` (round-trip BE → 2× BE → user pcts).
 *   - "OFF": no trailing.
 *
 * Pessimistic intra-bar order (matches the rest of the runner):
 *   1. Adverse extreme is checked against the **previous** SL first
 *      (handled by the runner before calling this module).
 *   2. Favorable extreme (`bar.high` LONG / `bar.low` SHORT) drives HWM and
 *      tier advancement here.
 *   3. After the trail SL is bumped, the runner re-checks the adverse extreme
 *      vs the **new** SL — if breached, the trade exits at the new SL.
 *
 * The simulator never loosens the SL (long: max-only, short: min-only) and
 * respects `minSlDistanceFrac` / `minTrailGapFromMarkFrac` exactly like live.
 */

import {
  advanceTrailingStopState,
  clampFeeRate,
  computeEffectiveTrailBuffer,
  computeSupertrendTieredMaxTrailStepFromExtreme,
  mergeStopWithTrail,
  tieredStLockPxForCompletedTrailStep,
} from "../../lib/trailingStopLoss.js";
import {
  applyMinTrailGapFromMark,
  computeSupertrendTrailingSlUpdate,
  feeRateBreakevenPadded,
  trailStepToTierLabel,
} from "../../lib/supertrendTrailingSl.js";

/**
 * @param {object} cm  resolved cost model (see costModel.js)
 * @returns {{ openR:number, closeR:number, roundTripFeeR:number }}
 */
function roundTripFeeFromCostModel(cm) {
  const openR = clampFeeRate(cm.useMakerEntries ? cm.makerOpenFeeRate : cm.takerOpenFeeRate);
  const closeR = clampFeeRate(cm.useMakerExits ? cm.makerCloseFeeRate : cm.takerCloseFeeRate);
  return { openR, closeR, roundTripFeeR: openR + closeR };
}

/**
 * Live bot maps UI keys → `supertrendUse*` when calling trailing; backtest cfg_raw keeps
 * `futuresTrailingSt*` from strategy versions. Prefer explicit bot keys when present.
 */
function resolveSupertrendTrailToggles(c) {
  const cfg = c && typeof c === "object" ? c : {};
  const useFeeBeTrail =
    cfg.futuresTrailingStFeeBreakeven != null
      ? cfg.futuresTrailingStFeeBreakeven !== false
      : cfg.supertrendUseFeeBreakeven !== false;
  const useAdvTrail =
    cfg.futuresTrailingStAdvanced != null
      ? cfg.futuresTrailingStAdvanced !== false
      : cfg.supertrendUseAdvancedTrail !== false;
  return { useFeeBeTrail, useAdvTrail };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {object} cm
 * @param {number|null|undefined} atrPct
 * @returns {object} resolved trailing parameters (mirrors live `trailingOpts`)
 */
/** Map UI / bot cfg keys to the names `trailingStopLoss.js` expects in backtests. */
function trailCfgAliases(c) {
  const feeBeMult = c.trailFeeBeMultiplier ?? c.feeBeMultiplier;
  const actSlip = c.trailActivationSlippageFrac ?? c.activationSlippageFrac;
  const postT02Buf = c.trailPostT02ActivationBufferRate ?? c.postT02ActivationBufferRate;
  const minDist = c.trailMinSlDistFrac ?? c.minSlDistanceFrac;
  const minGap = c.trailMinGapFromMarkFrac ?? c.minTrailGapFromMarkFrac;
  return { feeBeMult, actSlip, postT02Buf, minDist, minGap };
}

export function resolveTrailingOpts(cfg, cm, atrPct) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const alias = trailCfgAliases(c);
  const { roundTripFeeR } = roundTripFeeFromCostModel(cm);
  const buf = computeEffectiveTrailBuffer({
    bufferRate: Number(c.trailBufferRate ?? 0.0005),
    trailBufferMode: c.trailBufferMode,
    trailBufferAtrMult: Number(c.trailBufferAtrMult ?? 0),
    atrPct,
  });
  const feeBe = feeRateBreakevenPadded(roundTripFeeR, alias.feeBeMult);
  const slipFrac = Math.max(0, Math.min(0.01, Number(alias.actSlip ?? 0)));
  const feeBeSt = Math.min(0.02, feeBe + slipFrac);
  const t01LockSlipFrac = Math.max(0, Math.min(0.01, Number(c.trailT01LockSlippageFrac ?? 0)));
  const { useFeeBeTrail, useAdvTrail } = resolveSupertrendTrailToggles(c);
  const tieredStMode = useFeeBeTrail && useAdvTrail;
  const postT02SpacingFrac =
    c.trailPostT02SpacingFrac != null && Number.isFinite(Number(c.trailPostT02SpacingFrac))
      ? Number(c.trailPostT02SpacingFrac)
      : null;
  const postT02MaxExtraTiers =
    c.trailPostT02MaxExtraTiers != null && Number.isFinite(Number(c.trailPostT02MaxExtraTiers))
      ? Math.max(10, Math.min(500, Math.floor(Number(c.trailPostT02MaxExtraTiers))))
      : 150;
  const postT02BufRaw = Number(alias.postT02Buf);
  const postT02Buf =
    Number.isFinite(postT02BufRaw) && postT02BufRaw >= 0 ? Math.min(0.05, postT02BufRaw) : null;
  const maxStepCfg = c.maxTrailSteps;
  const maxStepCap =
    maxStepCfg != null && Number.isFinite(Number(maxStepCfg)) && Number(maxStepCfg) > 0
      ? Math.floor(Number(maxStepCfg))
      : null;
  const minDist = alias.minDist != null ? Number(alias.minDist) : 0;
  const minGap = alias.minGap != null ? Number(alias.minGap) : 0;
  const extraScalpingPcts = Array.isArray(c.extraScalpingPcts) ? c.extraScalpingPcts : [];
  return {
    roundTripFeeR,
    feeBe,
    feeBeSt,
    feeBeLockRate: feeBe,
    bufferRate: buf,
    t01LockSlipFrac,
    useFeeBeTrail,
    useAdvTrail,
    tieredStMode,
    postT02SpacingFrac,
    postT02MaxExtraTiers,
    postT02BufferRate: postT02Buf,
    maxStepCap,
    minSlDistanceFrac: Number.isFinite(minDist) && minDist > 0 ? minDist : 0,
    minTrailGapFromMarkFrac: Number.isFinite(minGap) && minGap > 0 ? minGap : 0,
    extraScalpingPcts,
  };
}

/**
 * Pessimistic mark price for trail evaluation.
 * Live uses tick-level marks; backtest uses bar OHLC. We pick the **favorable**
 * extreme as the mark candidate (long → bar.high, short → bar.low) so the trail
 * advances the same way it would have if a tick at that extreme had occurred.
 */
function favorableExtreme(bar, isLong) {
  return isLong ? Number(bar.high) : Number(bar.low);
}

/**
 * Adverse extreme used to test whether the (potentially newly tightened) SL
 * was breached inside the same bar.
 */
export function adverseExtreme(bar, isLong) {
  return isLong ? Number(bar.low) : Number(bar.high);
}

/**
 * Advance trailing stop for one bar.
 *
 * Returns the new SL (already merged with the previous one) plus tier metadata.
 * If `proposedSl` equals `pos.sl`, no change occurred and the runner can skip
 * the post-update breach check.
 *
 * @param {object} args
 * @param {{ side:'BUY'|'SELL', entryFill:number, sl:number, trailStep?:number, extremePx?:number, trailTierLabel?:string|null }} args.pos
 * @param {{ open:number, high:number, low:number, close:number }} args.bar
 * @param {object|null|undefined} args.stBar  current Supertrend bar `{ line, trend, ready }`, may be null
 * @param {object} args.opts                  resolveTrailingOpts() output
 * @param {string} args.mode                  'SUPERTREND' | 'FEE_LADDER'
 * @param {number} args.leverage
 * @returns {{ proposedSl:number|null, trailStep:number, tierLabel:string|null, advanced:boolean }}
 */
export function advanceTrailForBar({ pos, bar, stBar, opts, mode, leverage }) {
  const isLong = pos.side === "BUY";
  const entry = Number(pos.entryFill);
  if (!Number.isFinite(entry) || entry <= 0) {
    return { proposedSl: null, trailStep: pos.trailStep || 0, tierLabel: pos.trailTierLabel || null, advanced: false };
  }
  const fav = favorableExtreme(bar, isLong);
  const ext0 = Number.isFinite(Number(pos.extremePx)) ? Number(pos.extremePx) : fav;
  const hwm = isLong ? Math.max(ext0, fav) : Math.min(ext0, fav);
  pos.extremePx = hwm;

  const prevSl = Number(pos.sl);
  const prevStep = Math.max(0, Math.floor(Number(pos.trailStep) || 0));

  if (mode === "FEE_LADDER") {
    return runFeeLadder({ pos, opts, hwm, prevSl, prevStep, isLong, entry, fav });
  }

  if (opts.tieredStMode) {
    return runTieredSupertrend({ pos, opts, hwm, prevSl, prevStep, isLong, entry, fav, bar });
  }

  return runPlainSupertrend({ pos, opts, prevSl, prevStep, isLong, entry, fav, stBar, leverage, bar });
}

function runFeeLadder({ pos, opts, hwm, prevSl, prevStep, isLong, entry, fav }) {
  const adv = advanceTrailingStopState({
    entryPx: entry,
    isLong,
    trailStep: prevStep,
    extremePx: hwm,
    markPx: fav,
    activationBufferRate: opts.bufferRate,
    roundTripFeeRate: opts.roundTripFeeR,
    feeBeMultiplier: undefined,
    extraScalpingPctsOfEntry: opts.extraScalpingPcts,
  });
  const stepNow = Math.max(prevStep, Math.max(0, Math.floor(Number(adv.trailStep) || 0)));
  pos.trailStep = stepNow;
  if (!adv.advanced || adv.proposedSl == null) {
    return { proposedSl: null, trailStep: stepNow, tierLabel: pos.trailTierLabel || null, advanced: false };
  }
  const merged = mergeStopWithTrail({ isLong, currentStopPx: prevSl, trailSlPx: adv.proposedSl });
  if (merged == null || !Number.isFinite(merged) || merged <= 0) {
    return { proposedSl: null, trailStep: stepNow, tierLabel: pos.trailTierLabel || null, advanced: false };
  }
  const finalSl = applyDistanceFilters({
    isLong,
    cur: fav,
    prevSl,
    newSl: merged,
    breakeven: isLong ? entry * (1 + opts.feeBeLockRate) : entry * (1 - opts.feeBeLockRate),
    opts,
  });
  if (!Number.isFinite(finalSl) || finalSl <= 0) {
    return { proposedSl: null, trailStep: stepNow, tierLabel: pos.trailTierLabel || null, advanced: false };
  }
  const tierLabel = adv.tierLabel ?? trailStepToTierLabel(stepNow, "classic");
  return { proposedSl: finalSl, trailStep: stepNow, tierLabel, advanced: finalSl !== prevSl };
}

function runTieredSupertrend({ pos, opts, hwm, prevSl, prevStep, isLong, entry, fav, bar }) {
  const stLevels = []; // tiered_st_fee_entry mode does not use stLevels (see live)
  const cap = opts.maxStepCap != null ? Math.max(opts.maxStepCap, 3) : 3 + opts.postT02MaxExtraTiers;
  const rawPriceStep = computeSupertrendTieredMaxTrailStepFromExtreme({
    hwm,
    entryPx: entry,
    isLong,
    feeBe: opts.feeBeSt,
    bufferRate: opts.bufferRate,
    postT02BufferRate: opts.postT02BufferRate,
    useFeeBeTrail: opts.useFeeBeTrail,
    stLevels,
    roundTripFeeRate: opts.roundTripFeeR,
    postT02SpacingFrac: opts.postT02SpacingFrac,
    maxActivationSteps: cap,
  });
  const priceStep = opts.maxStepCap != null ? Math.min(rawPriceStep, Math.max(opts.maxStepCap, 3)) : rawPriceStep;
  const nextStep = Math.max(prevStep, priceStep);
  if (nextStep < 1) {
    return { proposedSl: null, trailStep: prevStep, tierLabel: pos.trailTierLabel || null, advanced: false };
  }

  let lockPx;
  if (nextStep === 1) {
    lockPx = isLong ? entry * (1 + opts.t01LockSlipFrac) : entry * (1 - opts.t01LockSlipFrac);
  } else if (nextStep === 2) {
    lockPx = isLong ? entry * (1 + opts.feeBeLockRate) : entry * (1 - opts.feeBeLockRate);
  } else {
    lockPx = tieredStLockPxForCompletedTrailStep(nextStep, {
      entryPx: entry,
      isLong,
      feeBeLockRate: opts.feeBeLockRate,
      feeBeSt: opts.feeBeSt,
      roundTripFeeR: opts.roundTripFeeR,
      postT02SpacingFrac: opts.postT02SpacingFrac,
      t01LockSlipFrac: opts.t01LockSlipFrac,
    });
  }
  if (lockPx == null || !Number.isFinite(lockPx) || lockPx <= 0) {
    return { proposedSl: null, trailStep: prevStep, tierLabel: pos.trailTierLabel || null, advanced: false };
  }

  const merged = mergeStopWithTrail({ isLong, currentStopPx: prevSl, trailSlPx: lockPx });
  if (merged == null || !Number.isFinite(merged) || merged <= 0) {
    return { proposedSl: null, trailStep: prevStep, tierLabel: pos.trailTierLabel || null, advanced: false };
  }

  /** Use bar.close as the "mark" for distance filters (best per-bar proxy for current price). */
  const mark = Number(bar.close);
  const breakeven = isLong ? entry * (1 + opts.feeBeLockRate) : entry * (1 - opts.feeBeLockRate);
  const finalSl = applyDistanceFilters({
    isLong,
    cur: mark,
    prevSl,
    newSl: merged,
    breakeven,
    opts,
  });
  if (!Number.isFinite(finalSl) || finalSl <= 0) {
    return { proposedSl: null, trailStep: prevStep, tierLabel: pos.trailTierLabel || null, advanced: false };
  }
  const tierLabel = trailStepToTierLabel(nextStep, "tiered_st_fee_entry");
  return { proposedSl: finalSl, trailStep: nextStep, tierLabel, advanced: finalSl !== prevSl };
}

function runPlainSupertrend({ pos, opts, prevSl, prevStep, isLong, entry, fav, stBar, leverage, bar }) {
  const stLine =
    stBar && typeof stBar.line === "number" && Number.isFinite(stBar.line) ? Number(stBar.line) : NaN;
  const r = computeSupertrendTrailingSlUpdate({
    entryPrice: entry,
    currentPrice: fav,
    supertrend: stLine,
    previousSl: prevSl,
    isLong,
    leverage,
    feeRate: opts.feeBeSt,
    bufferRate: opts.bufferRate,
    maintenanceMarginRate: 0.005,
    minSlDistanceFrac: opts.minSlDistanceFrac,
    minTrailGapFromMarkFrac: opts.minTrailGapFromMarkFrac,
    useFeeBreakeven: opts.useFeeBeTrail,
    useAdvancedTrail: opts.useAdvTrail,
  });
  if (r.status !== "OK" || r.newSl == null || !Number.isFinite(r.newSl) || r.newSl <= 0) {
    return { proposedSl: null, trailStep: prevStep, tierLabel: pos.trailTierLabel || null, advanced: false };
  }
  const merged = mergeStopWithTrail({ isLong, currentStopPx: prevSl, trailSlPx: r.newSl });
  if (merged == null) {
    return { proposedSl: null, trailStep: prevStep, tierLabel: pos.trailTierLabel || null, advanced: false };
  }
  /** Plain ST does not expose a granular tier counter; bump by 1 on each successful tighten. */
  const nextStep = merged === prevSl ? prevStep : prevStep + 1;
  const tierLabel = nextStep > 0 ? trailStepToTierLabel(nextStep, "classic") : null;
  return { proposedSl: merged, trailStep: nextStep, tierLabel, advanced: merged !== prevSl };
}

function applyDistanceFilters({ isLong, cur, prevSl, newSl, breakeven, opts }) {
  let x = applyMinTrailGapFromMark({
    isLong,
    cur,
    prevSl,
    newSl,
    breakeven,
    useFeeBe: opts.useFeeBeTrail,
    gapFrac: opts.minTrailGapFromMarkFrac,
  });
  if (opts.minSlDistanceFrac > 0 && Number.isFinite(cur) && cur > 0) {
    const dist = Math.abs(cur - x) / cur;
    const tightening = isLong ? x > prevSl : x < prevSl;
    if (dist < opts.minSlDistanceFrac && !tightening) x = prevSl;
  }
  return x;
}
