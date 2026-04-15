/**
 * After a USD-M MARKET open (+ SL/TP legs), confirm the account still holds the position.
 * Retries smooth brief API / state lag; returns flat if all attempts show ~0 positionAmt.
 */
export async function verifyUsdMPositionAfterOpen({
  signed,
  symbol,
  retries = 3,
  delayMs = 150,
} = {}) {
  const u = String(symbol || "").toUpperCase();
  let lastAbs = 0;
  for (let i = 0; i < retries; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
    try {
      const a = await signed("GET", "/fapi/v2/account");
      const ps = Array.isArray(a?.positions) ? a.positions : [];
      const p = ps.find((x) => String(x?.symbol || "").toUpperCase() === u);
      lastAbs = Math.abs(Number(p?.positionAmt || 0));
      if (lastAbs > 1e-8) return { ok: true, absAmt: lastAbs };
    } catch {
      /* retry */
    }
  }
  return { ok: false, absAmt: lastAbs };
}

/**
 * Optional second probe after a successful open: SL/TP (or mark) can flatten the leg within
 * milliseconds while the UI still only shows OPEN. Set `BINANCE_USDM_POST_OPEN_STABLE_MS=0` to disable.
 * @returns {number} ms to wait, 0 = off
 */
export function postOpenStableProbeMs() {
  const raw = process.env.BINANCE_USDM_POST_OPEN_STABLE_MS;
  if (raw === "0" || String(raw).toLowerCase() === "false") return 0;
  if (raw === undefined || raw === "") return 350;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(8000, n);
}

/**
 * Synthetic CLOSE when we detect the position went flat right after open (fees still charged on exchange).
 */
export function buildSyntheticImmediateAfterOpenCloseRow({
  symbol,
  symU,
  posId,
  closeSide,
  qtyNum,
  filledPrice,
  exitPx,
  isLong,
  leverage,
  strategy,
}) {
  const fp = Number(filledPrice);
  const ep = Number(exitPx);
  const q = Number(qtyNum);
  let gross = null;
  if (Number.isFinite(fp) && Number.isFinite(ep) && Number.isFinite(q) && q > 0) {
    gross = isLong ? (ep - fp) * q : (fp - ep) * q;
  }
  const id = `fut_imm_${Date.now()}_${String(symU || symbol).replace(/[^A-Z0-9]/g, "")}`;
  return {
    type: "CLOSE",
    id,
    ts: new Date().toISOString(),
    symbol,
    side: closeSide,
    qty: q,
    price: ep,
    entryPrice: fp,
    exitPrice: ep,
    pnl: gross != null && Number.isFinite(gross) ? Number(gross.toFixed(4)) : null,
    grossPnl: gross != null && Number.isFinite(gross) ? Number(gross.toFixed(4)) : null,
    fee: null,
    stopLoss: null,
    takeProfit: null,
    strategy: strategy || "AUTO",
    reason: "IMMEDIATE_FLAT_AFTER_OPEN",
    venue: "FUTURES",
    leverage,
    meta: {
      syntheticImmediateClose: true,
      openPositionId: String(posId),
      closeReason: "IMMEDIATE_FLAT_AFTER_OPEN",
    },
  };
}
