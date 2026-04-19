/**
 * Fee-aware, liquidation-aware Supertrend trailing stop (LONG/SHORT).
 * Caller should pass feeRate = openFeeRate + closeFeeRate (round-trip) × optional feeBeMultiplier.
 * Formula: breakeven = entry × (1 + feeRate)  [LONG]
 *          activation = entry × (1 + feeRate + bufferRate)
 */

function clampFeeRateLocal(r) {
  const x = Number(r);
  if (!Number.isFinite(x) || x < 0) return 0.0004;
  return Math.min(0.01, Math.max(0, x));
}

/**
 * Apply optional safety multiplier on top of the round-trip fee rate.
 * Formula: paddedRate = roundTripFeeRate × multiplier
 *          where roundTripFeeRate = openFeeRate + closeFeeRate (caller's responsibility)
 *
 * Used by the T02 lock: T02 SL = entry × (1 ± paddedRate).
 *
 * @param {number} roundTripFeeRate  Full round-trip fee (openFeeRate + closeFeeRate), e.g. 0.0008 = 0.08%
 * @param {number} [multiplier]      Safety margin ×N; 1.0 = exact break-even (gross = fees, net ≈ 0).
 *                                   Raising above 1.0 (e.g. 1.25) over-covers fees to absorb stop-market
 *                                   slippage, at the cost of T02 firing later and T02 gross > fees.
 *                                   Defaults to env `FUTURES_TRAIL_FEE_BE_MULT` (default 1.0 = exact BE per spec).
 */
export function feeRateBreakevenPadded(roundTripFeeRate, multiplier) {
  const r = clampFeeRateLocal(roundTripFeeRate);
  const envMult = Number(process.env.FUTURES_TRAIL_FEE_BE_MULT ?? 1.0);
  const raw = multiplier != null && Number.isFinite(Number(multiplier)) ? Number(multiplier) : envMult;
  const m = Number.isFinite(raw) && raw >= 1 ? Math.min(2, raw) : 1.0;
  return Math.min(0.02, r * m);
}

/**
 * Convert trail step (1-based) to a tier label.
 * @param {number} trailStep
 * @param {"classic" | "tiered_st_fee_entry"} [labelStyle] classic: T0,T1,… (fee ladder / simple ST). tiered_st_fee_entry: T01,T02,T1,… (dual entry + fee gates before Supertrend locks).
 */
export function trailStepToTierLabel(trailStep, labelStyle = "classic") {
  const s = Math.floor(Number(trailStep) || 0);
  if (s < 1) return null;
  if (labelStyle === "tiered_st_fee_entry") {
    if (s === 1) return "T01";
    if (s === 2) return "T02";
    return `T${s - 2}`;
  }
  return `T${s - 1}`;
}

/** Tiered T01/T02 + ST schema; bump when trailStep semantics change (see `migrateTieredTrailLegacySchema`). */
export const TRAIL_TIER_SCHEMA_VERSION = 2;

/**
 * One-time migration for in-memory trail rows opened before T01/T02 split.
 * Legacy: trailStep 1 meant "past single fee-BE gate". New: 1 = T01, 2 = T02, 3+ = ST ladder.
 * Only call when fee-BE + advanced tiered mode is active for this symbol.
 * @param {Record<string, unknown>} tr trailingBySymbol row or paper `pos.meta`-shaped object
 */
export function migrateTieredTrailLegacySchema(tr) {
  if (!tr || typeof tr !== "object") return;
  if (Number(tr.trailTierSchemaVersion) === TRAIL_TIER_SCHEMA_VERSION) return;
  const step = Math.max(0, Math.floor(Number(tr.trailStep) || 0));
  const conf = Math.max(0, Math.floor(Number(tr.confirmedTrailStep) || 0));
  if (step >= 1) tr.trailStep = step + 1;
  if (conf >= 1) tr.confirmedTrailStep = conf + 1;
  tr.trailTierSchemaVersion = TRAIL_TIER_SCHEMA_VERSION;
  tr.trailStepLabelStyle = "tiered_st_fee_entry";
  const sAfter = Math.max(0, Math.floor(Number(tr.trailStep) || 0));
  if (sAfter >= 1) tr.trailTierLabel = trailStepToTierLabel(sAfter, "tiered_st_fee_entry");
}

/**
 * Cap how tight the SL may sit vs current mark: requires |mark − SL| / mark ≥ gapFrac (fraction, e.g. 0.005 = 0.5%).
 * LONG: SL ≤ mark × (1 − gap). SHORT: SL ≥ mark × (1 + gap). Respects fee-BE floor/ceiling when `useFeeBe`.
 */
export function applyMinTrailGapFromMark({ isLong, cur, prevSl, newSl, breakeven, useFeeBe, gapFrac }) {
  const g = Number(gapFrac);
  const sl = Number(newSl);
  const ps = Number(prevSl);
  const c = Number(cur);
  const be = Number(breakeven);
  if (!Number.isFinite(g) || g <= 0 || !Number.isFinite(c) || c <= 0 || !Number.isFinite(sl)) return newSl;
  if (isLong) {
    const cap = c * (1 - g);
    let x = Math.max(ps, Math.min(sl, cap));
    if (useFeeBe && Number.isFinite(be) && be > 0) x = Math.max(x, be);
    return x;
  }
  const floorPx = c * (1 + g);
  let x = Math.min(ps, Math.max(sl, floorPx));
  if (useFeeBe && Number.isFinite(be) && be > 0) x = Math.min(x, be);
  return x;
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
 * @param {number} [p.activationPrice] optional activation override (tier-based gates T1/T2/...)
 * @param {number} [p.breakevenPrice] optional breakeven override
 * @param {number} [p.maintenanceMarginRate]
 * @param {number} [p.minSlDistanceFrac] if set and >0, avoid tightening SL when too close to price (noise)
 * @param {number} [p.minTrailGapFromMarkFrac] if set and >0, SL vs mark must be at least this fraction apart (pullback buffer)
 * @param {boolean} [p.useFeeBreakeven] default true — fee-aware BE floor + activation using `feeRate`
 * @param {boolean} [p.useAdvancedTrail] default true — follow Supertrend line (with BE floor when both on)
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

  let breakeven;
  let activation;
  let liquidation;
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

  /** Fee-BE-only path: ratchet SL to breakeven once mark passes activation (no ST line). */
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
    let trailAnchor;
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
    let trailAnchor;
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
