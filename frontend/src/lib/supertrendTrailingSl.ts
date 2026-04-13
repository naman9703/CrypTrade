/**
 * Fee-aware Supertrend trailing stop (LONG/SHORT) — mirrors `backend/src/lib/supertrendTrailingSl.js`.
 */

function clampFeeRateLocal(r: number): number {
  const x = Number(r);
  if (!Number.isFinite(x) || x < 0) return 0.0004;
  return Math.min(0.01, Math.max(0, x));
}

export function feeRateBreakevenPadded(feeRate: number): number {
  const r = clampFeeRateLocal(feeRate);
  return Math.min(0.01, r * 1.25);
}

export type SupertrendTrailSlStatus = "OK" | "REJECT_TRADE" | "NO_TRAIL" | "NO_SUPERTREND" | "INVALID";

export function computeSupertrendTrailingSlUpdate(p: {
  entryPrice: number;
  currentPrice: number;
  supertrend: number | null | undefined;
  previousSl: number;
  isLong: boolean;
  leverage: number;
  feeRate?: number;
  bufferRate?: number;
  maintenanceMarginRate?: number;
  minSlDistanceFrac?: number | null;
}): { newSl: number; status: SupertrendTrailSlStatus } {
  const entry = Number(p.entryPrice);
  const cur = Number(p.currentPrice);
  const prevSl = Number(p.previousSl);
  const lev = Number(p.leverage);
  const feeRate = feeRateBreakevenPadded(Number(p.feeRate ?? 0.0008));
  const bufferRate = Number(p.bufferRate ?? 0.0005);
  const maintenanceMarginRate = Number(p.maintenanceMarginRate ?? 0.005);
  const minDist = p.minSlDistanceFrac != null ? Number(p.minSlDistanceFrac) : 0;
  const isLong = Boolean(p.isLong);
  const stRaw = p.supertrend;
  const st = stRaw != null && Number.isFinite(Number(stRaw)) ? Number(stRaw) : null;

  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(cur) || cur <= 0 || !Number.isFinite(prevSl)) {
    return { newSl: prevSl, status: "INVALID" };
  }
  if (!Number.isFinite(lev) || lev < 1) {
    return { newSl: prevSl, status: "INVALID" };
  }

  let breakeven: number;
  let activation: number;
  let liquidation: number;
  if (isLong) {
    breakeven = entry * (1 + feeRate);
    activation = entry * (1 + feeRate + bufferRate);
    liquidation = entry * (1 - 1 / lev + maintenanceMarginRate);
    if (liquidation >= breakeven) {
      return { newSl: prevSl, status: "REJECT_TRADE" };
    }
  } else {
    breakeven = entry * (1 - feeRate);
    activation = entry * (1 - feeRate - bufferRate);
    liquidation = entry * (1 + 1 / lev - maintenanceMarginRate);
    if (liquidation <= breakeven) {
      return { newSl: prevSl, status: "REJECT_TRADE" };
    }
  }

  if (st == null || st <= 0) {
    return { newSl: prevSl, status: "NO_SUPERTREND" };
  }

  let newSl = prevSl;

  if (isLong) {
    if (cur < activation) {
      return { newSl: prevSl, status: "NO_TRAIL" };
    }
    const safeSt = Math.max(st, breakeven);
    newSl = Math.max(prevSl, safeSt);
  } else {
    if (cur > activation) {
      return { newSl: prevSl, status: "NO_TRAIL" };
    }
    const safeSt = Math.min(st, breakeven);
    newSl = Math.min(prevSl, safeSt);
  }

  if (Number.isFinite(minDist) && minDist > 0 && cur > 0) {
    const dist = Math.abs(cur - newSl) / cur;
    if (dist < minDist) {
      newSl = prevSl;
    }
  }

  return { newSl, status: "OK" };
}
