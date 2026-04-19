/**
 * Fee-ladder trailing locks — mirrors `backend/src/lib/trailingStopLoss.js`.
 *
 * **Supertrend-based settings (TradingPanel) → runtime**
 * These bot fields are passed into `trailingStopLoss` / `applyTrailingStopBinanceMemory` (see `backend/src/state/bot.js`):
 * - `trailOpenFeeRate` + `trailCloseFeeRate` → round-trip fee; with `trailFeeBeMultiplier` → padded rate for T02 lock / activation (tiered) and fee-ladder T0.
 * - `trailBufferRate` → `bufferRate`: fixed activation buffer (fraction) when `trailBufferMode` is `PERCENT`, or fallback when ATR is missing in `ATR` mode.
 * - `trailBufferMode` → `PERCENT` | `ATR`: whether buffer is fixed % or `min(5%, atrPct × trailBufferAtrMult)`.
 * - `trailActivationSlippageFrac` → added to padded fee for Supertrend tiered gates (`feeBeSt` in engine); fee ladder unchanged.
 * - `trailT01LockSlippageFrac` → tiered T01 stop lock offset from entry (fraction of entry; LONG locks above entry).
 * - `trailBufferAtrMult` + `lastRegime.atrPct` → used when `trailBufferMode` is `ATR` (see `computeEffectiveTrailBuffer`).
 * - `trailFeeBeMultiplier` → `feeBeMultiplier`: safety padding on round-trip for padded breakeven (T02 SL, fee-ladder T0, `feeRateBreakevenPadded`).
 * - `trailMinSlDistFrac` → `minSlDistanceFrac`: min |mark − newSL|/mark before accepting a tighten (noise filter).
 * - `trailMinGapFromMarkFrac` → `minTrailGapFromMarkFrac`: keeps SL at least this fraction away from mark (pullback room).
 * - `trailMaintMarginRate` → `maintenanceMarginRate`: liquidation vs breakeven geometry in `computeSupertrendTrailingSlUpdate` / open rejection.
 * Toggles: `futuresTrailingStFeeBreakeven`, `futuresTrailingStAdvanced` → `supertrendUseFeeBreakeven` / `supertrendUseAdvancedTrail`.
 * Tiered ST post‑T02: `trailPostT02SpacingFrac` (fraction of entry between T1/T2/… locks; `null` = auto) and `trailPostT02MaxExtraTiers` (depth cap).
 * Fee ladder extras: `trailingStopExtraScalpingPcts` (not shown in the Supertrend block).
 * Internal (no UI): `trailTierSchemaVersion` on position meta for tiered T01/T02 migration.
 *
 * Round-trip fee = openFeeRate + closeFeeRate (what you need to recover to break even).
 *
 * Lock levels (LONG example with openFee=0.04%, closeFee=0.04%, roundTrip=0.08%):
 *   T0 = entry × (1 + roundTrip × feeBeMultiplier)     ← padded breakeven SL
 *   T1 = entry × (1 + 2 × roundTrip)                   ← 2× round-trip profit notch
 *   T2 = entry × (1 + userPct1/100)                    ← user scalp 1
 *   T3 = entry × (1 + userPct2/100)                    ← user scalp 2
 *   T4 = entry × (1 + userPct3/100)                    ← user scalp 3
 */

export function clampFeeRate(r: number): number {
  const x = Number(r);
  if (!Number.isFinite(x) || x < 0) return 0.0004;
  return Math.min(0.01, Math.max(0, x));
}

/** Mirrors `backend/src/lib/trailingStopLoss.js` `computeEffectiveTrailBuffer`. */
export function computeEffectiveTrailBuffer(trailingOpts: {
  bufferRate?: number;
  trailBufferMode?: string;
  trailBufferAtrMult?: number;
  atrPct?: number | null;
}): number {
  const fixedBuf = Number.isFinite(Number(trailingOpts.bufferRate)) ? Number(trailingOpts.bufferRate) : 0.0005;
  const atrMultRaw =
    trailingOpts.trailBufferAtrMult != null && Number.isFinite(Number(trailingOpts.trailBufferAtrMult))
      ? Number(trailingOpts.trailBufferAtrMult)
      : 0;
  const atrMult = Math.max(0, Math.min(1, atrMultRaw));
  const atrPct = Number(trailingOpts.atrPct);
  const bufMode = String(trailingOpts.trailBufferMode ?? "PERCENT").toUpperCase() === "ATR" ? "ATR" : "PERCENT";
  if (bufMode === "ATR" && atrMult > 0 && Number.isFinite(atrPct) && atrPct > 0) {
    return Math.min(0.05, atrPct * atrMult);
  }
  return fixedBuf;
}

/**
 * Matches `backend/src/state/bot.js` default and `FUTURES_TRAIL_FEE_BE_MULT` (1.0).
 * 1.0 ⇒ T02 lock = entry × (1 ± round-trip fee) ⇒ gross = fees, net ≈ 0 (break-even per spec).
 */
export const DEFAULT_TRAIL_FEE_BE_MULTIPLIER = 1.0;

/**
 * Apply optional safety multiplier on top of the round-trip fee.
 * If multiplier = 1.0: exact breakeven (no extra padding).
 * If multiplier = 1.25: 25% safety margin above round-trip (app default when unset).
 */
export function feeRateBreakevenPadded(
  roundTripFeeRate: number,
  multiplier: number = DEFAULT_TRAIL_FEE_BE_MULTIPLIER,
): number {
  const r = clampFeeRate(roundTripFeeRate);
  const m = Number.isFinite(multiplier) && multiplier >= 1 ? Math.min(2, multiplier) : 1.0;
  return Math.min(0.02, r * m);
}

/**
 * T0 SL price — entry + padded round-trip fee.
 * Formula (LONG): entry × (1 + roundTripFeeRate)
 *         (SHORT): entry × (1 − roundTripFeeRate)
 */
export function feeCoverageLockPx(entryPx: number, isLong: boolean, roundTripFeeRate: number): number | null {
  const E = Number(entryPx);
  const r = clampFeeRate(roundTripFeeRate);
  if (!Number.isFinite(E) || E <= 0) return null;
  return isLong ? E * (1 + r) : E * (1 - r);
}

/**
 * T1 SL price — 2× round-trip profit notch above entry.
 * Formula (LONG): entry × (1 + 2 × roundTripFeeRate)
 *         (SHORT): entry × (1 − 2 × roundTripFeeRate)
 */
export function firstScalpingFeeEquivLockPx(entryPx: number, isLong: boolean, roundTripFeeRate: number): number | null {
  const E = Number(entryPx);
  const r = clampFeeRate(roundTripFeeRate);
  if (!Number.isFinite(E) || E <= 0) return null;
  return isLong ? E * (1 + 2 * r) : E * (1 - 2 * r);
}

export function pctOfEntryLockPx(entryPx: number, isLong: boolean, pctOfEntry: number): number | null {
  const E = Number(entryPx);
  const p = Number(pctOfEntry) / 100;
  if (!Number.isFinite(E) || E <= 0 || !Number.isFinite(p) || p <= 0) return null;
  if (isLong) return E * (1 + p);
  return E * (1 - p);
}

export type TrailLockRow = { kind: string; lockPx: number; tierLabel?: string; feeEquivPct?: number; pct?: number };

export function buildTrailLockPrices(
  entryPx: number,
  isLong: boolean,
  /** Legacy single-side fee (close only). Prefer openFeeRate + closeFeeRate for accuracy. */
  feeRate: number,
  extraScalpingPctsOfEntry: number[] = [],
  opts: {
    openFeeRate?: number;
    closeFeeRate?: number;
    roundTripFeeRate?: number;
    feeBeMultiplier?: number;
  } = {},
): TrailLockRow[] {
  const E = Number(entryPx);
  if (!Number.isFinite(E) || E <= 0) return [];

  let roundTripRT: number;
  if (opts.roundTripFeeRate != null && Number.isFinite(opts.roundTripFeeRate)) {
    roundTripRT = clampFeeRate(opts.roundTripFeeRate);
  } else if (opts.openFeeRate != null && opts.closeFeeRate != null) {
    roundTripRT = clampFeeRate(opts.openFeeRate) + clampFeeRate(opts.closeFeeRate);
  } else {
    roundTripRT = 2 * clampFeeRate(feeRate);
  }

  const mult = opts.feeBeMultiplier ?? DEFAULT_TRAIL_FEE_BE_MULTIPLIER;
  const extras = (Array.isArray(extraScalpingPctsOfEntry) ? extraScalpingPctsOfEntry : [])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0)
    // Keep tiers monotonic in favorable excursion (matches backend).
    .sort((a, b) => a - b);

  const out: TrailLockRow[] = [];

  const paddedRT = feeRateBreakevenPadded(roundTripRT, mult);
  const feePx = feeCoverageLockPx(E, isLong, paddedRT);
  if (feePx != null) out.push({ kind: "fee_breakeven", lockPx: feePx, tierLabel: "T0" });

  const fsPx = firstScalpingFeeEquivLockPx(E, isLong, roundTripRT);
  if (fsPx != null) {
    const feeEquivPct = roundTripRT * 100;
    out.push({ kind: "fee_first_scalp", lockPx: fsPx, tierLabel: "T1", feeEquivPct });
  }

  for (let i = 0; i < extras.length; i++) {
    const pct = extras[i]!;
    const px = pctOfEntryLockPx(E, isLong, pct);
    if (px != null) out.push({ kind: "user_scalp", lockPx: px, tierLabel: `T${2 + i}`, pct });
  }

  const eps = E * 1e-10;
  const dedup: TrailLockRow[] = [];
  for (const row of out) {
    const last = dedup[dedup.length - 1];
    if (last && Math.abs(last.lockPx - row.lockPx) <= eps) continue;
    dedup.push(row);
  }
  return dedup; // canonical T0 → T1 → T2+; do not sort by px (breaks tier index vs fee-buffer activation on server)
}

/** Fraction of entry between post‑T02 rung locks when spacing is unset (matches backend). */
export function defaultTieredPostT02SpacingFrac(roundTripFeeRate: number): number {
  const rt = clampFeeRate(roundTripFeeRate);
  return Math.min(0.02, Math.max(rt > 0 ? 2 * rt : 0, 0.0004));
}

/**
 * Synthetic lock ladder: T01 entry, T02 padded BE lock, then equidistant rungs (preview / reference only).
 */
export function buildTieredStEquidistantLockRows(
  entryPx: number,
  isLong: boolean,
  paddedFeeBe: number,
  spacingFrac: number,
  maxRungs = 64,
  t01LockSlippageFrac = 0,
): TrailLockRow[] {
  const E = Number(entryPx);
  const fb = Number(paddedFeeBe);
  const sp = Number(spacingFrac);
  const slip = Math.max(0, Math.min(0.01, Number(t01LockSlippageFrac) || 0));
  if (!Number.isFinite(E) || E <= 0 || !Number.isFinite(fb) || !Number.isFinite(sp) || sp <= 0) return [];
  const t01Lock = isLong ? E * (1 + slip) : E * (1 - slip);
  const t02Lock = isLong ? E * (1 + fb) : E * (1 - fb);
  const out: TrailLockRow[] = [
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

export type SupertrendTieredGateOpts = {
  roundTripFeeRate?: number;
  postT02SpacingFrac?: number | null;
};

export function supertrendTieredActivationGate(
  entryPx: number,
  isLong: boolean,
  paddedFeeRate: number,
  bufferRate: number,
  useFeeBeTrail: boolean,
  stepNow: number,
  levels: TrailLockRow[],
  opts?: SupertrendTieredGateOpts,
): { activationPx: number; activationTierLabel: string | null; nextRow: TrailLockRow | null } {
  const E = Number(entryPx);
  const buf = Number(bufferRate);
  const fb = Number(paddedFeeRate);
  const defaultActivationPx = isLong
    ? E * (1 + (useFeeBeTrail ? fb : 0) + buf)
    : E * (1 - (useFeeBeTrail ? fb : 0) - buf);
  if (!Number.isFinite(E) || E <= 0) {
    return { activationPx: Number.NaN, activationTierLabel: null, nextRow: null };
  }
  if (stepNow <= 0) {
    const t01 = isLong ? E * (1 + buf) : E * (1 - buf);
    const activationPx = useFeeBeTrail ? t01 : defaultActivationPx;
    return { activationPx, activationTierLabel: useFeeBeTrail ? "T01" : "T0", nextRow: null };
  }
  if (stepNow === 1) {
    const t02 = isLong ? E * (1 + fb + buf) : E * (1 - fb - buf);
    return { activationPx: useFeeBeTrail ? t02 : defaultActivationPx, activationTierLabel: useFeeBeTrail ? "T02" : null, nextRow: null };
  }
  if (useFeeBeTrail && stepNow >= 2) {
    const rt = opts?.roundTripFeeRate != null ? Number(opts.roundTripFeeRate) : Number.NaN;
    const spUser = opts?.postT02SpacingFrac != null ? Number(opts.postT02SpacingFrac) : Number.NaN;
    const spacingAbs = E * (Number.isFinite(spUser) && spUser > 0 ? Math.min(0.05, spUser) : defaultTieredPostT02SpacingFrac(rt));
    const k = stepNow - 1;
    const t02Lock = isLong ? E * (1 + fb) : E * (1 - fb);
    const lockPx = isLong ? t02Lock + k * spacingAbs : t02Lock - k * spacingAbs;
    if (!Number.isFinite(lockPx) || lockPx <= 0) {
      return { activationPx: defaultActivationPx, activationTierLabel: `T${stepNow - 1}`, nextRow: null };
    }
    const gatePx =
      Number.isFinite(buf) && buf > 0 ? (isLong ? lockPx * (1 + buf) : lockPx * (1 - buf)) : lockPx;
    return { activationPx: gatePx, activationTierLabel: `T${stepNow - 1}`, nextRow: null };
  }

  const nLv = levels.length;
  if (!nLv) {
    return { activationPx: defaultActivationPx, activationTierLabel: null, nextRow: null };
  }
  if (stepNow >= 2 && stepNow <= nLv) {
    const L = levels[stepNow - 1]!;
    const lockPx = Number(L.lockPx);
    const good = Number.isFinite(lockPx) && lockPx > 0;
    const gatePx = good
      ? (Number.isFinite(buf) && buf > 0
          ? (isLong ? lockPx * (1 + buf) : lockPx * (1 - buf))
          : lockPx)
      : defaultActivationPx;
    return {
      activationPx: gatePx,
      activationTierLabel: L.tierLabel != null ? String(L.tierLabel) : `T${Math.max(1, stepNow - 1)}`,
      nextRow: L,
    };
  }
  const lastDef = levels[nLv - 1]!;
  const prevDef = levels[nLv - 2];
  const interval =
    nLv >= 2 && prevDef && Number.isFinite(Number(prevDef.lockPx))
      ? Math.abs(Number(lastDef.lockPx) - Number(prevDef.lockPx))
      : Math.max(Math.abs(Number(lastDef.lockPx)) * 0.001, Math.abs(Number(lastDef.lockPx) - E));
  const off = stepNow - nLv;
  const activationPx = isLong
    ? Number(lastDef.lockPx) + off * interval
    : Number(lastDef.lockPx) - off * interval;
  return { activationPx, activationTierLabel: `T${stepNow - 1}`, nextRow: null };
}

/** Mirrors `backend/src/lib/trailingStopLoss.js` — price-derived tier index for tiered Supertrend. */
export function computeSupertrendTieredMaxTrailStepFromExtreme(p: {
  hwm: number;
  entryPx: number;
  isLong: boolean;
  feeBe: number;
  bufferRate: number;
  useFeeBeTrail: boolean;
  stLevels: TrailLockRow[];
  roundTripFeeRate?: number;
  postT02SpacingFrac?: number | null;
  maxActivationSteps?: number;
}): number {
  const h = Number(p.hwm);
  const E = Number(p.entryPx);
  const fb = Number(p.feeBe);
  const buf = Number(p.bufferRate);
  if (!Number.isFinite(h) || !Number.isFinite(E) || E <= 0) return 0;
  const levels = Array.isArray(p.stLevels) ? p.stLevels : [];
  const gateOpts: SupertrendTieredGateOpts = {
    roundTripFeeRate: p.roundTripFeeRate,
    postT02SpacingFrac: p.postT02SpacingFrac,
  };
  const cap = Math.max(3, Math.min(600, Math.floor(Number(p.maxActivationSteps) || 200)));
  let step = 0;
  for (let i = 0; i < cap; i++) {
    const { activationPx } = supertrendTieredActivationGate(E, p.isLong, fb, buf, p.useFeeBeTrail, step, levels, gateOpts);
    const ap = Number(activationPx);
    if (!Number.isFinite(ap) || ap <= 0) break;
    const crossed = p.isLong ? h >= ap : h <= ap;
    if (!crossed) break;
    step += 1;
  }
  return step;
}

/** Tiered ST: T01 + T02 + post‑T02 rungs; `extraScalpingPctsOfEntry` ignored (compat); depth from `trailPostT02MaxExtraTiers`. */
export function maxTrailStepsForConfig(
  extraScalpingPctsOfEntry: number[] = [],
  trailPostT02MaxExtraTiers: number = 150,
): number {
  void extraScalpingPctsOfEntry;
  const n = Math.max(10, Math.min(500, Math.floor(Number(trailPostT02MaxExtraTiers) || 150)));
  return 3 + n;
}

/**
 * How many canonical ladder locks (L0, L1, … in order) the stop has consecutively reached.
 * Long: SL has tightened up to each lock; short: SL down to each lock. Stops at first miss (non‑monotonic ladders).
 */
export function trailLadderConsecutiveLocksReached(
  levels: TrailLockRow[],
  stopPx: number,
  isLong: boolean,
  relTol = 1e-6,
): number {
  const sl = Number(stopPx);
  if (!levels.length || !Number.isFinite(sl) || sl <= 0) return 0;
  const absTol = Math.max(sl * relTol, sl * 1e-12);
  let n = 0;
  for (let i = 0; i < levels.length; i++) {
    const L = Number(levels[i]!.lockPx);
    if (!Number.isFinite(L) || L <= 0) break;
    if (isLong) {
      if (sl + absTol >= L) n++;
      else break;
    } else {
      if (sl - absTol <= L) n++;
      else break;
    }
  }
  return n;
}

/** Lock price for tier index `tierIndex` (0 = T0); continuation beyond `levels.length` uses last interval. */
export function extrapolateTrailTierLockPx(
  levels: TrailLockRow[],
  tierIndex: number,
  isLong: boolean,
  entryPx: number,
): number | null {
  const n = levels.length;
  const j = Math.floor(Number(tierIndex));
  if (!Number.isFinite(j) || j < 0 || !Number.isFinite(entryPx) || entryPx <= 0) return null;
  if (j < n) {
    const row = levels[j];
    if (!row) return null;
    const px = Number(row.lockPx);
    return Number.isFinite(px) && px > 0 ? px : null;
  }
  if (n < 1) return null;
  const lastDef = levels[n - 1]!;
  const interval =
    n >= 2
      ? Math.abs(levels[n - 1]!.lockPx - levels[n - 2]!.lockPx)
      : Math.max(Math.abs(lastDef.lockPx) * 0.001, Math.abs(lastDef.lockPx - entryPx));
  if (!(interval > 0)) return null;
  const contSteps = j - (n - 1);
  const contLockPx = isLong ? lastDef.lockPx + contSteps * interval : lastDef.lockPx - contSteps * interval;
  return contLockPx > 0 ? contLockPx : null;
}

export function tierLabelForTrailIndex(levels: TrailLockRow[], tierIndex: number): string {
  const j = Math.floor(Number(tierIndex));
  if (!Number.isFinite(j) || j < 0) return "T?";
  if (j < levels.length) return levels[j]?.tierLabel ?? `T${j}`;
  return `T${j}`;
}

export function advanceTrailingStopState(p: {
  entryPx: number;
  isLong: boolean;
  trailStep: number | null | undefined;
  extremePx: number | null | undefined;
  markPx: number;
  /** Fixed activation margin from each tier lock (fraction). If 0/undefined, activation == lock. */
  activationBufferRate?: number;
  feeRate: number;
  extraScalpingPctsOfEntry: number[];
  openFeeRate?: number;
  closeFeeRate?: number;
  roundTripFeeRate?: number;
  feeBeMultiplier?: number;
}): { trailStep: number; extremePx: number; proposedSl: number | null; activationPx: number | null; advanced: boolean; tierLabel?: string } {
  const E = Number(p.entryPx);
  const mark = Number(p.markPx);
  if (!Number.isFinite(E) || E <= 0 || !Number.isFinite(mark)) {
    return { trailStep: 0, extremePx: Number(p.extremePx) || mark, proposedSl: null, advanced: false };
  }
  const ext0 = Number.isFinite(Number(p.extremePx)) ? Number(p.extremePx) : mark;
  const hwm = p.isLong ? Math.max(ext0, mark) : Math.min(ext0, mark);

  const levels = buildTrailLockPrices(E, p.isLong, p.feeRate, p.extraScalpingPctsOfEntry, {
    openFeeRate: p.openFeeRate,
    closeFeeRate: p.closeFeeRate,
    roundTripFeeRate: p.roundTripFeeRate,
    feeBeMultiplier: p.feeBeMultiplier,
  });
  const n = levels.length;
  if (!n) return { trailStep: Math.floor(Number(p.trailStep)) || 0, extremePx: hwm, proposedSl: null, activationPx: null, advanced: false };

  // Do not clamp step to n — continuation logic needs the real step count
  let step = Math.max(0, Math.floor(Number(p.trailStep) || 0));
  let proposedSl: number | null = null;
  let advanced = false;
  let tierLabel: string | undefined;
  const buf = Number(p.activationBufferRate);
  const bufOk = Number.isFinite(buf) && buf > 0;
  const activationForLock = (lockPx: number) => {
    const L = Number(lockPx);
    if (!Number.isFinite(L) || L <= 0) return L;
    if (!bufOk) return L;
    return p.isLong ? L * (1 + buf) : L * (1 - buf);
  };

  // Phase 1: advance through explicitly defined tiers
  for (let k = step; k < n; k++) {
    const L = levels[k]!;
    const actPx = activationForLock(L.lockPx);
    const crossed = p.isLong ? hwm >= actPx : hwm <= actPx;
    if (!crossed) break;
    step = k + 1;
    proposedSl = L.lockPx;
    tierLabel = L.tierLabel ?? `T${k}`;
    advanced = true;
  }

  // Phase 2: unlimited continuation beyond defined tiers using the last inter-tier interval
  if (step >= n) {
    const lastDef = levels[n - 1]!;
    const interval =
      n >= 2
        ? Math.abs(levels[n - 1]!.lockPx - levels[n - 2]!.lockPx)
        : Math.max(lastDef.lockPx * 0.001, Math.abs(lastDef.lockPx - E));
    if (interval > 0) {
      while (true) {
        const contStepsFromLast = step - (n - 1);
        const contLockPx = p.isLong
          ? lastDef.lockPx + contStepsFromLast * interval
          : lastDef.lockPx - contStepsFromLast * interval;
        if (contLockPx <= 0) break;
        const actPx = activationForLock(contLockPx);
        const crossed = p.isLong ? hwm >= actPx : hwm <= actPx;
        if (!crossed) break;
        step++;
        proposedSl = contLockPx;
        tierLabel = `T${step - 1}`;
        advanced = true;
      }
    }
  }

  const activationPx = proposedSl != null ? activationForLock(proposedSl) : null;
  return { trailStep: step, extremePx: hwm, proposedSl, activationPx, advanced, tierLabel };
}

export function mergeStopWithTrail(isLong: boolean, currentStopPx: number, trailSlPx: number): number | null {
  const cur = Number(currentStopPx);
  const tr = Number(trailSlPx);
  if (!Number.isFinite(tr) || tr <= 0) return Number.isFinite(cur) ? cur : null;
  if (!Number.isFinite(cur) || cur <= 0) return tr;
  if (isLong) return Math.max(cur, tr);
  return Math.min(cur, tr);
}
