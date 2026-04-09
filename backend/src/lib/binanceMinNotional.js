/**
 * Binance symbol rules: minimum order notional comes from exchangeInfo `filters`
 * (see Spot + USD-M Futures “Exchange Information” docs).
 *
 * - USD-M Futures: `MIN_NOTIONAL` filter — use `notional` (preferred) or legacy `minNotional`.
 * - Spot: `NOTIONAL` and/or legacy `MIN_NOTIONAL` — typically `minNotional` in quote asset.
 *
 * We return the strictest positive value if multiple filters apply.
 */
export function extractMinNotionalFromFilters(filters) {
  const arr = Array.isArray(filters) ? filters : [];
  let best = null;
  for (const f of arr) {
    const t = String(f?.filterType || "");
    if (t !== "MIN_NOTIONAL" && t !== "NOTIONAL") continue;
    const raw = f.notional ?? f.minNotional;
    const n = typeof raw === "string" ? Number(raw) : Number(raw);
    if (!Number.isFinite(n) || n <= 0) continue;
    best = best == null ? n : Math.max(best, n);
  }
  return best;
}
