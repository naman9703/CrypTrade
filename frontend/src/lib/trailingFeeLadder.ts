/**
 * Fee-ladder trailing locks — mirrors `backend/src/lib/trailingStopLoss.js` (feeCoverage → first scalp → % extras).
 */

export function clampFeeRate(r: number): number {
  const x = Number(r);
  if (!Number.isFinite(x) || x < 0) return 0.0004;
  return Math.min(0.01, Math.max(0, x));
}

/** Breakeven-only fee padding — mirrors backend `feeRateBreakevenPadded` (default ×1.25). */
export function feeRateBreakevenPadded(feeRate: number): number {
  const r = clampFeeRate(feeRate);
  return Math.min(0.01, r * 1.25);
}

export function feeCoverageLockPx(entryPx: number, isLong: boolean, feeRate: number): number | null {
  const E = Number(entryPx);
  const r = clampFeeRate(feeRate);
  if (!Number.isFinite(E) || E <= 0) return null;
  if (isLong) return E * (1 + 2 * r);
  return E * (1 - 2 * r);
}

export function firstScalpingFeeEquivLockPx(entryPx: number, isLong: boolean, feeRate: number): number | null {
  const E = Number(entryPx);
  const r = clampFeeRate(feeRate);
  if (!Number.isFinite(E) || E <= 0) return null;
  if (isLong) return E * (1 + 4 * r);
  return E * (1 - 4 * r);
}

export function pctOfEntryLockPx(entryPx: number, isLong: boolean, pctOfEntry: number): number | null {
  const E = Number(entryPx);
  const p = Number(pctOfEntry) / 100;
  if (!Number.isFinite(E) || E <= 0 || !Number.isFinite(p) || p <= 0) return null;
  if (isLong) return E * (1 + p);
  return E * (1 - p);
}

export type TrailLockRow = { kind: string; lockPx: number; feeEquivPct?: number; pct?: number };

export function buildTrailLockPrices(
  entryPx: number,
  isLong: boolean,
  feeRate: number,
  extraScalpingPctsOfEntry: number[] = [],
): TrailLockRow[] {
  const E = Number(entryPx);
  const r = clampFeeRate(feeRate);
  if (!Number.isFinite(E) || E <= 0) return [];

  const extras = (Array.isArray(extraScalpingPctsOfEntry) ? extraScalpingPctsOfEntry : [])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0)
    .slice(0, 3);

  const out: TrailLockRow[] = [];
  const rBe = feeRateBreakevenPadded(r);
  const feePx = feeCoverageLockPx(E, isLong, rBe);
  if (feePx != null) out.push({ kind: "fee_breakeven", lockPx: feePx });

  const fsPx = firstScalpingFeeEquivLockPx(E, isLong, r);
  if (fsPx != null) {
    const feeEquivPct = 2 * r * 100;
    out.push({ kind: "fee_first_scalp", lockPx: fsPx, feeEquivPct });
  }

  for (const pct of extras) {
    const px = pctOfEntryLockPx(E, isLong, pct);
    if (px != null) out.push({ kind: "user_scalp", lockPx: px, pct });
  }

  const eps = E * 1e-10;
  out.sort((a, b) => (isLong ? a.lockPx - b.lockPx : b.lockPx - a.lockPx));
  const dedup: TrailLockRow[] = [];
  for (const row of out) {
    const last = dedup[dedup.length - 1];
    if (last && Math.abs(last.lockPx - row.lockPx) <= eps) continue;
    dedup.push(row);
  }
  return dedup.slice(0, 5);
}

export function advanceTrailingStopState(p: {
  entryPx: number;
  isLong: boolean;
  trailStep: number | null | undefined;
  extremePx: number | null | undefined;
  markPx: number;
  feeRate: number;
  extraScalpingPctsOfEntry: number[];
}): { trailStep: number; extremePx: number; proposedSl: number | null; advanced: boolean } {
  const E = Number(p.entryPx);
  const mark = Number(p.markPx);
  if (!Number.isFinite(E) || E <= 0 || !Number.isFinite(mark)) {
    return { trailStep: 0, extremePx: Number(p.extremePx) || mark, proposedSl: null, advanced: false };
  }
  const ext0 = Number.isFinite(Number(p.extremePx)) ? Number(p.extremePx) : mark;
  const hwm = p.isLong ? Math.max(ext0, mark) : Math.min(ext0, mark);

  const levels = buildTrailLockPrices(E, p.isLong, p.feeRate, p.extraScalpingPctsOfEntry);
  const n = levels.length;
  if (!n) return { trailStep: Math.floor(Number(p.trailStep)) || 0, extremePx: hwm, proposedSl: null, advanced: false };

  let step = Math.max(0, Math.min(n, Math.floor(Number(p.trailStep) || 0)));
  let proposedSl: number | null = null;
  let advanced = false;

  for (let k = step; k < n; k++) {
    const L = levels[k]!;
    const crossed = p.isLong ? hwm >= L.lockPx : hwm <= L.lockPx;
    if (!crossed) break;
    step = k + 1;
    proposedSl = L.lockPx;
    advanced = true;
  }

  return { trailStep: step, extremePx: hwm, proposedSl, advanced };
}

export function mergeStopWithTrail(isLong: boolean, currentStopPx: number, trailSlPx: number): number | null {
  const cur = Number(currentStopPx);
  const tr = Number(trailSlPx);
  if (!Number.isFinite(tr) || tr <= 0) return Number.isFinite(cur) ? cur : null;
  if (!Number.isFinite(cur) || cur <= 0) return tr;
  if (isLong) return Math.max(cur, tr);
  return Math.min(cur, tr);
}
