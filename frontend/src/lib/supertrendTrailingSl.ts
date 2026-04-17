/**
 * Fee-aware Supertrend trailing stop (LONG/SHORT) — mirrors `backend/src/lib/supertrendTrailingSl.js`.
 * Caller passes `feeRate` already padded when using fee-BE multiplier (see `feeRateBreakevenPadded` in `trailingFeeLadder.ts`).
 */

export type SupertrendTrailSlStatus = "OK" | "REJECT_TRADE" | "NO_TRAIL" | "NO_SUPERTREND" | "INVALID";

/** Same semantics as backend `trailStepToTierLabel`. */
export function trailStepToTierLabel(
  trailStep: number,
  labelStyle: "classic" | "tiered_st_fee_entry" = "classic",
): string | null {
  const s = Math.floor(Number(trailStep) || 0);
  if (s < 1) return null;
  if (labelStyle === "tiered_st_fee_entry") {
    if (s === 1) return "T01";
    if (s === 2) return "T02";
    return `T${s - 2}`;
  }
  return `T${s - 1}`;
}

/** Mirrors backend — min |mark−SL|/mark (fraction). */
export function applyMinTrailGapFromMark(p: {
  isLong: boolean;
  cur: number;
  prevSl: number;
  newSl: number;
  breakeven: number;
  useFeeBe: boolean;
  gapFrac: number | null | undefined;
}): number {
  const g = Number(p.gapFrac);
  const sl = Number(p.newSl);
  const ps = Number(p.prevSl);
  const c = Number(p.cur);
  const be = Number(p.breakeven);
  if (!Number.isFinite(g) || g <= 0 || !Number.isFinite(c) || c <= 0 || !Number.isFinite(sl)) return p.newSl;
  if (p.isLong) {
    const cap = c * (1 - g);
    let x = Math.max(ps, Math.min(sl, cap));
    if (p.useFeeBe && Number.isFinite(be) && be > 0) x = Math.max(x, be);
    return x;
  }
  const floorPx = c * (1 + g);
  let x = Math.min(ps, Math.max(sl, floorPx));
  if (p.useFeeBe && Number.isFinite(be) && be > 0) x = Math.min(x, be);
  return x;
}

export function computeSupertrendTrailingSlUpdate(p: {
  entryPrice: number;
  currentPrice: number;
  supertrend: number | null | undefined;
  previousSl: number;
  isLong: boolean;
  leverage: number;
  /** Padded round-trip fraction (same as backend `feeBe` passed into compute). */
  feeRate?: number;
  bufferRate?: number;
  maintenanceMarginRate?: number;
  minSlDistanceFrac?: number | null;
  minTrailGapFromMarkFrac?: number | null;
  activationPrice?: number | null;
  breakevenPrice?: number | null;
  useFeeBreakeven?: boolean;
  useAdvancedTrail?: boolean;
}): { newSl: number; status: SupertrendTrailSlStatus } {
  const entry = Number(p.entryPrice);
  const cur = Number(p.currentPrice);
  const prevSl = Number(p.previousSl);
  const lev = Number(p.leverage);
  const feeRate = Number(p.feeRate ?? 0.0008);
  const bufferRate = Number(p.bufferRate ?? 0.0005);
  const maintenanceMarginRate = Number(p.maintenanceMarginRate ?? 0.005);
  const minDist = p.minSlDistanceFrac != null ? Number(p.minSlDistanceFrac) : 0;
  const gapFromMark = p.minTrailGapFromMarkFrac != null ? Number(p.minTrailGapFromMarkFrac) : 0;
  const isLong = Boolean(p.isLong);
  const stRaw = p.supertrend;
  const st = stRaw != null && Number.isFinite(Number(stRaw)) ? Number(stRaw) : null;
  const useFeeBe = p.useFeeBreakeven !== false;
  const useAdv = p.useAdvancedTrail !== false;

  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(cur) || cur <= 0 || !Number.isFinite(prevSl)) {
    return { newSl: prevSl, status: "INVALID" };
  }
  if (!Number.isFinite(lev) || lev < 1) {
    return { newSl: prevSl, status: "INVALID" };
  }
  if (!useFeeBe && !useAdv) {
    return { newSl: prevSl, status: "INVALID" };
  }

  let breakeven: number;
  let activation: number;
  let liquidation: number;
  if (isLong) {
    if (useFeeBe) {
      breakeven = entry * (1 + feeRate);
      activation = entry * (1 + feeRate + bufferRate);
    } else {
      breakeven = entry;
      activation = entry * (1 + bufferRate);
    }
    liquidation = entry * (1 - 1 / lev + maintenanceMarginRate);
    if (liquidation >= breakeven) {
      return { newSl: prevSl, status: "REJECT_TRADE" };
    }
  } else {
    if (useFeeBe) {
      breakeven = entry * (1 - feeRate);
      activation = entry * (1 - feeRate - bufferRate);
    } else {
      breakeven = entry;
      activation = entry * (1 - bufferRate);
    }
    liquidation = entry * (1 + 1 / lev - maintenanceMarginRate);
    if (liquidation <= breakeven) {
      return { newSl: prevSl, status: "REJECT_TRADE" };
    }
  }

  const beOverride = Number(p.breakevenPrice);
  if (Number.isFinite(beOverride) && beOverride > 0) {
    breakeven = beOverride;
  }
  const activationOverride = Number(p.activationPrice);
  if (Number.isFinite(activationOverride) && activationOverride > 0) {
    activation = activationOverride;
  }

  if (useFeeBe && !useAdv) {
    if (isLong) {
      if (cur < activation) return { newSl: prevSl, status: "NO_TRAIL" };
    } else if (cur > activation) {
      return { newSl: prevSl, status: "NO_TRAIL" };
    }
    let newSlOnlyBe = isLong ? Math.max(prevSl, breakeven) : Math.min(prevSl, breakeven);
    newSlOnlyBe = applyMinTrailGapFromMark({
      isLong,
      cur,
      prevSl,
      newSl: newSlOnlyBe,
      breakeven,
      useFeeBe: true,
      gapFrac: gapFromMark,
    });
    if (Number.isFinite(minDist) && minDist > 0 && cur > 0) {
      const dist = Math.abs(cur - newSlOnlyBe) / cur;
      const tightening = isLong ? newSlOnlyBe > prevSl : newSlOnlyBe < prevSl;
      if (dist < minDist && !tightening) newSlOnlyBe = prevSl;
    }
    return { newSl: newSlOnlyBe, status: "OK" };
  }

  if (st == null || st <= 0) {
    return { newSl: prevSl, status: "NO_SUPERTREND" };
  }

  let newSl = prevSl;

  if (isLong) {
    if (cur < activation) {
      return { newSl: prevSl, status: "NO_TRAIL" };
    }
    let trailAnchor: number;
    if (useFeeBe && useAdv) {
      trailAnchor = Math.max(st, breakeven);
    } else {
      trailAnchor = st;
    }
    newSl = Math.max(prevSl, trailAnchor);
  } else {
    if (cur > activation) {
      return { newSl: prevSl, status: "NO_TRAIL" };
    }
    let trailAnchor: number;
    if (useFeeBe && useAdv) {
      trailAnchor = Math.min(st, breakeven);
    } else {
      trailAnchor = st;
    }
    newSl = Math.min(prevSl, trailAnchor);
  }

  newSl = applyMinTrailGapFromMark({
    isLong,
    cur,
    prevSl,
    newSl,
    breakeven,
    useFeeBe,
    gapFrac: gapFromMark,
  });

  if (Number.isFinite(minDist) && minDist > 0 && cur > 0) {
    const dist = Math.abs(cur - newSl) / cur;
    if (dist < minDist) {
      const tightening = isLong ? newSl > prevSl : newSl < prevSl;
      if (!tightening) newSl = prevSl;
    }
  }

  return { newSl, status: "OK" };
}
