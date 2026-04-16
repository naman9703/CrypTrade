import { roundTo } from "./math.js";
import { computeSupertrendTrailingSlUpdate, feeRateBreakevenPadded, trailStepToTierLabel } from "./supertrendTrailingSl.js";

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

/**
 * T0 SL price: entry + round-trip fee (optionally padded by feeBeMultiplier).
 * Formula: entry × (1 + roundTripFeeRate)  [LONG]
 *          entry × (1 - roundTripFeeRate)  [SHORT]
 * @param {number} roundTripFeeRate  openFeeRate + closeFeeRate (already the full round-trip)
 */
export function feeCoverageLockPx({ entryPx, isLong, roundTripFeeRate }) {
  const E = Number(entryPx);
  const r = clampFeeRate(roundTripFeeRate);
  if (!Number.isFinite(E) || E <= 0) return null;
  return isLong ? E * (1 + r) : E * (1 - r);
}

/**
 * T1 SL price: entry + 2× round-trip fee (a second round-trip profit notch above T0).
 * Formula: entry × (1 + 2 × roundTripFeeRate)  [LONG]
 *          entry × (1 - 2 × roundTripFeeRate)  [SHORT]
 * @param {number} roundTripFeeRate  openFeeRate + closeFeeRate
 */
export function firstScalpingFeeEquivLockPx({ entryPx, isLong, roundTripFeeRate }) {
  const E = Number(entryPx);
  const r = clampFeeRate(roundTripFeeRate);
  if (!Number.isFinite(E) || E <= 0) return null;
  return isLong ? E * (1 + 2 * r) : E * (1 - 2 * r);
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
 * @param {number}  [openFeeRate]     Taker fee for opening (fraction). If provided with closeFeeRate, replaces legacy feeRate.
 * @param {number}  [closeFeeRate]    Taker fee for SL exit (fraction).
 * @param {number}  [roundTripFeeRate] Pre-computed round-trip (openFeeRate+closeFeeRate). Overrides openFeeRate+closeFeeRate.
 * @param {number}  [feeBeMultiplier]  Safety padding ×N applied to round-trip for T0 SL (default 1.0 = exact).
 * @returns {{ kind: string; lockPx: number; tierLabel: string; pct?: number; feeEquivPct?: number }[]} canonical T0 → T1 → T2+ (not sorted by price — sorting scrambled tier indices vs fee-buffer activation)
 */
export function buildTrailLockPrices({
  entryPx,
  isLong,
  feeRate,
  openFeeRate,
  closeFeeRate,
  roundTripFeeRate: roundTripFeeRateParam,
  extraScalpingPctsOfEntry = [],
  feeBeMultiplier,
} = {}) {
  const E = Number(entryPx);
  if (!Number.isFinite(E) || E <= 0) return [];

  /**
   * Round-trip fee rate = openFeeRate + closeFeeRate.
   * Priority: explicit roundTripFeeRate → openFeeRate+closeFeeRate → 2×feeRate (legacy).
   * Formula: T0 SL = entry × (1 + roundTripRT × feeBeMultiplier)
   *          T1 SL = entry × (1 + 2 × roundTripRT)
   */
  let roundTripRT;
  if (roundTripFeeRateParam != null && Number.isFinite(Number(roundTripFeeRateParam))) {
    roundTripRT = clampFeeRate(Number(roundTripFeeRateParam));
  } else if (openFeeRate != null && closeFeeRate != null) {
    roundTripRT = clampFeeRate(Number(openFeeRate)) + clampFeeRate(Number(closeFeeRate));
  } else {
    // Backward compat: single feeRate assumed one-way; ×2 for round-trip
    roundTripRT = 2 * clampFeeRate(feeRate);
  }

  const extras = (Array.isArray(extraScalpingPctsOfEntry) ? extraScalpingPctsOfEntry : [])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0);

  const out = [];
  /** T0: round-trip fee × safety multiplier → "padded breakeven" lock price */
  const paddedRT = feeRateBreakevenPadded(roundTripRT, feeBeMultiplier);
  const feePx = feeCoverageLockPx({ entryPx: E, isLong, roundTripFeeRate: paddedRT });
  if (feePx != null) out.push({ kind: "fee_breakeven", lockPx: feePx, tierLabel: "T0" });

  /** T1: 2× round-trip from entry (no extra padding — already beyond breakeven) */
  const fsPx = firstScalpingFeeEquivLockPx({ entryPx: E, isLong, roundTripFeeRate: roundTripRT });
  if (fsPx != null) {
    const feeEquivPct = roundTripRT * 100;
    out.push({ kind: "fee_first_scalp", lockPx: fsPx, tierLabel: "T1", feeEquivPct });
  }

  /** T2, T3, T4, … = user %-of-entry scalp locks (no artificial cap) */
  for (let i = 0; i < extras.length; i++) {
    const pct = extras[i];
    const px = pctOfEntryLockPx({ entryPx: E, isLong, pctOfEntry: pct });
    if (px != null) out.push({ kind: "user_scalp", lockPx: px, tierLabel: `T${2 + i}`, pct });
  }

  const eps = E * 1e-10;
  const dedup = [];
  for (const row of out) {
    const last = dedup[dedup.length - 1];
    if (last && Math.abs(last.lockPx - row.lockPx) <= eps) continue;
    dedup.push(row);
  }
  return dedup; // no artificial tier cap — unlimited advancement
}

/**
 * Tiered SUPERTREND: activation threshold for the next SL advance at current `trailStep`.
 * Step 0 uses fee + buffer (not `stLevels[0].lockPx`), because %-of-entry locks can sit below padded fee locks
 * and must not drive the first gate or activation logs.
 */
export function resolveSupertrendTieredActivationGate({
  stepNow,
  isLong,
  entryPx,
  feeBe,
  bufferRate,
  useFeeBeTrail,
  stLevels,
}) {
  const E = Number(entryPx);
  const buf = Number(bufferRate);
  const fb = Number(feeBe);
  const defaultActivationPx = isLong
    ? E * (1 + (useFeeBeTrail ? fb : 0) + buf)
    : E * (1 - (useFeeBeTrail ? fb : 0) - buf);
  const levels = Array.isArray(stLevels) ? stLevels : [];
  const nLv = levels.length;
  if (!Number.isFinite(E) || E <= 0 || !nLv) {
    return { activationPx: defaultActivationPx, activationTierLabel: null };
  }
  if (stepNow <= 0) {
    return { activationPx: defaultActivationPx, activationTierLabel: "T0" };
  }
  if (stepNow < nLv) {
    const L = levels[stepNow];
    const lockPx = Number(L?.lockPx);
    const good = Number.isFinite(lockPx) && lockPx > 0;
    return {
      activationPx: good ? lockPx : defaultActivationPx,
      activationTierLabel: L?.tierLabel != null ? String(L.tierLabel) : `T${stepNow}`,
    };
  }
  const lastDef = levels[nLv - 1];
  const prevDef = levels[nLv - 2];
  const interval =
    nLv >= 2 && prevDef != null && Number.isFinite(Number(prevDef.lockPx))
      ? Math.abs(Number(lastDef.lockPx) - Number(prevDef.lockPx))
      : Math.max(Math.abs(Number(lastDef.lockPx)) * 0.001, Math.abs(Number(lastDef.lockPx) - E));
  const off = stepNow - (nLv - 1);
  const activationPx = isLong
    ? Number(lastDef.lockPx) + off * interval
    : Number(lastDef.lockPx) - off * interval;
  return { activationPx, activationTierLabel: `T${stepNow}` };
}

/** Max defined trail steps: breakeven (T0) + first fee-scalp (T1) + all user % locks. Continuation beyond is unlimited. */
export function maxTrailStepsForConfig(extraScalpingPctsOfEntry) {
  const n = (Array.isArray(extraScalpingPctsOfEntry) ? extraScalpingPctsOfEntry : [])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0).length;
  return 2 + n; // T0 + T1 + user extras; continuation tiers beyond this are unlimited
}

/**
 * Advance trail state from a new mark / extreme.
 * @returns {{ trailStep: number, extremePx: number, proposedSl: number|null, advanced: boolean, tierLabel: string|null }}
 */
export function advanceTrailingStopState({
  entryPx,
  isLong,
  trailStep,
  extremePx,
  markPx,
  feeRate,
  openFeeRate,
  closeFeeRate,
  roundTripFeeRate,
  feeBeMultiplier,
  extraScalpingPctsOfEntry,
}) {
  const E = Number(entryPx);
  const mark = Number(markPx);
  if (!Number.isFinite(E) || E <= 0 || !Number.isFinite(mark)) {
    return { trailStep: 0, extremePx: Number(extremePx) || mark, proposedSl: null, advanced: false, tierLabel: null };
  }
  const ext0 = Number.isFinite(Number(extremePx)) ? Number(extremePx) : mark;
  const hwm = isLong ? Math.max(ext0, mark) : Math.min(ext0, mark);

  const levels = buildTrailLockPrices({
    entryPx: E,
    isLong,
    feeRate,
    openFeeRate,
    closeFeeRate,
    roundTripFeeRate,
    feeBeMultiplier,
    extraScalpingPctsOfEntry,
  });
  const n = levels.length;
  if (!n) return { trailStep: Number(trailStep) || 0, extremePx: hwm, proposedSl: null, advanced: false, tierLabel: null };

  // Do not clamp step to n — the continuation logic needs the real step count.
  let step = Math.max(0, Math.floor(Number(trailStep) || 0));
  let proposedSl = null;
  let advanced = false;
  let tierLabel = null;

  // Phase 1: advance through explicitly defined tiers
  for (let k = step; k < n; k++) {
    const L = levels[k];
    const crossed = isLong ? hwm >= L.lockPx : hwm <= L.lockPx;
    if (!crossed) break;
    step = k + 1;
    proposedSl = L.lockPx;
    tierLabel = L.tierLabel ?? `T${k}`;
    advanced = true;
  }

  // Phase 2: unlimited continuation beyond defined tiers using the last inter-tier interval.
  // Each subsequent tier is exactly one interval above/below the previous.
  if (step >= n) {
    const lastDef = levels[n - 1];
    const interval =
      n >= 2
        ? Math.abs(levels[n - 1].lockPx - levels[n - 2].lockPx)
        : Math.max(lastDef.lockPx * 0.001, Math.abs(lastDef.lockPx - E));
    if (interval > 0) {
      while (true) {
        const contStepsFromLast = step - (n - 1); // 1 for first continuation, 2 for second, …
        const contLockPx = isLong
          ? lastDef.lockPx + contStepsFromLast * interval
          : lastDef.lockPx - contStepsFromLast * interval;
        if (contLockPx <= 0) break;
        const crossed = isLong ? hwm >= contLockPx : hwm <= contLockPx;
        if (!crossed) break;
        step++;
        proposedSl = contLockPx;
        tierLabel = `T${step - 1}`;
        advanced = true;
      }
    }
  }

  return { trailStep: step, extremePx: hwm, proposedSl, advanced, tierLabel };
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
 *
 * **Mode `SUPERTREND` (default):** uses `computeSupertrendTrailingSlUpdate` + `supertrendPx` + activation / liquidation geometry.
 *
 * **Mode `FEE_LADDER`:** discrete locks from `buildTrailLockPrices` (round-trip fee BE, second fee notch, optional %-of-entry);
 * advances when favorable excursion vs `extremePx` crosses each lock (`advanceTrailingStopState`).
 *
 * @param {{
 *   enabled: boolean;
 *   feeRate: number;
 *   openFeeRate?: number;
 *   closeFeeRate?: number;
 *   feeBeMultiplier?: number;
 *   mode?: "SUPERTREND" | "FEE_LADDER";
 *   supertrendPx?: number | null;
 *   bufferRate?: number;
 *   maintenanceMarginRate?: number;
 *   minSlDistanceFrac?: number;
 *   extraScalpingPcts?: number[];
 *   maxTrailSteps?: number;
 *   supertrendUseFeeBreakeven?: boolean;
 *   supertrendUseAdvancedTrail?: boolean;
 * }} [opts.trailingOpts]
 * @param {(p: { level: string; msg: string; category?: string; reason?: string; symbol?: string; detail?: object }) => void} [opts.notifyActivity]
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
  const notifyActivity = typeof opts.notifyActivity === "function" ? opts.notifyActivity : null;

  /** Throttle diagnostic activity per symbol + reason (ms). */
  function trailDiagEmit(tr, reason, minMs) {
    if (!notifyActivity || !tr) return false;
    const now = Date.now();
    const t = tr._trailDiagTs || (tr._trailDiagTs = {});
    const last = t[reason] || 0;
    if (now - last < minMs) return false;
    t[reason] = now;
    return true;
  }

  if (!sym || !Number.isFinite(markPx) || markPx <= 0) return false;
  if (!trailingOpts?.enabled || !trailingBySymbol) return false;

  const tr = trailingBySymbol[sym];
  if (!tr || !tr.entryPrice) return false;

  const isLong = Boolean(tr.isLong);
  const b = localBrackets[sym];
  const tgt = placedBracketTargets?.[sym];
  const prevRaw = b ? b.stopLoss : tgt?.stopLoss;
  const prevSl = Number(prevRaw);
  if (!Number.isFinite(prevSl) || prevSl <= 0) return false;

  const lev = Number(tr.leverage);
  /** Round-trip fee rate = openFeeRate + closeFeeRate (true breakeven cost). Falls back to 2× legacy feeRate. */
  const openR = trailingOpts.openFeeRate != null ? clampFeeRate(Number(trailingOpts.openFeeRate)) : null;
  const closeR = trailingOpts.closeFeeRate != null ? clampFeeRate(Number(trailingOpts.closeFeeRate)) : null;
  const roundTripFeeR = openR != null && closeR != null ? openR + closeR : 2 * clampFeeRate(trailingOpts.feeRate);
  const feeR = closeR ?? clampFeeRate(trailingOpts.feeRate);
  const feeBeMultiplier = trailingOpts.feeBeMultiplier != null ? Number(trailingOpts.feeBeMultiplier) : undefined;
  /** Padded round-trip used for T0 SL and activation price. */
  const feeBe = feeRateBreakevenPadded(roundTripFeeR, feeBeMultiplier);
  const buf = Number.isFinite(Number(trailingOpts.bufferRate)) ? Number(trailingOpts.bufferRate) : 0.0005;
  const mm = Number.isFinite(Number(trailingOpts.maintenanceMarginRate))
    ? Number(trailingOpts.maintenanceMarginRate)
    : 0.005;
  const minDist =
    trailingOpts.minSlDistanceFrac != null && Number.isFinite(Number(trailingOpts.minSlDistanceFrac))
      ? Number(trailingOpts.minSlDistanceFrac)
      : 0.002;

  const mode = String(trailingOpts.mode || "SUPERTREND").toUpperCase() === "FEE_LADDER" ? "FEE_LADDER" : "SUPERTREND";
  // Persist last applied mode so exchange-native closes can be labeled correctly in history.
  tr.trailingMode = mode;

  let merged = null;
  let trailStatus = "";
  /** True only in SUPERTREND branch after mark is past activation (`computeSupertrendTrailingSlUpdate` returned OK). */
  let stInTrailZone = false;
  let supertrendPxForEvt = null;
  let proposedTrailSl = null;
  let minDistUsed = minDist;
  let trailKind = "supertrend_trailing_sl";
  /** Tier label for the SL point reached: T0 = fee-BE, T1/T2/... = subsequent advances. */
  let advanceTierLabel = null;
  let activationPriceForEvt = null;
  let breakevenForEvt = null;

  /** Exchange-verified tier floor — `trailStep` must never sit below this once set. */
  const getConfirmedStep = () => Math.max(0, Math.floor(Number(tr.confirmedTrailStep) || 0));
  function enforceMonotonicTrailStep() {
    const c = getConfirmedStep();
    const cur = Math.max(0, Math.floor(Number(tr.trailStep) || 0));
    if (cur < c) {
      tr.trailStep = c;
      tr.trailTierLabel = trailStepToTierLabel(tr.trailStep);
    }
  }
  enforceMonotonicTrailStep();

  if (mode === "FEE_LADDER") {
    const adv = advanceTrailingStopState({
      entryPx: tr.entryPrice,
      isLong,
      trailStep: tr.trailStep,
      extremePx: tr.extremePx,
      markPx,
      feeRate: feeR,
      roundTripFeeRate: roundTripFeeR,
      feeBeMultiplier,
      extraScalpingPctsOfEntry: trailingOpts.extraScalpingPcts ?? [],
    });
    tr.trailStep = Math.max(Math.max(0, Math.floor(Number(adv.trailStep) || 0)), getConfirmedStep());
    tr.extremePx = adv.extremePx;
    if (!adv.advanced || adv.proposedSl == null) return false;
    proposedTrailSl = adv.proposedSl;
    advanceTierLabel = adv.tierLabel;
    tr.trailTierLabel = advanceTierLabel;
    activationPriceForEvt = adv.proposedSl;
    breakevenForEvt = isLong ? tr.entryPrice * (1 + feeBe) : tr.entryPrice * (1 - feeBe);
    merged = mergeStopWithTrail({ isLong, currentStopPx: prevSl, trailSlPx: adv.proposedSl });
    trailStatus = "OK";
    trailKind = "fee_ladder_trailing_sl";
  } else {
    const useAdvTrail = trailingOpts.supertrendUseAdvancedTrail !== false;
    const useFeeBeTrail = trailingOpts.supertrendUseFeeBreakeven !== false;
    const tieredStMode = useFeeBeTrail && useAdvTrail;
    const stPx = trailingOpts.supertrendPx != null ? Number(trailingOpts.supertrendPx) : NaN;
    const hasValidStPx = Number.isFinite(stPx) && stPx > 0;
    /**
     * Degrade gracefully when advanced trail is ON but no ST price is available:
     * if fee-breakeven trail is enabled, still ratchet SL to breakeven once activation is
     * crossed. Previously `return false` here caused trailing to be silently skipped even
     * after the mark had already crossed the activation point.
     */
    if (useAdvTrail && !hasValidStPx && !useFeeBeTrail) return false;
    /** Only emit the ST price in the advance event when it is actually used. */
    const effectiveUseAdv = useAdvTrail && hasValidStPx;
    supertrendPxForEvt = effectiveUseAdv ? stPx : null;

    const stLevels = tieredStMode
      ? buildTrailLockPrices({
          entryPx: tr.entryPrice,
          isLong,
          feeRate: feeR,
          roundTripFeeRate: roundTripFeeR,
          feeBeMultiplier,
          extraScalpingPctsOfEntry: trailingOpts.extraScalpingPcts ?? [],
        })
      : [];

    const defaultActivationPx = isLong
      ? tr.entryPrice * (1 + (useFeeBeTrail ? feeBe : 0) + buf)
      : tr.entryPrice * (1 - (useFeeBeTrail ? feeBe : 0) - buf);

    const bumpTrailMetaSupertrendInner = () => {
      const c = getConfirmedStep();
      const cur = Math.max(0, Math.floor(Number(tr.trailStep) || 0));
      tr.trailStep = Math.max(cur + 1, c + 1);
      tr.extremePx = isLong
        ? Math.max(Number(tr.extremePx) || markPx, markPx)
        : Math.min(Number(tr.extremePx) || markPx, markPx);
      tr.trailTierLabel = trailStepToTierLabel(tr.trailStep);
      advanceTierLabel = tr.trailTierLabel;
    };

    const stFeeOnEvt = useFeeBeTrail;
    const evtBreakevenBase = stFeeOnEvt
      ? isLong
        ? tr.entryPrice * (1 + feeBe)
        : tr.entryPrice * (1 - feeBe)
      : tr.entryPrice;
    const evtActivationFallback = stFeeOnEvt
      ? isLong
        ? tr.entryPrice * (1 + feeBe + buf)
        : tr.entryPrice * (1 - feeBe - buf)
      : isLong
        ? tr.entryPrice * (1 + buf)
        : tr.entryPrice * (1 - buf);

    const maxCatchUpIters = 32;
    let advancedAny = false;

    for (let catchUp = 0; catchUp < maxCatchUpIters; catchUp++) {
      enforceMonotonicTrailStep();
      const bCur = localBrackets[sym];
      const tgtCur = placedBracketTargets?.[sym];
      const prevRawCur = bCur ? bCur.stopLoss : tgtCur?.stopLoss;
      const prevSlCur = Number(prevRawCur);
      if (!Number.isFinite(prevSlCur) || prevSlCur <= 0) break;

      let minDistLoop = minDist;
      if (tickSize != null && Number.isFinite(tickSize) && tickSize > 0 && markPx > 0) {
        const tickFrac = (2 * tickSize) / markPx;
        if (Number.isFinite(tickFrac) && tickFrac > 0) minDistLoop = Math.min(minDistLoop, tickFrac);
      }

      const stepNow = Math.max(0, Math.floor(Number(tr.trailStep) || 0));
      const ext0 = Number.isFinite(Number(tr.extremePx)) ? Number(tr.extremePx) : markPx;
      const hwm = isLong ? Math.max(ext0, markPx) : Math.min(ext0, markPx);
      tr.extremePx = hwm;

      const tieredGate =
        tieredStMode && stLevels.length > 0
          ? resolveSupertrendTieredActivationGate({
              stepNow,
              isLong,
              entryPx: tr.entryPrice,
              feeBe,
              bufferRate: buf,
              useFeeBeTrail,
              stLevels,
            })
          : { activationPx: defaultActivationPx, activationTierLabel: null };
      const activationPx = tieredGate.activationPx;
      const activationTierLabelGate = tieredGate.activationTierLabel;
      activationPriceForEvt = activationPx;
      breakevenForEvt = evtBreakevenBase;
      const crossedTierActivation = isLong ? hwm >= activationPx : hwm <= activationPx;
      if (!crossedTierActivation) break;

      const pxForCompute = isLong ? Math.max(markPx, activationPx) : Math.min(markPx, activationPx);

      const r = computeSupertrendTrailingSlUpdate({
        entryPrice: tr.entryPrice,
        currentPrice: pxForCompute,
        supertrend: effectiveUseAdv ? stPx : NaN,
        previousSl: prevSlCur,
        isLong,
        leverage: lev,
        feeRate: feeBe,
        bufferRate: buf,
        maintenanceMarginRate: mm,
        minSlDistanceFrac: minDistLoop,
        useFeeBreakeven: useFeeBeTrail,
        useAdvancedTrail: effectiveUseAdv,
        activationPrice: activationPx,
        breakevenPrice: breakevenForEvt,
      });

      if (r.status === "REJECT_TRADE" || r.status === "INVALID") {
        if (!advancedAny && trailDiagEmit(tr, `bad_${r.status}`, 120_000)) {
          notifyActivity({
            category: "risk",
            level: r.status === "REJECT_TRADE" ? "warn" : "error",
            msg: `Trailing ${r.status === "REJECT_TRADE" ? "blocked" : "invalid"} · ${sym} · ${r.status} (mark ${markPx}, entry ${tr.entryPrice})`,
            reason: "trailing_sl_diagnostic",
            symbol: sym,
            detail: { outcome: "failure", phase: "geometry", trailStatus: r.status, markPx, entryPrice: tr.entryPrice, isLong },
          });
        }
        break;
      }
      if (r.status === "NO_SUPERTREND") {
        if (!advancedAny && useAdvTrail && trailDiagEmit(tr, "no_st", 90_000)) {
          notifyActivity({
            category: "risk",
            level: "warn",
            msg: `Trailing activation unavailable · ${sym} · no Supertrend price for this mark (cannot align SL to ST)`,
            reason: "trailing_sl_diagnostic",
            symbol: sym,
            detail: { outcome: "failure", phase: "activation", trailStatus: r.status, markPx },
          });
        }
        break;
      }
      if (r.status === "NO_TRAIL") break;

      stInTrailZone = r.status === "OK";

      const activationTierLabel =
        activationTierLabelGate != null ? String(activationTierLabelGate) : null;
      const activationKey =
        tieredStMode && stLevels.length > 0 && stepNow <= 0
          ? `fee_gate:${activationPx.toFixed(8)}`
          : activationTierLabel ?? "ST";
      if (r.status === "OK" && tr._trailingActivationLoggedTier !== activationKey) {
        tr._trailingActivationLoggedTier = activationKey;
        notifyActivity?.({
          category: "risk",
          level: "info",
          msg: activationTierLabel
            ? `Trailing activation ${activationTierLabel} · ${sym} · mark passed activation (${activationPx.toFixed(6)}); futures trailing engaged`
            : `Trailing activation · ${sym} · mark passed activation (${activationPx.toFixed(6)}); futures trailing engaged`,
          reason: "trailing_activation_engaged",
          symbol: sym,
          detail: {
            outcome: "success",
            phase: "activation",
            markPx,
            activationPrice: activationPx,
            breakeven: breakevenForEvt,
            tierLabel: activationTierLabel,
            entryPrice: tr.entryPrice,
            isLong,
            supertrendPx: supertrendPxForEvt,
          },
        });
      }

      trailStatus = r.status;
      proposedTrailSl = r.newSl;
      const mergedLoop = mergeStopWithTrail({ isLong, currentStopPx: prevSlCur, trailSlPx: r.newSl });

      const finalSlPreLoop =
        mergedLoop != null && Number.isFinite(Number(mergedLoop)) && Number(mergedLoop) > 0
          ? tickSize != null && Number.isFinite(tickSize) && tickSize > 0
            ? roundStopPx(mergedLoop, tickSize)
            : roundTo(mergedLoop, 8)
          : null;
      const prevEffLoop =
        tickSize != null && Number.isFinite(tickSize) && tickSize > 0
          ? roundStopPx(prevSlCur, tickSize)
          : roundTo(prevSlCur, 8);

      if (mergedLoop == null || finalSlPreLoop == null) break;

      if (finalSlPreLoop === prevEffLoop) {
        if (prevSlCur !== prevEffLoop) {
          if (bCur) bCur.stopLoss = prevEffLoop;
          if (placedBracketTargets && placedBracketTargets[sym]) {
            placedBracketTargets[sym] = { ...placedBracketTargets[sym], stopLoss: prevEffLoop };
          }
        }
        break;
      }

      const finalSlLoop = finalSlPreLoop;
      if (!Number.isFinite(finalSlLoop) || finalSlLoop <= 0 || finalSlLoop === prevEffLoop) break;

      const evtActivationLine = activationPriceForEvt != null ? activationPriceForEvt : evtActivationFallback;
      bumpTrailMetaSupertrendInner();
      const evtCoreLoop = {
        symbol: sym,
        venue: "FUTURES",
        prevStopLoss: prevSlCur,
        newStopLoss: finalSlLoop,
        maxTrailSteps: trailingOpts.maxTrailSteps ?? 1,
        isLong,
        entryPrice: tr.entryPrice,
        supertrendPx: supertrendPxForEvt,
        trailStatus: r.status,
        breakeven: breakevenForEvt,
        activationPrice: evtActivationLine,
        leverage: lev,
        bufferRate: buf,
        maintenanceMarginRate: mm,
        kind: "supertrend_trailing_sl",
        trailingMode: mode,
        tierLabel: advanceTierLabel,
      };

      if (bCur) {
        bCur.stopLoss = finalSlLoop;
        if (placedBracketTargets && placedBracketTargets[sym]) {
          placedBracketTargets[sym] = { ...placedBracketTargets[sym], stopLoss: finalSlLoop };
        }
        onTrailingSlAdvance?.({
          ...evtCoreLoop,
          trailStep: tr.trailStep,
          source: "binance_usdm_local_bracket",
        });
      } else if (tgtCur) {
        placedBracketTargets[sym] = { ...tgtCur, stopLoss: finalSlLoop };
        onTrailingSlAdvance?.({
          ...evtCoreLoop,
          trailStep: tr.trailStep,
          source: "binance_usdm_bracket_targets",
        });
      } else {
        break;
      }
      advancedAny = true;
    }

    return advancedAny;
  }

  const finalSlPre =
    merged != null && Number.isFinite(Number(merged)) && Number(merged) > 0
      ? tickSize != null && Number.isFinite(tickSize) && tickSize > 0
        ? roundStopPx(merged, tickSize)
        : roundTo(merged, 8)
      : null;

  // Compare using the same rounding grid we apply to the new stop. Otherwise we can get stuck when
  // `merged` equals the previous raw stop, but tick rounding would advance (e.g. 0.238999 → 0.2390).
  const prevEff =
    tickSize != null && Number.isFinite(tickSize) && tickSize > 0
      ? roundStopPx(prevSl, tickSize)
      : roundTo(prevSl, 8);

  if (merged == null || finalSlPre == null) {
    return false;
  }

  // Tick-alignment: exchange triggers are on tick grid; sometimes the stored SL is off-grid (e.g. from open-orders parsing),
  // and our proposed SL rounds onto the same tick. In that case, sync the stored target to the tick without counting it
  // as a real trail advancement.
  if (finalSlPre === prevEff) {
    if (prevSl !== prevEff) {
      if (b) b.stopLoss = prevEff;
      if (placedBracketTargets && placedBracketTargets[sym]) {
        placedBracketTargets[sym] = { ...placedBracketTargets[sym], stopLoss: prevEff };
      }
    }
    const inTrailContext = stInTrailZone || mode === "FEE_LADDER";
    /**
     * After at least one successful trail tighten (`trailStep >= 1`), the engine still evaluates every mark;
     * geometry often matches exchange SL (tick / min-distance) → noisy repeat noops. Only log noops while
     * we have not yet advanced (`trailStep === 0`) — first tighten is the hard case to diagnose.
     */
    const trailStepN = Number(tr.trailStep) || 0;
    const allowNoopDiag = trailStepN < 1;
    if (inTrailContext && tr && allowNoopDiag && trailDiagEmit(tr, "noop_same_sl", 45_000)) {
      notifyActivity?.({
        category: "risk",
        level: "warn",
        msg: `Trailing no SL move · ${sym} · mark in trail zone but stop unchanged vs exchange (tick/min-distance or merge)`,
        reason: "trailing_sl_noop",
        symbol: sym,
        detail: {
          outcome: "failure",
          phase: "tighten",
          markPx,
          prevStopLoss: prevSl,
          prevStopLossRounded: prevEff,
          proposedTrailSl,
          proposedMerged: merged,
          proposedRounded: finalSlPre,
          tickSize: tickSize != null && Number.isFinite(tickSize) ? tickSize : null,
          minSlDistanceFrac: minDist,
          minSlDistanceFracUsed: minDistUsed,
          trailStatus,
          trailingMode: mode,
          kind: trailKind,
        },
      });
    }
    return false;
  }

  const finalSl = finalSlPre;
  if (!Number.isFinite(finalSl) || finalSl <= 0 || finalSl === prevEff) return false;

  const stFeeOn = mode !== "SUPERTREND" || trailingOpts.supertrendUseFeeBreakeven !== false;
  const breakeven = stFeeOn
    ? isLong
      ? tr.entryPrice * (1 + feeBe)
      : tr.entryPrice * (1 - feeBe)
    : tr.entryPrice;
  const activation = stFeeOn
    ? isLong
      ? tr.entryPrice * (1 + feeBe + buf)
      : tr.entryPrice * (1 - feeBe - buf)
    : isLong
      ? tr.entryPrice * (1 + buf)
      : tr.entryPrice * (1 - buf);
  const evtBreakeven = breakevenForEvt != null ? breakevenForEvt : breakeven;
  const evtActivation = activationPriceForEvt != null ? activationPriceForEvt : activation;
  /** T0 exact breakeven without multiplier (for display/diagnostics). */
  const exactBreakeven = stFeeOn
    ? isLong
      ? tr.entryPrice * (1 + roundTripFeeR)
      : tr.entryPrice * (1 - roundTripFeeR)
    : tr.entryPrice;

  const bumpTrailMetaSupertrend = () => {
    const c = getConfirmedStep();
    const cur = Math.max(0, Math.floor(Number(tr.trailStep) || 0));
    tr.trailStep = Math.max(cur + 1, c + 1);
    tr.extremePx = isLong ? Math.max(Number(tr.extremePx) || markPx, markPx) : Math.min(Number(tr.extremePx) || markPx, markPx);
    /** Tier label for SUPERTREND mode: T0 = first advance (BE), T1 = second, etc. */
    tr.trailTierLabel = trailStepToTierLabel(tr.trailStep);
    advanceTierLabel = tr.trailTierLabel;
  };

  const evtCore = {
    symbol: sym,
    venue: "FUTURES",
    prevStopLoss: prevSl,
    newStopLoss: finalSl,
    maxTrailSteps: trailingOpts.maxTrailSteps ?? 1,
    isLong,
    entryPrice: tr.entryPrice,
    supertrendPx: supertrendPxForEvt,
    trailStatus,
    breakeven: evtBreakeven,
    activationPrice: evtActivation,
    leverage: lev,
    bufferRate: buf,
    maintenanceMarginRate: mm,
    kind: trailKind,
    trailingMode: mode,
    /** Tier label for this advance: T0 = fee-BE floor, T1/T2/... = subsequent tightens. */
    tierLabel: advanceTierLabel,
  };

  if (b) {
    if (mode === "SUPERTREND") bumpTrailMetaSupertrend();
    b.stopLoss = finalSl;
    if (placedBracketTargets && placedBracketTargets[sym]) {
      placedBracketTargets[sym] = { ...placedBracketTargets[sym], stopLoss: finalSl };
    }
    onTrailingSlAdvance?.({
      ...evtCore,
      tierLabel: advanceTierLabel,
      trailStep: tr.trailStep,
      source: "binance_usdm_local_bracket",
    });
    return true;
  }
  if (placedBracketTargets && placedBracketTargets[sym]) {
    if (mode === "SUPERTREND") bumpTrailMetaSupertrend();
    placedBracketTargets[sym] = { ...placedBracketTargets[sym], stopLoss: finalSl };
    onTrailingSlAdvance?.({
      ...evtCore,
      tierLabel: advanceTierLabel,
      trailStep: tr.trailStep,
      source: "binance_usdm_bracket_targets",
    });
    return true;
  }
  return false;
}
