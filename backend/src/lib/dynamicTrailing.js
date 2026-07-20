/**
 * Dynamic trailing — ATR-scaled breakeven buffers + hybrid advanced SL (Chandelier + MFE + ST).
 * Used when `trailSizingMode === "DYNAMIC"`. Fixed % mode never imports these paths at runtime
 * except through `resolveTrailSizingMode`.
 */

/** Reference ATR% for regime low/high band split (~1.5% on 1h BTC). */
export const DYNAMIC_REGIME_MEDIAN_ATR_PCT = 0.015;

/** V2 defaults — ATR-native, calibrated for 1m mark micro-trail. */
export const DYNAMIC_TRAIL_V2_DEFAULTS = {
  trailDynamicSlAtrMult: 1.1,
  trailDynamicSlMinPct: 0.01,
  trailDynamicSlMaxPct: 0.04,
  trailDynamicBufferMinPct: 0.01,
  trailDynamicMicroFloorMult: 1.0,
  trailDynamicBeAtrMult: 1.05,
  trailDynamicBeT01LockAtrMult: 0,
  trailDynamicBeRegimeAdjust: true,
  trailDynamicBeRegimeLowMult: 0.92,
  trailDynamicBeRegimeHighMult: 1.12,
  trailDynamicAdvAtrHwmMult: 2.75,
  trailDynamicAdvMfeGivebackFrac: 0.16,
  trailDynamicAdvMfeMinR: 1.5,
  trailDynamicAdvPostT02StepAtrMult: 0.09,
  trailDynamicAdvMergeSupertrend: true,
  trailDynamicAdvAtrSource: "ENTRY",
};

/** Strategy-aware dynamic defaults (UNIFIED needs wider SL under 1m micro-trail). */
export function getDynamicTrailDefaultsForStrategy(strategyKey) {
  const d = { ...DYNAMIC_TRAIL_V2_DEFAULTS };
  if (String(strategyKey ?? "").toUpperCase() === "UNIFIED_ELITE") {
    d.trailDynamicSlAtrMult = 2.2;
  }
  return d;
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function resolvePostT02ActivationBufferFrac(postT02BufferRate, bufferRate) {
  const raw = postT02BufferRate != null ? Number(postT02BufferRate) : NaN;
  if (Number.isFinite(raw) && raw >= 0) return Math.min(0.05, raw);
  const buf = Number(bufferRate);
  return Number.isFinite(buf) && buf >= 0 ? buf : 0;
}

/** @returns {"FIXED_PCT"|"DYNAMIC"} */
export function resolveTrailSizingMode(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  return String(c.trailSizingMode ?? "FIXED_PCT").toUpperCase() === "DYNAMIC" ? "DYNAMIC" : "FIXED_PCT";
}

export function parseDynamicBeOpts(trailingOpts) {
  const o = trailingOpts && typeof trailingOpts === "object" ? trailingOpts : {};
  const d = DYNAMIC_TRAIL_V2_DEFAULTS;
  return {
    atrMult: clamp(o.trailDynamicBeAtrMult ?? d.trailDynamicBeAtrMult, 0, 2),
    t01LockAtrMult: clamp(o.trailDynamicBeT01LockAtrMult ?? d.trailDynamicBeT01LockAtrMult, 0, 1),
    regimeAdjust: o.trailDynamicBeRegimeAdjust ?? d.trailDynamicBeRegimeAdjust,
    regimeLowMult: clamp(o.trailDynamicBeRegimeLowMult ?? d.trailDynamicBeRegimeLowMult, 0.5, 1.5),
    regimeHighMult: clamp(o.trailDynamicBeRegimeHighMult ?? d.trailDynamicBeRegimeHighMult, 0.5, 2),
    microFloorMult: clamp(o.trailDynamicMicroFloorMult ?? d.trailDynamicMicroFloorMult, 0.5, 2),
    bufferMinPct: clamp(o.trailDynamicBufferMinPct ?? d.trailDynamicBufferMinPct, 0.005, 0.03),
  };
}

export function parseDynamicAdvOpts(trailingOpts) {
  const o = trailingOpts && typeof trailingOpts === "object" ? trailingOpts : {};
  const d = DYNAMIC_TRAIL_V2_DEFAULTS;
  return {
    atrHwmMult: clamp(o.trailDynamicAdvAtrHwmMult ?? d.trailDynamicAdvAtrHwmMult, 0, 6),
    mfeGivebackFrac: clamp(o.trailDynamicAdvMfeGivebackFrac ?? d.trailDynamicAdvMfeGivebackFrac, 0, 0.9),
    mfeMinR: clamp(o.trailDynamicAdvMfeMinR ?? d.trailDynamicAdvMfeMinR, 0, 10),
    mergeSt: o.trailDynamicAdvMergeSupertrend ?? d.trailDynamicAdvMergeSupertrend,
    atrSource:
      String(o.trailDynamicAdvAtrSource ?? d.trailDynamicAdvAtrSource).toUpperCase() === "ROLLING"
        ? "ROLLING"
        : "ENTRY",
    postT02StepAtrMult: clamp(
      o.trailDynamicAdvPostT02StepAtrMult ?? d.trailDynamicAdvPostT02StepAtrMult,
      0,
      2,
    ),
  };
}

/**
 * Initial bracket SL% from entry ATR — coin-agnostic (alt vs BTC auto-scales).
 * Used when `trailSizingMode === "DYNAMIC"` unless `slAtrMultiplier` is explicitly set.
 */
export function computeDynamicInitialSlPct({ entryAtrPct, cfg }) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const d = DYNAMIC_TRAIL_V2_DEFAULTS;
  const atr = Number(entryAtrPct);
  if (!Number.isFinite(atr) || atr <= 0) return null;
  const strat = String(c.manualStrategy ?? "").toUpperCase();
  const stratDefaultMult = strat === "UNIFIED_ELITE" ? 2.2 : d.trailDynamicSlAtrMult;
  const mult = clamp(c.trailDynamicSlAtrMult ?? stratDefaultMult, 0.8, 6);
  const minPct = clamp(c.trailDynamicSlMinPct ?? d.trailDynamicSlMinPct, 0.003, 0.05);
  const maxPct = clamp(c.trailDynamicSlMaxPct ?? d.trailDynamicSlMaxPct, 0.01, 0.15);
  return clamp(atr * mult, minPct, maxPct);
}

export function computeDynamicRegimeMult(
  entryAtrPct,
  regimeAdjust,
  lowMult = 0.85,
  highMult = 1.15,
  medianRef = DYNAMIC_REGIME_MEDIAN_ATR_PCT,
) {
  if (!regimeAdjust) return 1;
  const atr = Number(entryAtrPct);
  if (!Number.isFinite(atr) || atr <= 0) return 1;
  if (atr < medianRef) return clamp(lowMult, 0.5, 1.5);
  if (atr > medianRef) return clamp(highMult, 0.5, 2);
  return 1;
}

/**
 * T01/T02 activation buffer when dynamic breakeven is active.
 */
export function computeDynamicTrailBuffer({ entryAtrPct, dynamicBe, fallbackBufferRate = 0.0005 }) {
  const be = dynamicBe && typeof dynamicBe === "object" ? dynamicBe : parseDynamicBeOpts({});
  const atr = Number(entryAtrPct);
  if (!Number.isFinite(atr) || atr <= 0) {
    const fb = Number(fallbackBufferRate);
    return Number.isFinite(fb) && fb >= 0 ? Math.min(0.05, fb) : 0.0005;
  }
  const regimeMult = computeDynamicRegimeMult(
    atr,
    be.regimeAdjust,
    be.regimeLowMult,
    be.regimeHighMult,
  );
  const scaled = atr * be.atrMult * regimeMult;
  const microFloor = atr * (be.microFloorMult ?? 1);
  const absFloor = Number(be.bufferMinPct ?? 0);
  return Math.min(0.05, Math.max(scaled, microFloor, Number.isFinite(absFloor) && absFloor > 0 ? absFloor : 0));
}

/** T01 lock offset as fraction of entry (dynamic or fixed fallback). */
export function computeDynamicT01LockFrac({ entryAtrPct, t01LockAtrMult, fixedT01LockSlipFrac = 0 }) {
  const atrMult = Math.max(0, Number(t01LockAtrMult ?? 0));
  const atr = Number(entryAtrPct);
  if (atrMult > 0 && Number.isFinite(atr) && atr > 0) {
    return Math.min(0.01, atr * atrMult);
  }
  return Math.max(0, Math.min(0.01, Number(fixedT01LockSlipFrac) || 0));
}

export function resolveEffectiveAtrPct({ snapshot, trailingOpts, rollingAtrPct }) {
  const adv = snapshot?.dynamicAdv ?? parseDynamicAdvOpts(trailingOpts);
  const source = String(adv.atrSource ?? "ENTRY").toUpperCase();
  if (source === "ROLLING") {
    const roll = Number(rollingAtrPct ?? trailingOpts?.atrPct);
    if (Number.isFinite(roll) && roll > 0) return roll;
  }
  const entry = Number(snapshot?.entryAtrPct ?? trailingOpts?.atrPct);
  return Number.isFinite(entry) && entry > 0 ? entry : null;
}

export function computeInitialRiskFrac({ entryPx, initialSlPx, isLong }) {
  const E = Number(entryPx);
  const sl = Number(initialSlPx);
  if (!Number.isFinite(E) || E <= 0 || !Number.isFinite(sl) || sl <= 0) return null;
  const riskFrac = isLong ? (E - sl) / E : (sl - E) / E;
  return Number.isFinite(riskFrac) && riskFrac > 0 ? riskFrac : null;
}

export function computePeakMfeR({ isLong, entryPx, hwm, initialRiskFrac }) {
  const E = Number(entryPx);
  const risk = Number(initialRiskFrac);
  if (!Number.isFinite(E) || E <= 0 || !Number.isFinite(risk) || risk <= 0) return 0;
  const h = Number(hwm);
  if (!Number.isFinite(h)) return 0;
  const mfeFrac = isLong ? (h - E) / E : (E - h) / E;
  return Math.max(0, mfeFrac / risk);
}

export function computeChandelierSl({ isLong, hwm, entryPx, atrPct, atrHwmMult }) {
  const h = Number(hwm);
  const E = Number(entryPx);
  const atr = Number(atrPct);
  const mult = Math.max(0, Number(atrHwmMult ?? 0));
  if (!Number.isFinite(h) || !Number.isFinite(E) || E <= 0 || !Number.isFinite(atr) || atr <= 0 || mult <= 0) {
    return null;
  }
  const offset = h * atr * mult;
  return isLong ? h - offset : h + offset;
}

export function computeMfeRatchetSl({ isLong, entryPx, initialRiskFrac, peakMfeR, mfeGivebackFrac, mfeMinR }) {
  const peak = Number(peakMfeR);
  const minR = Math.max(0, Number(mfeMinR ?? 0));
  if (!Number.isFinite(peak) || peak < minR) return null;
  const E = Number(entryPx);
  const risk = Number(initialRiskFrac);
  if (!Number.isFinite(E) || E <= 0 || !Number.isFinite(risk) || risk <= 0) return null;
  const giveback = clamp(mfeGivebackFrac ?? 0.25, 0, 0.9);
  const lockedMfeFrac = peak * risk * (1 - giveback);
  return isLong ? E * (1 + lockedMfeFrac) : E * (1 - lockedMfeFrac);
}

/**
 * Hybrid advanced SL: max(long) / min(short) of fee floor, Chandelier, MFE ratchet, optional ST line.
 */
export function computeDynamicAdvancedSl({
  isLong,
  hwm,
  entryPx,
  atrPct,
  stLine,
  prevSl,
  feeBeFloor,
  initialRiskFrac,
  peakMfeR,
  dynamicAdv,
}) {
  const adv = dynamicAdv && typeof dynamicAdv === "object" ? dynamicAdv : parseDynamicAdvOpts({});
  const candidates = [];
  const floor = Number(feeBeFloor);
  if (Number.isFinite(floor) && floor > 0) candidates.push(floor);

  const chandelier = computeChandelierSl({
    isLong,
    hwm,
    entryPx,
    atrPct,
    atrHwmMult: adv.atrHwmMult,
  });
  if (chandelier != null && Number.isFinite(chandelier) && chandelier > 0) candidates.push(chandelier);

  const mfeSl = computeMfeRatchetSl({
    isLong,
    entryPx,
    initialRiskFrac,
    peakMfeR,
    mfeGivebackFrac: adv.mfeGivebackFrac,
    mfeMinR: adv.mfeMinR,
  });
  if (mfeSl != null && Number.isFinite(mfeSl) && mfeSl > 0) candidates.push(mfeSl);

  const st = Number(stLine);
  if (adv.mergeSt !== false && Number.isFinite(st) && st > 0) candidates.push(st);

  if (!candidates.length) return null;

  let candidate = isLong ? Math.max(...candidates) : Math.min(...candidates);
  const prev = Number(prevSl);
  if (Number.isFinite(prev) && prev > 0) {
    candidate = isLong ? Math.max(prev, candidate) : Math.min(prev, candidate);
  }
  return candidate;
}

/** Dynamic post-T02 gate spacing as fraction of entry (ATR × mult, capped 5%). */
export function dynamicPostT02SpacingFrac(entryAtrPct, postT02StepAtrMult) {
  const atr = Number(entryAtrPct);
  const mult = Math.max(0, Number(postT02StepAtrMult ?? 0.5));
  if (!Number.isFinite(atr) || atr <= 0 || mult <= 0) return 0.0004;
  return Math.min(0.05, atr * mult);
}

/**
 * Post-T02 activation gate with ATR-based spacing (dynamic advanced step advancement).
 */
export function resolveDynamicTieredActivationGate({
  stepNow,
  isLong,
  entryPx,
  feeBe,
  bufferRate,
  postT02BufferRate,
  useFeeBeTrail,
  entryAtrPct,
  postT02StepAtrMult,
}) {
  const E = Number(entryPx);
  const buf = Number(bufferRate);
  const fb = Number(feeBe);
  const postBuf = resolvePostT02ActivationBufferFrac(postT02BufferRate, bufferRate);
  if (!Number.isFinite(E) || E <= 0) {
    return { activationPx: NaN, activationTierLabel: null };
  }
  if (stepNow <= 0) {
    const t01 = isLong ? E * (1 + buf) : E * (1 - buf);
    return { activationPx: useFeeBeTrail ? t01 : t01, activationTierLabel: useFeeBeTrail ? "T01" : "T0" };
  }
  if (stepNow === 1) {
    const t02 = isLong ? E * (1 + fb + buf) : E * (1 - fb - buf);
    return { activationPx: t02, activationTierLabel: "T02" };
  }
  const spacingAbs = E * dynamicPostT02SpacingFrac(entryAtrPct, postT02StepAtrMult);
  const k = stepNow - 1;
  const t02Lock = isLong ? E * (1 + fb) : E * (1 - fb);
  const lockPx = isLong ? t02Lock + k * spacingAbs : t02Lock - k * spacingAbs;
  if (!Number.isFinite(lockPx) || lockPx <= 0) {
    return { activationPx: NaN, activationTierLabel: `T${stepNow - 1}` };
  }
  const gatePx =
    postBuf > 0 ? (isLong ? lockPx * (1 + postBuf) : lockPx * (1 - postBuf)) : lockPx;
  return { activationPx: gatePx, activationTierLabel: `T${stepNow - 1}` };
}

export function computeDynamicTieredMaxTrailStepFromExtreme({
  hwm,
  entryPx,
  isLong,
  feeBe,
  bufferRate,
  postT02BufferRate,
  useFeeBeTrail,
  entryAtrPct,
  postT02StepAtrMult,
  maxActivationSteps,
}) {
  const h = Number(hwm);
  const E = Number(entryPx);
  if (!Number.isFinite(h) || !Number.isFinite(E) || E <= 0) return 0;
  const cap = Math.max(3, Math.min(600, Math.floor(Number(maxActivationSteps) || 200)));
  let step = 0;
  for (let i = 0; i < cap; i++) {
    const { activationPx } = resolveDynamicTieredActivationGate({
      stepNow: step,
      isLong,
      entryPx: E,
      feeBe,
      bufferRate,
      postT02BufferRate,
      useFeeBeTrail,
      entryAtrPct,
      postT02StepAtrMult,
    });
    const ap = Number(activationPx);
    if (!Number.isFinite(ap) || ap <= 0) break;
    const crossed = isLong ? h >= ap : h <= ap;
    if (!crossed) break;
    step += 1;
  }
  return step;
}

/**
 * Build snapshot extension fields for `trailLadderSnapshotV1` (dynamic mode).
 */
export function buildDynamicTrailSnapshotFields(trailingOpts, atrPct, initialSlPx) {
  const o = trailingOpts && typeof trailingOpts === "object" ? trailingOpts : {};
  const entryAtr = Number.isFinite(Number(atrPct)) && Number(atrPct) > 0 ? Number(atrPct) : null;
  const adv = parseDynamicAdvOpts(o);
  const userPost =
    o.postT02SpacingFrac != null && Number.isFinite(Number(o.postT02SpacingFrac))
      ? Number(o.postT02SpacingFrac)
      : o.trailPostT02SpacingFrac != null && Number.isFinite(Number(o.trailPostT02SpacingFrac))
        ? Number(o.trailPostT02SpacingFrac)
        : null;
  const postT02SpacingFrac =
    userPost != null ? userPost : dynamicPostT02SpacingFrac(entryAtr, adv.postT02StepAtrMult);
  return {
    trailSizingMode: "DYNAMIC",
    entryAtrPct: entryAtr,
    initialSlPx: Number.isFinite(Number(initialSlPx)) && Number(initialSlPx) > 0 ? Number(initialSlPx) : null,
    dynamicBe: parseDynamicBeOpts(o),
    dynamicAdv: adv,
    postT02SpacingFrac,
  };
}
