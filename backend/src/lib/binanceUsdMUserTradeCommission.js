/**
 * Sum actual Binance USD-M commissions for a single order from `/fapi/v1/userTrades`.
 * Converts BNB fees to USDT using `BNBUSDT` last price when needed.
 *
 * @param {{
 *   signed: (method: string, path: string, params?: Record<string, string>) => Promise<unknown>;
 *   publicGet?: (path: string, params?: Record<string, string>) => Promise<unknown>;
 *   symbol: string;
 *   orderId: string | number | null | undefined;
 *   log?: { warn?: (o: object) => void };
 * }} p
 * @returns {Promise<number|null>} Total commission in USDT terms, or null if unavailable.
 */
/** @param {unknown[]} rows `/fapi/v1/userTrades` rows for one order */
export function makerAllTrueFromUsdMUserTrades(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  let anyFalse = false;
  let anyTrue = false;
  for (const t of rows) {
    if (t?.maker === true) anyTrue = true;
    else if (t?.maker === false) anyFalse = true;
  }
  if (anyFalse) return false;
  if (anyTrue) return true;
  return null;
}

/**
 * Commission USDT sum + maker/taker consensus from fills (`maker` on each fill).
 * @returns {Promise<{ usdt: number; allMaker: boolean | null } | null>}
 */
export async function fetchUsdMOrderCommissionDetails(p) {
  const oid = p.orderId != null && String(p.orderId).trim() !== "" ? String(p.orderId) : "";
  const sym = String(p.symbol || "").toUpperCase();
  if (!oid || !sym || typeof p.signed !== "function") return null;
  let rows;
  try {
    rows = await p.signed("GET", "/fapi/v1/userTrades", {
      symbol: sym,
      orderId: oid,
      limit: "1000",
    });
  } catch (e) {
    p.log?.warn?.({
      msg: "usd_m_user_trades_commission_fetch_failed",
      symbol: sym,
      orderId: oid,
      error: String(e?.message || e),
    });
    return null;
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;

  let usdt = 0;
  let bnb = 0;
  for (const t of rows) {
    const c = Number(t?.commission);
    const asset = String(t?.commissionAsset || "").toUpperCase();
    if (!Number.isFinite(c) || c <= 0) continue;
    if (asset === "USDT") usdt += c;
    else if (asset === "BNB") bnb += c;
  }
  if (bnb > 0 && typeof p.publicGet === "function") {
    try {
      const px = await p.publicGet("/fapi/v1/ticker/price", { symbol: "BNBUSDT" });
      const pr = Number(px?.price);
      if (Number.isFinite(pr) && pr > 0) usdt += bnb * pr;
    } catch {
      /* ignore BNB conversion failure */
    }
  }
  const allMaker = makerAllTrueFromUsdMUserTrades(rows);
  if (!(usdt > 0)) return null;
  return { usdt: Math.round(usdt * 1e8) / 1e8, allMaker };
}

export async function sumCommissionUsdtFromOrderFills(p) {
  const d = await fetchUsdMOrderCommissionDetails(p);
  return d?.usdt ?? null;
}

/**
 * Same as {@link sumCommissionUsdtFromOrderFills}, but retries with delays — fills may not appear in
 * `userTrades` for a short window after the order ACK (especially under load).
 *
 * @param {Parameters<typeof sumCommissionUsdtFromOrderFills>[0]} p
 * @param {{ maxAttempts?: number; delaysMs?: number[] }} [opts]
 */
export async function sumCommissionUsdtFromOrderFillsWithRetry(p, opts = {}) {
  const d = await fetchUsdMOrderCommissionDetailsWithRetry(p, opts);
  return d?.usdt ?? null;
}

/**
 * @returns {Promise<{ usdt: number; allMaker: boolean | null } | null>}
 */
export async function fetchUsdMOrderCommissionDetailsWithRetry(p, opts = {}) {
  const maxAttempts = Math.max(1, Number(opts.maxAttempts ?? 6) || 6);
  const delaysMs = Array.isArray(opts.delaysMs)
    ? opts.delaysMs
    : [0, 75, 175, 400, 850, 1600];
  let last = null;
  for (let i = 0; i < maxAttempts; i++) {
    const d = delaysMs[i] ?? delaysMs[delaysMs.length - 1] ?? 0;
    if (i > 0 && d > 0) await new Promise((r) => setTimeout(r, d));
    last = await fetchUsdMOrderCommissionDetails(p);
    if (last != null && last.usdt > 0) return last;
  }
  return last;
}
