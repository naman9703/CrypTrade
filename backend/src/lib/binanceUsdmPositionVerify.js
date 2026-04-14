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
