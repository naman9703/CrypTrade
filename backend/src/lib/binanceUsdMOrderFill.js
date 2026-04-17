/**
 * Binance USD-M `POST /fapi/v1/order` sometimes returns `avgPrice` "0" (especially with `newOrderRespType=RESULT`
 * on fast IOC fills). Derive average fill from `cumQuote` / executed size when needed.
 *
 * @param {Record<string, unknown>} out
 * @param {number} fallbackPrice — e.g. signal / last.close used for the order
 */
export function avgFillPriceFromUsdMNewOrder(out, fallbackPrice) {
  const ap = Number(out?.avgPrice);
  if (Number.isFinite(ap) && ap > 0) return ap;
  const ex = Math.max(Number(out?.executedQty ?? 0), Number(out?.cumQty ?? 0));
  const cq = Number(out?.cumQuote);
  if (Number.isFinite(ex) && ex > 0 && Number.isFinite(cq) && cq > 0) return cq / ex;
  const pr = Number(out?.price);
  if (Number.isFinite(pr) && pr > 0) return pr;
  const fb = Number(fallbackPrice);
  return Number.isFinite(fb) && fb > 0 ? fb : 0;
}

/**
 * Fallback SL/TP for `getPositions()` when open-order parsing misses (algo migration) and in-memory maps
 * used a different key casing than `/fapi/v2/account` symbols.
 *
 * @param {Array<{ type?: string, symbol?: string, stopLoss?: unknown, takeProfit?: unknown }>} trades
 * @param {string} symU
 */
export function slTpFromLastOpenTrade(trades, symU) {
  const U = String(symU || "").toUpperCase();
  if (!Array.isArray(trades)) return { sl: null, tp: null };
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    if (t?.type !== "OPEN") continue;
    if (String(t.symbol || "").toUpperCase() !== U) continue;
    const sl = Number(t.stopLoss);
    const tp = Number(t.takeProfit);
    return {
      sl: Number.isFinite(sl) && sl > 0 ? sl : null,
      tp: Number.isFinite(tp) && tp > 0 ? tp : null,
    };
  }
  return { sl: null, tp: null };
}
