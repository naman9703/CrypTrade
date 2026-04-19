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
 * Commission USDT sum + qty-weighted avg fill price + maker/taker consensus from fills.
 * `avgPrice` is the TRUE execution price for the order (sum(price × qty) / sum(qty)) and is what
 * the UI should display in the Exit column — using mark price or SL trigger gives misleading rows
 * (e.g. stop hits filling a few ticks past trigger, limit IOC averaging across two fills).
 *
 * @returns {Promise<{ usdt: number; avgPrice: number | null; filledQty: number; allMaker: boolean | null } | null>}
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
  /** qty-weighted price numerator (Σ price × |qty|) / Σ |qty| — matches exchange avg execution, not mark. */
  let notionalNum = 0;
  let qtySum = 0;
  for (const t of rows) {
    const c = Number(t?.commission);
    const asset = String(t?.commissionAsset || "").toUpperCase();
    if (Number.isFinite(c) && c > 0) {
      if (asset === "USDT") usdt += c;
      else if (asset === "BNB") bnb += c;
    }
    const px = Number(t?.price);
    const q = Math.abs(Number(t?.qty));
    if (Number.isFinite(px) && px > 0 && Number.isFinite(q) && q > 0) {
      notionalNum += px * q;
      qtySum += q;
    }
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
  const avgPrice = qtySum > 0 ? notionalNum / qtySum : null;
  if (!(usdt > 0) && !(qtySum > 0)) return null;
  return {
    usdt: Math.round(usdt * 1e8) / 1e8,
    avgPrice: avgPrice != null && Number.isFinite(avgPrice) ? avgPrice : null,
    filledQty: qtySum,
    allMaker,
  };
}

export async function sumCommissionUsdtFromOrderFills(p) {
  const d = await fetchUsdMOrderCommissionDetails(p);
  return d?.usdt ?? null;
}

/**
 * Fetch a single `/fapi/v1/userTrades` row by its tradeId.
 *
 * REALIZED_PNL income rows carry the underlying `tradeId` but *not* the `orderId`. Without the orderId
 * we can't aggregate per-fill rows back into a single close trade (one reduce-only order often fills
 * in multiple tranId-ed shards) and we can't look up the exchange-authoritative commission. This
 * lookup walks the `tradeId` back to the fill to discover `orderId`, price, qty, and commission so
 * downstream code can (a) merge duplicate shards and (b) replace the notional×rate fee fallback with
 * the real fee Binance charged.
 *
 * @param {{
 *   signed: (method: string, path: string, params?: Record<string, string>) => Promise<unknown>;
 *   publicGet?: (path: string, params?: Record<string, string>) => Promise<unknown>;
 *   symbol: string;
 *   tradeId: string | number;
 *   log?: { warn?: (o: object) => void };
 * }} p
 * @returns {Promise<{
 *   orderId: string | null;
 *   price: number;
 *   qty: number;
 *   commission: number;
 *   commissionAsset: string;
 *   commissionUsdt: number;
 *   side: string;
 *   realizedPnl: number;
 *   maker: boolean;
 *   time: number;
 * } | null>}
 */
export async function fetchUsdMTradeByTradeId(p) {
  const sym = String(p.symbol || "").toUpperCase();
  const tid = p.tradeId != null ? String(p.tradeId).trim() : "";
  if (!sym || !tid || typeof p.signed !== "function") return null;
  let rows;
  try {
    rows = await p.signed("GET", "/fapi/v1/userTrades", {
      symbol: sym,
      fromId: tid,
      limit: "1",
    });
  } catch (e) {
    p.log?.warn?.({
      msg: "usd_m_user_trades_by_id_failed",
      symbol: sym,
      tradeId: tid,
      error: String(e?.message || e),
    });
    return null;
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const r = rows[0];
  if (r == null || String(r.id) !== tid) return null;
  const commission = Number(r.commission);
  const asset = String(r.commissionAsset || "").toUpperCase();
  let commissionUsdt = 0;
  if (Number.isFinite(commission) && commission > 0) {
    if (asset === "USDT") commissionUsdt = commission;
    else if (asset === "BNB" && typeof p.publicGet === "function") {
      try {
        const px = await p.publicGet("/fapi/v1/ticker/price", { symbol: "BNBUSDT" });
        const pr = Number(px?.price);
        if (Number.isFinite(pr) && pr > 0) commissionUsdt = commission * pr;
      } catch {
        /* ignore BNB conversion failure */
      }
    }
  }
  return {
    orderId: r.orderId != null ? String(r.orderId) : null,
    price: Number(r.price),
    qty: Math.abs(Number(r.qty)),
    commission: Number.isFinite(commission) ? commission : 0,
    commissionAsset: asset,
    commissionUsdt,
    side: String(r.side || "").toUpperCase(),
    realizedPnl: Number(r.realizedPnl),
    maker: r.maker === true,
    time: Number(r.time),
  };
}

/**
 * Same as {@link sumCommissionUsdtFromOrderFills}, but retries with delays — fills may not appear in
 * `userTrades` for a short window after the order ACK (especially under load).
 *
 * @param {Parameters<typeof sumCommissionUsdtFromOrderFills>[0]} p
 * @param {{ maxAttempts?: number; delaysMs?: number[] }} [opts]
 */
/**
 * Reconstruct the entering fills behind a CLOSE by walking `/fapi/v1/userTrades` backward from the
 * close timestamp. Used when the bot was not running when the position was opened (so no local OPEN
 * row exists in `mem.trades`) and we still want the Trade History to show a matched open leg with
 * authoritative entry fee + avg fill price — otherwise the Net PnL column silently omits entry
 * commissions.
 *
 * Strategy: pull recent `userTrades` (`endTime = closeFirstFillMs`), skip trades belonging to the
 * close itself (`orderId == closeOrderId`), and accumulate the most recent OPPOSITE-side fills until
 * their absolute qty meets or exceeds `closeQty`. This matches the default one-position-per-symbol
 * workflow; for interleaved round trips it still returns the most recent entry chunk (correct for
 * THIS close).
 *
 * @param {{
 *   signed: (method: string, path: string, params?: Record<string, string>) => Promise<unknown>;
 *   publicGet?: (path: string, params?: Record<string, string>) => Promise<unknown>;
 *   symbol: string;
 *   closeOrderId: string | number | null | undefined;
 *   closeSide: string;
 *   closeQty: number;
 *   closeTimeMs: number;
 *   lookbackMs?: number;
 *   log?: { warn?: (o: object) => void };
 * }} p
 * @returns {Promise<{
 *   entryOrderIds: string[];
 *   avgPrice: number;
 *   qty: number;
 *   commissionUsdt: number;
 *   entrySide: string;
 *   firstFillMs: number;
 *   lastFillMs: number;
 *   allMaker: boolean | null;
 * } | null>}
 */
export async function fetchUsdMEntryTradesForClose(p) {
  const sym = String(p.symbol || "").toUpperCase();
  const closeSide = String(p.closeSide || "").toUpperCase();
  const closeQty = Number(p.closeQty);
  const closeTimeMs = Number(p.closeTimeMs);
  const closeOid = p.closeOrderId != null ? String(p.closeOrderId) : "";
  if (!sym || !(closeQty > 0) || !(closeTimeMs > 0) || typeof p.signed !== "function") return null;
  /** Default 72 h look back keeps the window small enough that `limit=1000` almost always covers it. */
  const lookbackMs = Math.max(60 * 60 * 1000, Number(p.lookbackMs ?? 72 * 60 * 60 * 1000));
  const entrySide = closeSide === "BUY" ? "SELL" : closeSide === "SELL" ? "BUY" : "";
  if (!entrySide) return null;
  let rows;
  try {
    rows = await p.signed("GET", "/fapi/v1/userTrades", {
      symbol: sym,
      startTime: String(Math.max(0, closeTimeMs - lookbackMs)),
      endTime: String(closeTimeMs),
      limit: "1000",
    });
  } catch (e) {
    p.log?.warn?.({
      msg: "usd_m_entry_trades_fetch_failed",
      symbol: sym,
      closeOrderId: closeOid,
      error: String(e?.message || e),
    });
    return null;
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;
  /** Newest first for backward walk — Binance returns oldest first. */
  const sorted = rows.slice().sort((a, b) => Number(b?.time || 0) - Number(a?.time || 0));

  const orderIds = new Set();
  let qtyAcc = 0;
  let notional = 0;
  let feeUsdt = 0;
  let feeBnb = 0;
  let firstMs = 0;
  let lastMs = 0;
  let makerAnyTrue = false;
  let makerAnyFalse = false;
  /** Track same-side (closing) fills encountered before we complete closeQty — they belong to PRIOR
   * reductions on the same position and should offset accumulated entry qty, so we don't attribute
   * an older entry leg to this close. */
  let reduceOffset = 0;
  const EPS = 1e-8;

  for (const r of sorted) {
    const t = Number(r?.time || 0);
    if (!(t > 0) || t >= closeTimeMs) continue;
    if (closeOid && String(r?.orderId) === closeOid) continue;
    const side = String(r?.side || "").toUpperCase();
    const q = Math.abs(Number(r?.qty));
    const px = Number(r?.price);
    if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(px) || px <= 0) continue;
    if (side === closeSide) {
      /** Another reduce order on this symbol — cancels one unit of entry accumulation. */
      reduceOffset += q;
      continue;
    }
    if (side !== entrySide) continue;
    /** Entry fill — but if we have a pending reduceOffset from a later (in wall-clock, earlier in
     * our newest-first walk) reduce, subtract it first before counting toward closeQty. */
    let use = q;
    if (reduceOffset > 0) {
      const off = Math.min(reduceOffset, q);
      reduceOffset -= off;
      use -= off;
    }
    if (use <= 0) continue;
    qtyAcc += use;
    notional += use * px;
    const c = Number(r?.commission);
    const asset = String(r?.commissionAsset || "").toUpperCase();
    if (Number.isFinite(c) && c > 0) {
      /** Scale commission by the used fraction — matters only if we partially consumed this fill. */
      const frac = q > 0 ? use / q : 1;
      if (asset === "USDT") feeUsdt += c * frac;
      else if (asset === "BNB") feeBnb += c * frac;
    }
    if (r?.maker === true) makerAnyTrue = true;
    else if (r?.maker === false) makerAnyFalse = true;
    if (r?.orderId != null) orderIds.add(String(r.orderId));
    if (firstMs === 0 || t < firstMs) firstMs = t;
    if (t > lastMs) lastMs = t;
    if (qtyAcc + EPS >= closeQty) break;
  }
  if (qtyAcc <= 0) return null;
  if (feeBnb > 0 && typeof p.publicGet === "function") {
    try {
      const px = await p.publicGet("/fapi/v1/ticker/price", { symbol: "BNBUSDT" });
      const pr = Number(px?.price);
      if (Number.isFinite(pr) && pr > 0) feeUsdt += feeBnb * pr;
    } catch {
      /* ignore BNB conversion failure */
    }
  }
  const allMaker = makerAnyFalse ? false : makerAnyTrue ? true : null;
  return {
    entryOrderIds: Array.from(orderIds),
    avgPrice: qtyAcc > 0 ? notional / qtyAcc : 0,
    qty: qtyAcc,
    commissionUsdt: Math.round(feeUsdt * 1e8) / 1e8,
    entrySide,
    firstFillMs: firstMs,
    lastFillMs: lastMs,
    allMaker,
  };
}

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

/**
 * When REALIZED_PNL income creates a CLOSE row but the bot has no in-memory OPEN (restart, external
 * entry, or eviction), reconstruct the opening leg from `/fapi/v1/userTrades`: walk fills before the
 * close order, same symbol, opposite side to the close, until qty matches the closing order size.
 *
 * @param {{
 *   signed: (method: string, path: string, params?: Record<string, string>) => Promise<unknown>;
 *   publicGet?: (path: string, params?: Record<string, string>) => Promise<unknown>;
 *   symbol: string;
 *   closeOrderId: string;
 *   closeEventMs: number;
 *   closeSide: string;
 *   closeQty: number;
 *   log?: { warn?: (o: object) => void };
 * }} p
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function synthesizeOpenLegUsdMFromIncomeClose(p) {
  const sym = String(p.symbol || "").toUpperCase();
  const closeOid = String(p.closeOrderId || "").trim();
  const cs = String(p.closeSide || "").toUpperCase();
  if (!sym || !closeOid || (cs !== "BUY" && cs !== "SELL")) return null;
  const openSide = cs === "SELL" ? "BUY" : "SELL";
  const tgt = Math.abs(Number(p.closeQty));
  if (!Number.isFinite(tgt) || tgt <= 0) return null;

  const closeEventMs = Number(p.closeEventMs);
  const endMs = Number.isFinite(closeEventMs) && closeEventMs > 0 ? closeEventMs : Date.now();
  const maxBack = Math.max(
    3600_000,
    Math.min(120 * 86400_000, Number(process.env.BINANCE_USDM_SYNTH_OPEN_LOOKBACK_MS || 30 * 86400_000)),
  );
  const startMs = Math.max(0, endMs - maxBack);

  let rows = [];
  try {
    const r = await p.signed("GET", "/fapi/v1/userTrades", {
      symbol: sym,
      startTime: String(startMs),
      endTime: String(endMs),
      limit: "1000",
    });
    rows = Array.isArray(r) ? r : [];
  } catch (e) {
    p.log?.warn?.({
      msg: "synth_open_user_trades_range_failed",
      symbol: sym,
      error: String(e?.message || e),
    });
    return null;
  }

  const filtered = rows.filter((x) => {
    if (x == null) return false;
    if (String(x.orderId) === closeOid) return false;
    const tm = Number(x.time);
    return Number.isFinite(tm) && tm < endMs;
  });
  filtered.sort((a, b) => Number(b.time) - Number(a.time));

  const picked = [];
  let acc = 0;
  for (const t of filtered) {
    if (String(t.side || "").toUpperCase() !== openSide) continue;
    const q = Math.abs(Number(t.qty));
    if (!Number.isFinite(q) || q <= 0) continue;
    picked.push(t);
    acc += q;
    if (acc >= tgt * 0.999) break;
  }

  if (acc < tgt * 0.85) {
    p.log?.warn?.({
      msg: "synth_open_incomplete_qty",
      symbol: sym,
      closeOrderId: closeOid,
      acc,
      tgt,
    });
    return null;
  }

  picked.sort((a, b) => Number(a.time) - Number(b.time));

  let notional = 0;
  let qtySum = 0;
  let feeUsdt = 0;
  let firstMs = 0;
  const orderIds = new Set();
  for (const t of picked) {
    const px = Number(t.price);
    const q = Math.abs(Number(t.qty));
    if (Number.isFinite(px) && px > 0 && Number.isFinite(q) && q > 0) {
      notional += px * q;
      qtySum += q;
    }
    if (t.orderId != null) orderIds.add(String(t.orderId));
    if (!firstMs && t.time != null) firstMs = Number(t.time);

    const c = Number(t.commission);
    const asset = String(t.commissionAsset || "").toUpperCase();
    if (Number.isFinite(c) && c > 0) {
      if (asset === "USDT") feeUsdt += c;
      else if (asset === "BNB" && typeof p.publicGet === "function") {
        try {
          const pxBnb = await p.publicGet("/fapi/v1/ticker/price", { symbol: "BNBUSDT" });
          const pr = Number(pxBnb?.price);
          if (Number.isFinite(pr) && pr > 0) feeUsdt += c * pr;
        } catch {
          /* ignore */
        }
      }
    }
  }

  const avgPx = qtySum > 0 ? notional / qtySum : 0;
  if (!(avgPx > 0)) return null;

  const primaryOid = picked[0]?.orderId != null ? String(picked[0].orderId) : `multi_${closeOid}`;
  const tsIso = firstMs ? new Date(firstMs).toISOString() : new Date(endMs).toISOString();
  const allMaker = makerAllTrueFromUsdMUserTrades(picked);

  return {
    type: "OPEN",
    id: `synopen_${closeOid}`,
    ts: tsIso,
    symbol: sym,
    side: openSide,
    qty: qtySum,
    price: avgPx,
    strategy: "AUTO",
    fee: Math.round(feeUsdt * 1e8) / 1e8,
    meta: {
      venue: "FUTURES",
      orderId: primaryOid,
      incomeCloseOrderId: closeOid,
      syntheticOpenFromIncome: true,
      entryOrderIds: [...orderIds],
      commissionSource: "fapi_userTrades_synthetic",
      entryAvgFillPrice: avgPx,
      entryPriceSource: "fapi_userTrades_synthetic",
      ...(allMaker != null ? { entryAllMaker: allMaker } : {}),
    },
  };
}
