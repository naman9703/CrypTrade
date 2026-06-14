/**
 * USD-M position notional caps from Binance leverage brackets (shared by live, demo, paper, backtest).
 */

/**
 * Pick notional cap for leverage from bracket rows (same logic as live/demo exchanges).
 * @param {Array<{ initialLeverage?: number, notionalCap?: number }>} brackets
 * @param {number} leverage
 * @returns {number | null}
 */
export function notionalCapFromLeverageBrackets(brackets, leverage) {
  const L = Math.max(1, Math.min(125, Math.floor(Number(leverage) || 1)));
  const br = Array.isArray(brackets) ? brackets : [];
  if (!br.length) return null;
  let best = null;
  let bestD = 1e18;
  for (const b of br) {
    const il = Number(b?.initialLeverage);
    const cap = Number(b?.notionalCap);
    if (!Number.isFinite(il) || !Number.isFinite(cap) || cap <= 0) continue;
    const d = Math.abs(il - L);
    if (d < bestD) {
      bestD = d;
      best = cap;
    }
  }
  return best != null ? Number(best) : null;
}

/**
 * Remaining notional room before Binance max-position-at-leverage.
 * @param {{ qty: number, entryPx: number, capNotional: number, currentNotional?: number }}
 */
export function clampQtyToBracketNotionalCap({ qty, entryPx, capNotional, currentNotional = 0 }) {
  const q = Number(qty);
  const px = Number(entryPx);
  const cap = Number(capNotional);
  const cur = Math.max(0, Number(currentNotional) || 0);
  if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(px) || px <= 0) {
    return { qty: q, capped: false, remainingNotional: null };
  }
  if (!Number.isFinite(cap) || cap <= 0) {
    return { qty: q, capped: false, remainingNotional: null };
  }
  const remaining = Math.max(0, cap - cur);
  const desired = q * px;
  if (desired <= remaining + 1e-8) {
    return { qty: q, capped: false, remainingNotional: remaining };
  }
  const q2 = remaining > 0 ? remaining / px : 0;
  return { qty: q2, capped: true, remainingNotional: remaining };
}

/** Sum abs(positionAmt) * mark for open futures legs on one symbol. */
export function currentFuturesNotionalUsd(positions, symbol, markPx) {
  const sym = String(symbol || "").toUpperCase();
  const px = Number(markPx);
  if (!sym || !Number.isFinite(px) || px <= 0) return 0;
  let sum = 0;
  for (const p of positions || []) {
    if (String(p?.symbol || "").toUpperCase() !== sym) continue;
    if (String(p?.venue || "").toUpperCase() === "SPOT") continue;
    const q = Math.abs(Number(p?.qty ?? p?.positionAmt ?? 0));
    if (q > 0) sum += q * px;
  }
  return sum;
}
