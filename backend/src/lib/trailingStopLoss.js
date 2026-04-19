import { roundTo } from "./math.js";
import {
  computeSupertrendTrailingSlUpdate,
  feeRateBreakevenPadded,
  migrateTieredTrailLegacySchema,
  trailStepToTierLabel,
} from "./supertrendTrailingSl.js";

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
    .filter((x) => Number.isFinite(x) && x > 0)
    // Canonical tier order must be monotonic in "favorable excursion":
    // - LONG: higher pct => higher lock
    // - SHORT: higher pct => lower lock
    // Sorting prevents non-monotonic ladders (e.g. [0.5, 0.2] emitting T2 above T3 then "backward" tier labels).
    .sort((a, b) => a - b);

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

/** Fraction of entry between post‑T02 rung locks when `trailPostT02SpacingFrac` is unset (≥ 2× round-trip, floor 0.04%). */
export function defaultTieredPostT02SpacingFrac(roundTripFeeRate) {
  const rt = clampFeeRate(Number(roundTripFeeRate));
  return Math.min(0.02, Math.max(rt > 0 ? 2 * rt : 0, 0.0004));
}

/**
 * Synthetic lock ladder for tiered ST preview / “locks reached” UI: T01 entry, T02 padded BE, then equidistant rungs.
 */
export function buildTieredStEquidistantLockRows(entryPx, isLong, paddedFeeBe, spacingFrac, maxRungs = 64, t01LockSlippageFrac = 0) {
  const E = Number(entryPx);
  const fb = Number(paddedFeeBe);
  const sp = Number(spacingFrac);
  const slip = Math.max(0, Math.min(0.01, Number(t01LockSlippageFrac) || 0));
  if (!Number.isFinite(E) || E <= 0 || !Number.isFinite(fb) || !Number.isFinite(sp) || sp <= 0) return [];
  const t01Lock = isLong ? E * (1 + slip) : E * (1 - slip);
  const t02Lock = isLong ? E * (1 + fb) : E * (1 - fb);
  const out = [
    { kind: "tiered_t01", lockPx: t01Lock, tierLabel: "T01" },
    { kind: "tiered_t02", lockPx: t02Lock, tierLabel: "T02" },
  ];
  const n = Math.max(0, Math.min(500, Math.floor(Number(maxRungs) || 64)));
  for (let k = 1; k <= n; k++) {
    const px = isLong ? t02Lock + k * E * sp : t02Lock - k * E * sp;
    if (!Number.isFinite(px) || px <= 0) break;
    out.push({ kind: "tiered_st_rung", lockPx: px, tierLabel: `T${k}` });
  }
  return out;
}

/**
 * Tiered SUPERTREND: activation threshold for the next SL advance at current `trailStep`.
 * T01 = entry ± buffer; T02 = entry ± (padded fee + buffer). Post‑T02: **equidistant** rungs from the T02 **lock**
 * (padded BE price), each activation = lock × (1 ± postT02Buf), where `postT02Buf` is an
 * independent knob (falls back to `bufferRate` when unset). Optional `stLevels` kept for legacy
 * non–fee-BE paths only.
 *
 * `bufferRate`       — activation gap for the T01 / T02 **fee-recovery** tiers only.
 * `postT02BufferRate`— activation gap for every post-T02 rung (T1, T2, T3, …). When null/undefined
 *                     or non-finite, the engine falls back to `bufferRate` so legacy configs keep
 *                     the old single-buffer behaviour.
 */
export function resolveSupertrendTieredActivationGate({
  stepNow,
  isLong,
  entryPx,
  feeBe,
  bufferRate,
  postT02BufferRate,
  useFeeBeTrail,
  stLevels,
  roundTripFeeRate,
  postT02SpacingFrac,
}) {
  const E = Number(entryPx);
  const buf = Number(bufferRate);
  /** Post-T02 rungs use their own buffer; fall back to `buf` so legacy callers/configs keep working. */
  const postBufRaw = Number(postT02BufferRate);
  const postBuf = Number.isFinite(postBufRaw) && postBufRaw >= 0 ? postBufRaw : buf;
  const fb = Number(feeBe);
  const defaultActivationPx = isLong
    ? E * (1 + (useFeeBeTrail ? fb : 0) + buf)
    : E * (1 - (useFeeBeTrail ? fb : 0) - buf);
  if (!Number.isFinite(E) || E <= 0) {
    return { activationPx: NaN, activationTierLabel: null };
  }
  if (stepNow <= 0) {
    const t01 = isLong ? E * (1 + buf) : E * (1 - buf);
    const activationPx = useFeeBeTrail ? t01 : defaultActivationPx;
    return { activationPx, activationTierLabel: useFeeBeTrail ? "T01" : "T0" };
  }
  if (stepNow === 1) {
    const t02 = isLong ? E * (1 + fb + buf) : E * (1 - fb - buf);
    return { activationPx: useFeeBeTrail ? t02 : defaultActivationPx, activationTierLabel: useFeeBeTrail ? "T02" : null };
  }
  if (useFeeBeTrail && stepNow >= 2) {
    const rt = roundTripFeeRate != null ? Number(roundTripFeeRate) : NaN;
    const spUser = postT02SpacingFrac != null ? Number(postT02SpacingFrac) : NaN;
    const spacingAbs = E * (Number.isFinite(spUser) && spUser > 0 ? Math.min(0.05, spUser) : defaultTieredPostT02SpacingFrac(rt));
    const k = stepNow - 1;
    const t02Lock = isLong ? E * (1 + fb) : E * (1 - fb);
    const lockPx = isLong ? t02Lock + k * spacingAbs : t02Lock - k * spacingAbs;
    if (!Number.isFinite(lockPx) || lockPx <= 0) {
      return { activationPx: defaultActivationPx, activationTierLabel: `T${stepNow - 1}` };
    }
    const gatePx =
      Number.isFinite(postBuf) && postBuf > 0
        ? (isLong ? lockPx * (1 + postBuf) : lockPx * (1 - postBuf))
        : lockPx;
    return { activationPx: gatePx, activationTierLabel: `T${stepNow - 1}` };
  }

  const levels = Array.isArray(stLevels) ? stLevels : [];
  const nLv = levels.length;
  if (!nLv) {
    return { activationPx: defaultActivationPx, activationTierLabel: null };
  }
  if (stepNow >= 2 && stepNow <= nLv) {
    const L = levels[stepNow - 1];
    const lockPx = Number(L?.lockPx);
    const good = Number.isFinite(lockPx) && lockPx > 0;
    const gatePx = good
      ? (Number.isFinite(postBuf) && postBuf > 0
          ? (isLong ? lockPx * (1 + postBuf) : lockPx * (1 - postBuf))
          : lockPx)
      : defaultActivationPx;
    return {
      activationPx: gatePx,
      activationTierLabel: L?.tierLabel != null ? String(L.tierLabel) : `T${Math.max(1, stepNow - 1)}`,
    };
  }
  const lastDef = levels[nLv - 1];
  const prevDef = levels[nLv - 2];
  const interval =
    nLv >= 2 && prevDef != null && Number.isFinite(Number(prevDef.lockPx))
      ? Math.abs(Number(lastDef.lockPx) - Number(prevDef.lockPx))
      : Math.max(Math.abs(Number(lastDef.lockPx)) * 0.001, Math.abs(Number(lastDef.lockPx) - E));
  const off = stepNow - nLv;
  const activationPx = isLong
    ? Number(lastDef.lockPx) + off * interval
    : Number(lastDef.lockPx) - off * interval;
  return { activationPx, activationTierLabel: `T${stepNow - 1}` };
}

/**
 * Tiered Supertrend: how many ladder activations the favorable extreme (`hwm`) has crossed,
 * using the same gates as `resolveSupertrendTieredActivationGate` (T01 buffer, T02 fee+buffer, then equidistant post‑T02).
 * Result matches `trailStep` semantics elsewhere: 0 = none, 1 = past T01, 2 = past T02, 3 = past first post‑T02 gate (T1), …
 * Price can jump several tiers in one tick — this returns the terminal step in one shot (unlike ST-tick +1 bumps).
 */
export function computeSupertrendTieredMaxTrailStepFromExtreme({
  hwm,
  entryPx,
  isLong,
  feeBe,
  bufferRate,
  postT02BufferRate,
  useFeeBeTrail,
  stLevels,
  roundTripFeeRate,
  postT02SpacingFrac,
  maxActivationSteps,
}) {
  const h = Number(hwm);
  const E = Number(entryPx);
  const fb = Number(feeBe);
  const buf = Number(bufferRate);
  if (!Number.isFinite(h) || !Number.isFinite(E) || E <= 0) return 0;
  const levels = Array.isArray(stLevels) ? stLevels : [];
  const cap = Math.max(3, Math.min(600, Math.floor(Number(maxActivationSteps) || 200)));
  let step = 0;
  for (let i = 0; i < cap; i++) {
    const { activationPx } = resolveSupertrendTieredActivationGate({
      stepNow: step,
      isLong,
      entryPx: E,
      feeBe: fb,
      bufferRate: buf,
      postT02BufferRate,
      useFeeBeTrail,
      stLevels: levels,
      roundTripFeeRate,
      postT02SpacingFrac,
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
 * Max `trailStep` for tiered Supertrend (T01 + T02 + post‑T02 rungs). `extraScalpingPctsOfEntry` is ignored for tiered ST
 * (kept for call-site compatibility); post‑T02 depth is `trailPostT02MaxExtraTiers` (default 150).
 */
export function maxTrailStepsForConfig(extraScalpingPctsOfEntry, trailPostT02MaxExtraTiers = 150) {
  void extraScalpingPctsOfEntry;
  const n = Math.max(10, Math.min(500, Math.floor(Number(trailPostT02MaxExtraTiers) || 150)));
  return 3 + n;
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
  activationBufferRate,
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

  const buf = Number(activationBufferRate);
  const bufOk = Number.isFinite(buf) && buf > 0;
  const activationForLock = (lockPx) => {
    const L = Number(lockPx);
    if (!Number.isFinite(L) || L <= 0) return L;
    if (!bufOk) return L;
    return isLong ? L * (1 + buf) : L * (1 - buf);
  };

  // Phase 1: advance through explicitly defined tiers (cross activation, set SL to lock)
  for (let k = step; k < n; k++) {
    const L = levels[k];
    const actPx = activationForLock(L.lockPx);
    const crossed = isLong ? hwm >= actPx : hwm <= actPx;
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
        const actPx = activationForLock(contLockPx);
        const crossed = isLong ? hwm >= actPx : hwm <= actPx;
        if (!crossed) break;
        step++;
        proposedSl = contLockPx;
        tierLabel = `T${step - 1}`;
        advanced = true;
      }
    }
  }

  const lastActivationPx = proposedSl != null ? activationForLock(proposedSl) : null;
  return { trailStep: step, extremePx: hwm, proposedSl, activationPx: lastActivationPx, advanced, tierLabel };
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
 * Effective activation buffer for tiered gates / fee ladder: fixed % vs ATR-scaled.
 * @param {object} trailingOpts
 * @param {number} [trailingOpts.bufferRate]
 * @param {string} [trailingOpts.trailBufferMode] `"PERCENT"` | `"ATR"`
 * @param {number} [trailingOpts.trailBufferAtrMult]
 * @param {number|null|undefined} [trailingOpts.atrPct]
 */
export function computeEffectiveTrailBuffer(trailingOpts) {
  const o = trailingOpts && typeof trailingOpts === "object" ? trailingOpts : {};
  const fixedBuf = Number.isFinite(Number(o.bufferRate)) ? Number(o.bufferRate) : 0.0005;
  const atrMultRaw =
    o.trailBufferAtrMult != null && Number.isFinite(Number(o.trailBufferAtrMult)) ? Number(o.trailBufferAtrMult) : 0;
  const atrMult = Math.max(0, Math.min(1, atrMultRaw));
  const atrPct = Number(o.atrPct);
  const bufMode = String(o.trailBufferMode ?? "PERCENT").toUpperCase() === "ATR" ? "ATR" : "PERCENT";
  if (bufMode === "ATR" && atrMult > 0 && Number.isFinite(atrPct) && atrPct > 0) {
    return Math.min(0.05, atrPct * atrMult);
  }
  return fixedBuf;
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
 *   activationSlippageFrac?: number; // additive on padded BE for Supertrend tiered gates
 *   trailT01LockSlippageFrac?: number; // tiered T01 only: offset SL lock from entry (LONG: above entry; SHORT: below)
 *   atrPct?: number | null; // regime ATR as fraction of price (e.g. lastRegime.atrPct)
 *   trailBufferMode?: "PERCENT" | "ATR"; // PERCENT = bufferRate only; ATR = min(5%, atrPct×mult), else bufferRate
 *   trailBufferAtrMult?: number; // used when trailBufferMode is ATR
 *   maintenanceMarginRate?: number;
 *   minSlDistanceFrac?: number;
 *   minTrailGapFromMarkFrac?: number;
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
  const buf = computeEffectiveTrailBuffer(trailingOpts);
  const slipFrac = Math.max(
    0,
    Math.min(0.01, Number(trailingOpts.activationSlippageFrac != null ? Number(trailingOpts.activationSlippageFrac) : 0)),
  );
  /**
   * T02 gate padding — `slipFrac` delays the **activation threshold** only (mark must travel
   * entry ± (feeBe + slipFrac + buffer) before the tier engages). The SL **lock** must stay at
   * exact fee break-even (`feeBe`) — inflating the lock by `slipFrac` silently changes T02 from
   * "net ≈ 0" to "net = slipFrac × notional", which contradicts the T02 zero-loss spec and
   * produces unexpected "profit on T02" rows in history.
   * `feeBeSt`        — padded rate, used for ACTIVATION gates only (below).
   * `feeBeLockRate`  — exact rate, used for SL LOCK placement (breakeven floor).
   */
  const feeBeSt = Math.min(0.02, feeBe + slipFrac);
  const feeBeLockRate = feeBe;
  /** Tiered T01 SL lock: entry × (1 ± frac) so lock clears tick/display rounding vs flat entry (cap 1%). */
  const t01LockSlipFrac = Math.max(
    0,
    Math.min(0.01, Number(trailingOpts.trailT01LockSlippageFrac != null ? Number(trailingOpts.trailT01LockSlippageFrac) : 0)),
  );
  const mm = Number.isFinite(Number(trailingOpts.maintenanceMarginRate))
    ? Number(trailingOpts.maintenanceMarginRate)
    : 0.005;
  const minDist =
    trailingOpts.minSlDistanceFrac != null && Number.isFinite(Number(trailingOpts.minSlDistanceFrac))
      ? Number(trailingOpts.minSlDistanceFrac)
      : 0.002;
  const minGapFromMark =
    trailingOpts.minTrailGapFromMarkFrac != null && Number.isFinite(Number(trailingOpts.minTrailGapFromMarkFrac))
      ? Number(trailingOpts.minTrailGapFromMarkFrac)
      : 0;

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
      tr.trailTierLabel = trailStepToTierLabel(tr.trailStep, tr.trailStepLabelStyle || "classic");
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
      activationBufferRate: buf,
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
    activationPriceForEvt = adv.activationPx ?? adv.proposedSl;
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
      ? tr.entryPrice * (1 + (useFeeBeTrail ? feeBeSt : 0) + buf)
      : tr.entryPrice * (1 - (useFeeBeTrail ? feeBeSt : 0) - buf);

    const maxStepCfg = trailingOpts.maxTrailSteps;
    const maxStepCap =
      maxStepCfg != null && Number.isFinite(Number(maxStepCfg)) && Number(maxStepCfg) > 0
        ? Math.floor(Number(maxStepCfg))
        : null;
    const postT02SpacingUser =
      trailingOpts.trailPostT02SpacingFrac != null && Number.isFinite(Number(trailingOpts.trailPostT02SpacingFrac))
        ? Number(trailingOpts.trailPostT02SpacingFrac)
        : null;
    const postT02MaxExtraTiers =
      trailingOpts.trailPostT02MaxExtraTiers != null && Number.isFinite(Number(trailingOpts.trailPostT02MaxExtraTiers))
        ? Math.max(10, Math.min(500, Math.floor(Number(trailingOpts.trailPostT02MaxExtraTiers))))
        : 150;
    const maxTieredActivationSteps =
      maxStepCap != null ? Math.max(3, maxStepCap) : maxTrailStepsForConfig(trailingOpts.extraScalpingPcts ?? [], postT02MaxExtraTiers);
    /**
     * Post-T02 buffer: independent from `buf` (the T01/T02 fee-recovery buffer). Users can now
     * keep T01/T02 glued to entry (small `buf`, quick loss-protection activation) while giving
     * every profit rung (T1, T2, T3…) a larger pull-back cushion to avoid noise stops. When the
     * field is null/unset, the gate resolver falls back to `buf` (backward-compatible default).
     */
    const postT02BufRaw = Number(trailingOpts.postT02ActivationBufferRate);
    const postT02Buf =
      Number.isFinite(postT02BufRaw) && postT02BufRaw >= 0 ? Math.min(0.05, postT02BufRaw) : null;
    const gateRtSpacing = {
      roundTripFeeRate: roundTripFeeR,
      postT02SpacingFrac: postT02SpacingUser,
      postT02BufferRate: postT02Buf,
    };

    const stFeeOnEvt = useFeeBeTrail;
    /** LOCK at exact fee BE (not padded with slipFrac) — see `feeBeLockRate` comment above. */
    const evtBreakevenBase = stFeeOnEvt
      ? isLong
        ? tr.entryPrice * (1 + feeBeLockRate)
        : tr.entryPrice * (1 - feeBeLockRate)
      : tr.entryPrice;
    /** ACTIVATION fallback: padded rate (`feeBeSt`) is intentional — slipFrac delays activation only. */
    const evtActivationFallback = stFeeOnEvt
      ? isLong
        ? tr.entryPrice * (1 + feeBeSt + buf)
        : tr.entryPrice * (1 - feeBeSt - buf)
      : isLong
        ? tr.entryPrice * (1 + buf)
        : tr.entryPrice * (1 - buf);

    const maxCatchUpIters = 32;
    let advancedAny = false;

    const bumpTrailMetaSupertrendInner = () => {
      const c0 = getConfirmedStep();
      const cur0 = Math.max(0, Math.floor(Number(tr.trailStep) || 0));
      tr.trailStep = Math.max(cur0 + 1, c0 + 1);
      tr.extremePx = isLong
        ? Math.max(Number(tr.extremePx) || markPx, markPx)
        : Math.min(Number(tr.extremePx) || markPx, markPx);
      tr.trailTierLabel = trailStepToTierLabel(tr.trailStep, tr.trailStepLabelStyle || "classic");
      advanceTierLabel = tr.trailTierLabel;
    };

    /**
     * Tiered fee-BE + advanced: **tier index follows price** (ladder activations on HWM), while **SL**
     * still follows `max(ST, BE)` in one geometry pass — avoids ST-lag leaving `trailStep` stuck at T1
     * when the mark has already crossed T5 gates.
     */
    if (tieredStMode) {
      enforceMonotonicTrailStep();
      migrateTieredTrailLegacySchema(tr);
      tr.trailStepLabelStyle = "tiered_st_fee_entry";
      const t01ActivationPx = isLong ? tr.entryPrice * (1 + buf) : tr.entryPrice * (1 - buf);
      const t02ActivationPx = defaultActivationPx;
      const entryLockBreakevenPx = isLong
        ? tr.entryPrice * (1 + t01LockSlipFrac)
        : tr.entryPrice * (1 - t01LockSlipFrac);
      const bCur = localBrackets[sym];
      const tgtCur = placedBracketTargets?.[sym];
      const prevRawCur = bCur ? bCur.stopLoss : tgtCur?.stopLoss;
      const prevSlCur = Number(prevRawCur);
      if (!Number.isFinite(prevSlCur) || prevSlCur <= 0) return false;

      let minDistLoop = minDist;
      if (tickSize != null && Number.isFinite(tickSize) && tickSize > 0 && markPx > 0) {
        const tickFrac = (2 * tickSize) / markPx;
        if (Number.isFinite(tickFrac) && tickFrac > 0) minDistLoop = Math.min(minDistLoop, tickFrac);
      }

      const ext0 = Number.isFinite(Number(tr.extremePx)) ? Number(tr.extremePx) : markPx;
      const hwm = isLong ? Math.max(ext0, markPx) : Math.min(ext0, markPx);
      tr.extremePx = hwm;

      const rawPriceStep = computeSupertrendTieredMaxTrailStepFromExtreme({
        hwm,
        entryPx: tr.entryPrice,
        isLong,
        feeBe: feeBeSt,
        bufferRate: buf,
        useFeeBeTrail,
        stLevels,
        maxActivationSteps: maxTieredActivationSteps,
        ...gateRtSpacing,
      });
      /** Capping below 3 would strand the trade at T02 (never Supertrend / first ladder gate). */
      const maxStepCapTiered =
        maxStepCap != null ? Math.max(maxStepCap, 3) : null;
      const priceStep = maxStepCapTiered != null ? Math.min(rawPriceStep, maxStepCapTiered) : rawPriceStep;
      const c = getConfirmedStep();
      const prevTrailStep = Math.max(0, Math.floor(Number(tr.trailStep) || 0));
      const nextTrailStep = Math.max(prevTrailStep, priceStep, c);

      activationPriceForEvt =
        nextTrailStep === 1
          ? t01ActivationPx
          : nextTrailStep === 2
            ? t02ActivationPx
            : resolveSupertrendTieredActivationGate({
                stepNow: nextTrailStep - 1,
                isLong,
                entryPx: tr.entryPrice,
                feeBe: feeBeSt,
                bufferRate: buf,
                useFeeBeTrail,
                stLevels,
                ...gateRtSpacing,
              }).activationPx;
      breakevenForEvt = nextTrailStep === 1 ? entryLockBreakevenPx : evtBreakevenBase;

      if (nextTrailStep < 1) {
        return false;
      }

      /** T01/T02 = entry then fee-BE locks (no ST line); step ≥ 3 = Supertrend with fee-BE floor. */
      const useAdvCompute = nextTrailStep >= 3 && effectiveUseAdv;
      if (useAdvCompute && !hasValidStPx) {
        tr.trailStep = nextTrailStep;
        tr.trailTierLabel = trailStepToTierLabel(tr.trailStep, "tiered_st_fee_entry");
        if (trailDiagEmit(tr, "tiered_st_no_px", 90_000)) {
          notifyActivity?.({
            category: "risk",
            level: "warn",
            msg: `Tiered trailing · ${sym} · mark passed Supertrend gates (after T02) but Supertrend price missing (tier state updated; SL unchanged until ST is available)`,
            reason: "trailing_sl_diagnostic",
            symbol: sym,
            detail: { outcome: "failure", phase: "activation", markPx, trailStep: tr.trailStep },
          });
        }
        return false;
      }

      const gateForGeometry =
        nextTrailStep <= 1
          ? t01ActivationPx
          : nextTrailStep === 2
            ? t02ActivationPx
            : resolveSupertrendTieredActivationGate({
                stepNow: nextTrailStep - 1,
                isLong,
                entryPx: tr.entryPrice,
                feeBe: feeBeSt,
                bufferRate: buf,
                useFeeBeTrail,
                stLevels,
                ...gateRtSpacing,
              }).activationPx;
      const pxForCompute = isLong ? Math.max(markPx, gateForGeometry) : Math.min(markPx, gateForGeometry);

      const computeBreakevenPx = nextTrailStep === 1 ? entryLockBreakevenPx : evtBreakevenBase;
      const computeActivationPx = gateForGeometry;

      const r = computeSupertrendTrailingSlUpdate({
        entryPrice: tr.entryPrice,
        currentPrice: pxForCompute,
        supertrend: useAdvCompute && hasValidStPx ? stPx : NaN,
        previousSl: prevSlCur,
        isLong,
        leverage: lev,
        feeRate: feeBeSt,
        bufferRate: buf,
        maintenanceMarginRate: mm,
        minSlDistanceFrac: minDistLoop,
        minTrailGapFromMarkFrac: minGapFromMark,
        useFeeBreakeven: useFeeBeTrail,
        useAdvancedTrail: useAdvCompute,
        activationPrice: computeActivationPx,
        breakevenPrice: computeBreakevenPx,
      });

      if (r.status === "REJECT_TRADE" || r.status === "INVALID") {
        if (trailDiagEmit(tr, `bad_${r.status}`, 120_000)) {
          notifyActivity({
            category: "risk",
            level: r.status === "REJECT_TRADE" ? "warn" : "error",
            msg: `Trailing ${r.status === "REJECT_TRADE" ? "blocked" : "invalid"} · ${sym} · ${r.status} (mark ${markPx}, entry ${tr.entryPrice})`,
            reason: "trailing_sl_diagnostic",
            symbol: sym,
            detail: { outcome: "failure", phase: "geometry", trailStatus: r.status, markPx, entryPrice: tr.entryPrice, isLong },
          });
        }
        return false;
      }
      if (r.status === "NO_SUPERTREND" || r.status === "NO_TRAIL") {
        return false;
      }

      stInTrailZone = r.status === "OK";

      tr.trailStep = nextTrailStep;
      tr.trailTierLabel = trailStepToTierLabel(tr.trailStep, "tiered_st_fee_entry");
      advanceTierLabel = tr.trailTierLabel;

      if (r.status === "OK") {
        const seen = (tr._trailActivationSeen = tr._trailActivationSeen || {});
        for (let s = Math.max(1, prevTrailStep + 1); s <= nextTrailStep; s++) {
          const lab = trailStepToTierLabel(s, "tiered_st_fee_entry");
          if (!lab || seen[lab]) continue;
          const gateAp =
            s === 1 ? t01ActivationPx : s === 2 ? t02ActivationPx : resolveSupertrendTieredActivationGate({
                stepNow: s - 1,
                isLong,
                entryPx: tr.entryPrice,
                feeBe: feeBeSt,
                bufferRate: buf,
                useFeeBeTrail,
                stLevels,
                ...gateRtSpacing,
              }).activationPx;
          const beAp = s === 1 ? entryLockBreakevenPx : evtBreakevenBase;
          seen[lab] = true;
          notifyActivity?.({
            category: "trailing",
            level: "info",
            msg: `Trailing activation ${lab} · ${sym} · mark passed activation (${Number(gateAp).toFixed(6)}); futures trailing engaged`,
            reason: "trailing_activation_engaged",
            symbol: sym,
            detail: {
              outcome: "success",
              phase: "activation",
              markPx,
              activationPrice: gateAp,
              breakeven: beAp,
              tierLabel: lab,
              entryPrice: tr.entryPrice,
              isLong,
              supertrendPx: supertrendPxForEvt,
            },
          });
        }
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

      if (mergedLoop == null || finalSlPreLoop == null) {
        return false;
      }

      if (finalSlPreLoop === prevEffLoop) {
        if (prevSlCur !== prevEffLoop) {
          if (bCur) bCur.stopLoss = prevEffLoop;
          if (placedBracketTargets && placedBracketTargets[sym]) {
            placedBracketTargets[sym] = { ...placedBracketTargets[sym], stopLoss: prevEffLoop };
          }
        }
        return false;
      }

      const finalSlLoop = finalSlPreLoop;
      if (!Number.isFinite(finalSlLoop) || finalSlLoop <= 0 || finalSlLoop === prevEffLoop) {
        return false;
      }

      const evtActivationLine = activationPriceForEvt != null ? activationPriceForEvt : evtActivationFallback;
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
        return false;
      }
      return true;
    }

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
        tieredStMode
          ? resolveSupertrendTieredActivationGate({
              stepNow,
              isLong,
              entryPx: tr.entryPrice,
              feeBe: feeBeSt,
              bufferRate: buf,
              useFeeBeTrail,
              stLevels,
              ...gateRtSpacing,
            })
          : { activationPx: defaultActivationPx, activationTierLabel: null };
      const activationPx = tieredGate.activationPx;
      const activationTierLabelGate = tieredGate.activationTierLabel;
      activationPriceForEvt = activationPx;
      breakevenForEvt =
        tieredStMode && useFeeBeTrail && stepNow === 0 ? tr.entryPrice : evtBreakevenBase;
      const crossedTierActivation = isLong ? hwm >= activationPx : hwm <= activationPx;
      if (!crossedTierActivation) break;

      const pxForCompute = isLong ? Math.max(markPx, activationPx) : Math.min(markPx, activationPx);

      /**
       * Tiered ST: T01 (buffer) → entry SL; T02 (fee+buffer) → padded fee-BE SL; then Supertrend with fee floor.
       */
      const feeEntryTierOnly = tieredStMode && useFeeBeTrail && stepNow < 2;
      const useAdvThisIter = feeEntryTierOnly ? false : effectiveUseAdv;

      const r = computeSupertrendTrailingSlUpdate({
        entryPrice: tr.entryPrice,
        currentPrice: pxForCompute,
        supertrend: useAdvThisIter && hasValidStPx ? stPx : NaN,
        previousSl: prevSlCur,
        isLong,
        leverage: lev,
        feeRate: feeBeSt,
        bufferRate: buf,
        maintenanceMarginRate: mm,
        minSlDistanceFrac: minDistLoop,
        minTrailGapFromMarkFrac: minGapFromMark,
        useFeeBreakeven: useFeeBeTrail,
        useAdvancedTrail: useAdvThisIter,
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
        tieredStMode ? `${activationTierLabel ?? "tier"}:${activationPx.toFixed(8)}` : activationTierLabel ?? "ST";
      if (r.status === "OK" && tr._trailingActivationLoggedTier !== activationKey) {
        tr._trailingActivationLoggedTier = activationKey;
        notifyActivity?.({
          category: "trailing",
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
    const allowNoopDiag =
      tr.trailStepLabelStyle === "tiered_st_fee_entry" ? trailStepN < 2 : trailStepN < 1;
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
  /** Event/display BE reflects the actual LOCK price — both modes now use exact `feeBe` (no slipFrac). */
  const feeBeEvt = feeBe;
  const breakeven = stFeeOn
    ? isLong
      ? tr.entryPrice * (1 + feeBeEvt)
      : tr.entryPrice * (1 - feeBeEvt)
    : tr.entryPrice;
  const activation = stFeeOn
    ? isLong
      ? tr.entryPrice * (1 + feeBeEvt + buf)
      : tr.entryPrice * (1 - feeBeEvt - buf)
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
    /** Tier label: classic T0,T1… or tiered T01,T02,T1… when `trailStepLabelStyle` is set. */
    tr.trailTierLabel = trailStepToTierLabel(tr.trailStep, tr.trailStepLabelStyle || "classic");
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
