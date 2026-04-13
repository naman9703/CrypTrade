/**
 * Fee-aware, liquidation-aware Supertrend trailing stop (LONG/SHORT).
 * Breakeven uses one-way fee_rate (same as TRADE_CLOSE_FEE_RATE convention).
 */

function clampFeeRateLocal(r) {
  const x = Number(r);
  if (!Number.isFinite(x) || x < 0) return 0.0004;
  return Math.min(0.01, Math.max(0, x));
}

/**
 * Slightly tighter fee assumption for breakeven activation (~0.08% → ~0.1% style margin). See `FUTURES_TRAIL_FEE_BE_MULT`.
 */
export function feeRateBreakevenPadded(feeRate) {
  const r = clampFeeRateLocal(feeRate);
  const mult = Number(process.env.FUTURES_TRAIL_FEE_BE_MULT ?? 1.25);
  const m = Number.isFinite(mult) && mult >= 1 ? Math.min(2, mult) : 1.25;
  return Math.min(0.01, r * m);
}

/**
 * @param {object} p
 * @param {number} p.entryPrice
 * @param {number} p.currentPrice
 * @param {number | null | undefined} p.supertrend
 * @param {number} p.previousSl
 * @param {boolean} p.isLong
 * @param {number} p.leverage
 * @param {number} [p.feeRate]
 * @param {number} [p.bufferRate]
 * @param {number} [p.maintenanceMarginRate]
 * @param {number} [p.minSlDistanceFrac] if set and >0, avoid tightening SL when too close to price (noise)
 * @returns {{ newSl: number, status: "OK" | "REJECT_TRADE" | "NO_TRAIL" | "NO_SUPERTREND" | "INVALID" }}
 */
export function computeSupertrendTrailingSlUpdate(p) {
  const entry = Number(p.entryPrice);
  const cur = Number(p.currentPrice);
  const prevSl = Number(p.previousSl);
  const lev = Number(p.leverage);
  const feeRate = Number(p.feeRate ?? 0.0008);
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

  let breakeven;
  let activation;
  let liquidation;
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

/**
 * Pre-trade: reject if liquidation (approx) crosses fee breakeven (invalid geometry for this model).
 * @param {object} p
 * @param {number} p.entryPrice
 * @param {boolean} p.isLong
 * @param {number} p.leverage
 * @param {number} [p.feeRate]
 * @param {number} [p.maintenanceMarginRate]
 * @returns {boolean} true if trade should be rejected
 */
export function entryRejectedLiquidationBreakeven(p) {
  const entry = Number(p.entryPrice);
  const lev = Number(p.leverage);
  const fee = feeRateBreakevenPadded(Number(p.feeRate ?? 0.0008));
  const mm = Number(p.maintenanceMarginRate ?? 0.005);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(lev) || lev < 1) return true;
  if (p.isLong) {
    const breakeven = entry * (1 + fee);
    const liquidation = entry * (1 - 1 / lev + mm);
    return liquidation >= breakeven;
  }
  const breakeven = entry * (1 - fee);
  const liquidation = entry * (1 + 1 / lev - mm);
  return liquidation <= breakeven;
}
