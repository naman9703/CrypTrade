export function feeRateFromBps(feeBps) {
  return Math.max(0, Number(feeBps || 0)) / 10_000;
}

export function slipRateFromBps(slippageBps) {
  return Math.max(0, Number(slippageBps || 0)) / 10_000;
}

export function applySlippage({ side, px, slippageBps }) {
  const p = Number(px);
  if (!Number.isFinite(p) || p <= 0) return p;
  const slip = slipRateFromBps(slippageBps);
  if (side === "BUY") return p * (1 + slip);
  return p * (1 - slip);
}

export function feeForNotional({ notional, feeBps }) {
  const n = Math.abs(Number(notional || 0));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n * feeRateFromBps(feeBps);
}

export function slTpFromAtr({ entry, side, atr, rr, atrFloorPct = 0.006 }) {
  const px = Number(entry);
  const a = Number(atr || 0);
  const stopDist = Math.max(a, px * atrFloorPct);
  // Dynamic R:R when not explicitly supplied (mirrors risk.js logic)
  if (rr == null) {
    const atrPct = stopDist / px;
    rr = atrPct > 0.015 ? 1.2 : atrPct < 0.004 ? 2.5 : 1.6;
  }
  const isLong = side === "BUY";
  const stopLoss = isLong ? px - stopDist : px + stopDist;
  const takeProfit = isLong ? px + stopDist * rr : px - stopDist * rr;
  return { stopLoss, takeProfit };
}

export function pnlWithFeesSlippage({ side, entryPx, exitPx, qty, feeBps, slippageBps }) {
  const isLong = side === "BUY";
  const entryFill = applySlippage({ side: isLong ? "BUY" : "SELL", px: entryPx, slippageBps });
  const exitFill = applySlippage({ side: isLong ? "SELL" : "BUY", px: exitPx, slippageBps });
  const gross = isLong ? (exitFill - entryFill) * qty : (entryFill - exitFill) * qty;
  const entryFee = feeForNotional({ notional: entryFill * qty, feeBps });
  const exitFee = feeForNotional({ notional: exitFill * qty, feeBps });
  return { gross, entryFill, exitFill, entryFee, exitFee, pnl: gross - entryFee - exitFee };
}

