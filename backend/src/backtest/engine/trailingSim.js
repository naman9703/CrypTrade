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
  roundStopPx,
  tieredStLockPxForCompletedTrailStep,
} from "../../lib/trailingStopLoss.js";
import {
  buildDynamicTrailSnapshotFields,
  computeDynamicAdvancedSl,
  computeDynamicTieredMaxTrailStepFromExtreme,
  computeDynamicT01LockFrac,
  computeDynamicTrailBuffer,
  computeInitialRiskFrac,
  computePeakMfeR,
  DYNAMIC_TRAIL_V2_DEFAULTS,
  resolveEffectiveAtrPct,
} from "../../lib/dynamicTrailing.js";
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
  const tickRaw = c.backtestTickSize ?? c.tickSize;
  const tickSize =
    tickRaw != null && Number.isFinite(Number(tickRaw)) && Number(tickRaw) > 0 ? Number(tickRaw) : null;
  const trailSizingMode =
    String(c.trailSizingMode ?? "FIXED_PCT").toUpperCase() === "DYNAMIC" ? "DYNAMIC" : "FIXED_PCT";
  const d = DYNAMIC_TRAIL_V2_DEFAULTS;
  const trailActivationOn =
    c.backtestTrailActivationOn ?? resolveTrailActivationOn(c.backtestTrailMicroTf);
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
    tickSize,
    trailSizingMode,
    trailDynamicBeAtrMult: Number(c.trailDynamicBeAtrMult ?? d.trailDynamicBeAtrMult),
    trailDynamicBeT01LockAtrMult: Number(c.trailDynamicBeT01LockAtrMult ?? d.trailDynamicBeT01LockAtrMult),
    trailDynamicBeRegimeAdjust: c.trailDynamicBeRegimeAdjust ?? d.trailDynamicBeRegimeAdjust,
    trailDynamicBeRegimeLowMult: Number(c.trailDynamicBeRegimeLowMult ?? d.trailDynamicBeRegimeLowMult),
    trailDynamicBeRegimeHighMult: Number(c.trailDynamicBeRegimeHighMult ?? d.trailDynamicBeRegimeHighMult),
    trailDynamicMicroFloorMult: Number(c.trailDynamicMicroFloorMult ?? d.trailDynamicMicroFloorMult),
    trailDynamicBufferMinPct: Number(c.trailDynamicBufferMinPct ?? d.trailDynamicBufferMinPct),
    trailDynamicAdvAtrHwmMult: Number(c.trailDynamicAdvAtrHwmMult ?? d.trailDynamicAdvAtrHwmMult),
    trailDynamicAdvMfeGivebackFrac: Number(c.trailDynamicAdvMfeGivebackFrac ?? d.trailDynamicAdvMfeGivebackFrac),
    trailDynamicAdvMfeMinR: Number(c.trailDynamicAdvMfeMinR ?? d.trailDynamicAdvMfeMinR),
    trailDynamicAdvMergeSupertrend: c.trailDynamicAdvMergeSupertrend ?? d.trailDynamicAdvMergeSupertrend,
    trailDynamicAdvAtrSource:
      String(c.trailDynamicAdvAtrSource ?? d.trailDynamicAdvAtrSource).toUpperCase() === "ROLLING"
        ? "ROLLING"
        : "ENTRY",
    trailDynamicAdvPostT02StepAtrMult: Number(
      c.trailDynamicAdvPostT02StepAtrMult ?? d.trailDynamicAdvPostT02StepAtrMult,
    ),
    trailDynamicSlAtrMult: Number(c.trailDynamicSlAtrMult ?? d.trailDynamicSlAtrMult),
    trailDynamicSlMinPct: Number(c.trailDynamicSlMinPct ?? d.trailDynamicSlMinPct),
    trailDynamicSlMaxPct: Number(c.trailDynamicSlMaxPct ?? d.trailDynamicSlMaxPct),
    atrPct: atrPct != null && Number.isFinite(Number(atrPct)) ? Number(atrPct) : null,
    trailActivationOn,
  };
}

function markFromBar(bar) {
  const mark = bar?.mark != null ? Number(bar.mark) : NaN;
  if (Number.isFinite(mark) && mark > 0) return mark;
  const close = Number(bar?.close);
  return Number.isFinite(close) && close > 0 ? close : NaN;
}

function roundTrailStopPx(px, tickSize) {
  const n = Number(px);
  if (!Number.isFinite(n) || n <= 0) return n;
  const tick = tickSize != null ? Number(tickSize) : null;
  if (tick != null && Number.isFinite(tick) && tick > 0) return roundStopPx(n, tick);
  return n;
}

/**
 * Trailing activation price source inside a micro bar.
 * `wick` — live 1m tick parity (high for long, low for short).
 * `close` — LTF candle close must confirm tier activation (5m/15m mark klines).
 */
export function resolveTrailActivationOn(microTf) {
  return String(microTf ?? "1m").trim().toLowerCase() === "1m" ? "wick" : "close";
}

/**
 * Favorable price for trail tier activation / HWM.
 * Adverse stop breach always uses wick via {@link adverseExtreme}.
 */
export function favorableExtreme(bar, isLong, activationOn = "wick") {
  if (String(activationOn).toLowerCase() === "close") return Number(bar.close);
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
 * @param {number|null|undefined} [args.tickSize]
 * @returns {{ proposedSl:number|null, trailStep:number, tierLabel:string|null, advanced:boolean }}
 */
export function advanceTrailForBar({ pos, bar, stBar, opts, mode, leverage, tickSize = null }) {
  const tick =
    tickSize != null && Number.isFinite(Number(tickSize)) && Number(tickSize) > 0
      ? Number(tickSize)
      : opts?.tickSize ?? null;
  const isLong = pos.side === "BUY";
  const entry = Number(pos.entryFill);
  if (!Number.isFinite(entry) || entry <= 0) {
    return { proposedSl: null, trailStep: pos.trailStep || 0, tierLabel: pos.trailTierLabel || null, advanced: false };
  }
  const activationOn = opts?.trailActivationOn ?? "wick";
  const fav = favorableExtreme(bar, isLong, activationOn);
  const ext0 = Number.isFinite(Number(pos.extremePx)) ? Number(pos.extremePx) : fav;
  const hwm = isLong ? Math.max(ext0, fav) : Math.min(ext0, fav);
  pos.extremePx = hwm;

  const prevSl = Number(pos.sl);
  const prevStep = Math.max(0, Math.floor(Number(pos.trailStep) || 0));

  if (mode === "FEE_LADDER") {
    return runFeeLadder({ pos, opts, hwm, prevSl, prevStep, isLong, entry, fav, bar, tickSize: tick });
  }

  if (opts.tieredStMode) {
    return runTieredSupertrend({ pos, opts, hwm, prevSl, prevStep, isLong, entry, fav, bar, tickSize: tick, stBar });
  }

  return runPlainSupertrend({ pos, opts, prevSl, prevStep, isLong, entry, fav, stBar, leverage, bar, tickSize: tick });
}

function runFeeLadder({ pos, opts, hwm, prevSl, prevStep, isLong, entry, fav, bar, tickSize = null }) {
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
    cur: markFromBar(bar) ?? fav,
    prevSl,
    newSl: merged,
    breakeven: isLong ? entry * (1 + opts.feeBeLockRate) : entry * (1 - opts.feeBeLockRate),
    opts,
  });
  if (!Number.isFinite(finalSl) || finalSl <= 0) {
    return { proposedSl: null, trailStep: stepNow, tierLabel: pos.trailTierLabel || null, advanced: false };
  }
  const rounded = roundTrailStopPx(finalSl, tickSize);
  const tierLabel = adv.tierLabel ?? trailStepToTierLabel(stepNow, "classic");
  return { proposedSl: rounded, trailStep: stepNow, tierLabel, advanced: rounded !== prevSl };
}

function runTieredSupertrend({ pos, opts, hwm, prevSl, prevStep, isLong, entry, fav, bar, tickSize = null, stBar = null }) {
  const stLevels = [];
  const isDynamicTrail = opts.trailSizingMode === "DYNAMIC";
  let buf = opts.bufferRate;
  let t01LockSlip = opts.t01LockSlipFrac;

  if (!pos.trailLadderSnapshotV1) {
    const snapBase = {
      entryPx: entry,
      isLong,
      feeBeLockRate: opts.feeBeLockRate,
      feeBeSt: opts.feeBeSt,
      postT02Buf: opts.postT02BufferRate,
      postT02SpacingFrac: opts.postT02SpacingFrac,
      roundTripFeeR: opts.roundTripFeeR,
    };
    if (isDynamicTrail) {
      const dynFields = buildDynamicTrailSnapshotFields(opts, opts.atrPct, prevSl);
      const dynBuf = computeDynamicTrailBuffer({
        entryAtrPct: dynFields.entryAtrPct,
        dynamicBe: dynFields.dynamicBe,
        fallbackBufferRate: Number(opts.bufferRate ?? 0.0005),
      });
      const dynT01 = computeDynamicT01LockFrac({
        entryAtrPct: dynFields.entryAtrPct,
        t01LockAtrMult: dynFields.dynamicBe.t01LockAtrMult,
        fixedT01LockSlipFrac: opts.t01LockSlipFrac,
      });
      pos.trailLadderSnapshotV1 = { ...snapBase, ...dynFields, buf: dynBuf, t01LockSlipFrac: dynT01 };
    } else {
      pos.trailLadderSnapshotV1 = { ...snapBase, buf, t01LockSlipFrac: t01LockSlip };
    }
  }
  const tierSnap = pos.trailLadderSnapshotV1;
  buf = Number(tierSnap.buf);
  t01LockSlip = Number(tierSnap.t01LockSlipFrac);
  const postT02Spacing = tierSnap.postT02SpacingFrac ?? opts.postT02SpacingFrac;

  const cap = opts.maxStepCap != null ? Math.max(opts.maxStepCap, 3) : 3 + opts.postT02MaxExtraTiers;
  const rawPriceStep = computeSupertrendTieredMaxTrailStepFromExtreme({
    hwm,
    entryPx: entry,
    isLong,
    feeBe: opts.feeBeSt,
    bufferRate: buf,
    postT02BufferRate: opts.postT02BufferRate,
    useFeeBeTrail: opts.useFeeBeTrail,
    stLevels,
    roundTripFeeRate: opts.roundTripFeeR,
    postT02SpacingFrac: postT02Spacing,
    maxActivationSteps: cap,
  });
  const priceStep = opts.maxStepCap != null ? Math.min(rawPriceStep, Math.max(opts.maxStepCap, 3)) : rawPriceStep;
  const nextStep = Math.max(prevStep, priceStep);
  if (nextStep < 1) {
    return { proposedSl: null, trailStep: prevStep, tierLabel: pos.trailTierLabel || null, advanced: false };
  }

  let lockPx;
  if (nextStep === 1) {
    lockPx = isLong ? entry * (1 + t01LockSlip) : entry * (1 - t01LockSlip);
  } else if (nextStep === 2) {
    lockPx = isLong ? entry * (1 + opts.feeBeLockRate) : entry * (1 - opts.feeBeLockRate);
  } else {
    lockPx = tieredStLockPxForCompletedTrailStep(nextStep, {
      entryPx: entry,
      isLong,
      feeBeLockRate: opts.feeBeLockRate,
      feeBeSt: opts.feeBeSt,
      roundTripFeeR: opts.roundTripFeeR,
      postT02SpacingFrac: postT02Spacing,
      t01LockSlipFrac: t01LockSlip,
    });
  }
  if (lockPx == null || !Number.isFinite(lockPx) || lockPx <= 0) {
    return { proposedSl: null, trailStep: prevStep, tierLabel: pos.trailTierLabel || null, advanced: false };
  }

  const merged = mergeStopWithTrail({ isLong, currentStopPx: prevSl, trailSlPx: lockPx });
  if (merged == null || !Number.isFinite(merged) || merged <= 0) {
    return { proposedSl: null, trailStep: prevStep, tierLabel: pos.trailTierLabel || null, advanced: false };
  }

  /** Live distance filters use mark price, not candle close. */
  const mark = markFromBar(bar);
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
  const rounded = roundTrailStopPx(finalSl, tickSize);
  const tierLabel = trailStepToTierLabel(nextStep, "tiered_st_fee_entry");
  return { proposedSl: rounded, trailStep: nextStep, tierLabel, advanced: rounded !== prevSl };
}

function runPlainSupertrend({ pos, opts, prevSl, prevStep, isLong, entry, fav, stBar, leverage, bar, tickSize = null }) {
  const stLine =
    stBar && typeof stBar.line === "number" && Number.isFinite(stBar.line) ? Number(stBar.line) : NaN;
  const breakeven = isLong ? entry * (1 + opts.feeBeLockRate) : entry * (1 - opts.feeBeLockRate);

  if (opts.trailSizingMode === "DYNAMIC" && opts.useAdvTrail) {
    const hwm = isLong ? Math.max(Number(pos.extremePx) || fav, fav) : Math.min(Number(pos.extremePx) || fav, fav);
    pos.extremePx = hwm;
    const atrPct = opts.atrPct;
    const initialRiskFrac = computeInitialRiskFrac({ entryPx: entry, initialSlPx: pos.initialSl ?? prevSl, isLong });
    const peakMfeR = Math.max(
      Number(pos.trailPeakMfeR) || 0,
      computePeakMfeR({ isLong, entryPx: entry, hwm, initialRiskFrac }),
    );
    pos.trailPeakMfeR = peakMfeR;
    const dynSl = computeDynamicAdvancedSl({
      isLong,
      hwm,
      entryPx: entry,
      atrPct,
      stLine,
      prevSl,
      feeBeFloor: opts.useFeeBeTrail ? breakeven : entry,
      initialRiskFrac,
      peakMfeR,
      dynamicAdv: {
        atrHwmMult: opts.trailDynamicAdvAtrHwmMult,
        mfeGivebackFrac: opts.trailDynamicAdvMfeGivebackFrac,
        mfeMinR: opts.trailDynamicAdvMfeMinR,
        mergeSt: opts.trailDynamicAdvMergeSupertrend,
      },
    });
    if (dynSl == null || !Number.isFinite(dynSl) || dynSl <= 0) {
      return { proposedSl: null, trailStep: prevStep, tierLabel: pos.trailTierLabel || null, advanced: false };
    }
    const merged = mergeStopWithTrail({ isLong, currentStopPx: prevSl, trailSlPx: dynSl });
    if (merged == null) {
      return { proposedSl: null, trailStep: prevStep, tierLabel: pos.trailTierLabel || null, advanced: false };
    }
    const minStepMult = Math.max(0, Number(opts.trailDynamicAdvPostT02StepAtrMult ?? 0));
    const minStepAbs =
      minStepMult > 0 && Number.isFinite(Number(opts.atrPct)) && Number(opts.atrPct) > 0
        ? entry * Number(opts.atrPct) * minStepMult
        : 0;
    if (
      minStepAbs > 0 &&
      Number.isFinite(prevSl) &&
      prevSl > 0 &&
      (isLong ? merged - prevSl : prevSl - merged) > 0 &&
      (isLong ? merged - prevSl : prevSl - merged) < minStepAbs
    ) {
      return { proposedSl: null, trailStep: prevStep, tierLabel: pos.trailTierLabel || null, advanced: false };
    }
    const mark = markFromBar(bar);
    const finalSl = applyDistanceFilters({
      isLong,
      cur: mark,
      prevSl,
      newSl: merged,
      breakeven: opts.useFeeBeTrail ? breakeven : entry,
      opts,
    });
    if (!Number.isFinite(finalSl) || finalSl <= 0) {
      return { proposedSl: null, trailStep: prevStep, tierLabel: pos.trailTierLabel || null, advanced: false };
    }
    const rounded = roundTrailStopPx(finalSl, tickSize);
    const nextStep = rounded === prevSl ? prevStep : prevStep + 1;
    const tierLabel = nextStep > 0 ? trailStepToTierLabel(nextStep, "classic") : null;
    return { proposedSl: rounded, trailStep: nextStep, tierLabel, advanced: rounded !== prevSl };
  }

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
  const rounded = roundTrailStopPx(merged, tickSize);
  /** Plain ST does not expose a granular tier counter; bump by 1 on each successful tighten. */
  const nextStep = rounded === prevSl ? prevStep : prevStep + 1;
  const tierLabel = nextStep > 0 ? trailStepToTierLabel(nextStep, "classic") : null;
  return { proposedSl: rounded, trailStep: nextStep, tierLabel, advanced: rounded !== prevSl };
}

/**
 * Classify a stop fill after trailing may have run.
 * "trail" only when the exit stop was tightened past entry-time SL *and* sits on
 * the profit-protective side of entry (fee-BE or better). Loss-side tier bumps
 * (T01 on a still-losing long) remain "sl" so the UI does not imply a trail win.
 *
 * @param {{ side?: string, entryFill?: number, initialSl?: number, sl?: number, trailStep?: number, beLocked?: boolean }} pos
 * @returns {"be"|"trail"|"sl"}
 */
export function classifyStopExitReason(pos = {}) {
  if (pos.beLocked) return "be";
  const step = Math.max(0, Math.floor(Number(pos.trailStep) || 0));
  if (step <= 0) return "sl";

  const initial = Number(pos.initialSl);
  const current = Number(pos.sl);
  const entry = Number(pos.entryFill);
  const isLong = String(pos.side ?? "").toUpperCase() === "BUY";

  if (!Number.isFinite(initial) || initial <= 0 || !Number.isFinite(current) || current <= 0) {
    return "trail";
  }

  const tightened = isLong ? current > initial : current < initial;
  if (!tightened) return "sl";

  if (Number.isFinite(entry) && entry > 0) {
    const protective = isLong ? current >= entry : current <= entry;
    if (!protective) return "sl";
  }

  return "trail";
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
