/**
 * Fee-ladder trailing locks — mirrors `backend/src/lib/trailingStopLoss.js`.
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

/**
 * Apply optional safety multiplier on top of the round-trip fee.
 * If multiplier = 1.0 (default): exact breakeven.
 * If multiplier = 1.25: 25% safety margin above round-trip.
 */
export function feeRateBreakevenPadded(roundTripFeeRate: number, multiplier = 1.0): number {
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

  const mult = opts.feeBeMultiplier ?? 1.0;
  const extras = (Array.isArray(extraScalpingPctsOfEntry) ? extraScalpingPctsOfEntry : [])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0);

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
  out.sort((a, b) => (isLong ? a.lockPx - b.lockPx : b.lockPx - a.lockPx));
  const dedup: TrailLockRow[] = [];
  for (const row of out) {
    const last = dedup[dedup.length - 1];
    if (last && Math.abs(last.lockPx - row.lockPx) <= eps) continue;
    dedup.push(row);
  }
  return dedup; // no artificial tier cap — unlimited advancement via continuation
}

export function advanceTrailingStopState(p: {
  entryPx: number;
  isLong: boolean;
  trailStep: number | null | undefined;
  extremePx: number | null | undefined;
  markPx: number;
  feeRate: number;
  extraScalpingPctsOfEntry: number[];
  openFeeRate?: number;
  closeFeeRate?: number;
  roundTripFeeRate?: number;
  feeBeMultiplier?: number;
}): { trailStep: number; extremePx: number; proposedSl: number | null; advanced: boolean; tierLabel?: string } {
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
  if (!n) return { trailStep: Math.floor(Number(p.trailStep)) || 0, extremePx: hwm, proposedSl: null, advanced: false };

  // Do not clamp step to n — continuation logic needs the real step count
  let step = Math.max(0, Math.floor(Number(p.trailStep) || 0));
  let proposedSl: number | null = null;
  let advanced = false;
  let tierLabel: string | undefined;

  // Phase 1: advance through explicitly defined tiers
  for (let k = step; k < n; k++) {
    const L = levels[k]!;
    const crossed = p.isLong ? hwm >= L.lockPx : hwm <= L.lockPx;
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
        const crossed = p.isLong ? hwm >= contLockPx : hwm <= contLockPx;
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

export function mergeStopWithTrail(isLong: boolean, currentStopPx: number, trailSlPx: number): number | null {
  const cur = Number(currentStopPx);
  const tr = Number(trailSlPx);
  if (!Number.isFinite(tr) || tr <= 0) return Number.isFinite(cur) ? cur : null;
  if (!Number.isFinite(cur) || cur <= 0) return tr;
  if (isLong) return Math.max(cur, tr);
  return Math.min(cur, tr);
}
