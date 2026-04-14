/**
 * Classify SL vs TP from Binance conditional order type strings.
 * @param {string} typ
 * @returns {"tp"|"sl"|null}
 */
function classifyConditionalOrderType(typ) {
  const t = String(typ || "").toUpperCase();
  if (!t) return null;
  if (t.includes("TAKE_PROFIT")) return "tp";
  if (t.includes("TRAILING")) return null;
  if (t.includes("STOP_LOSS")) return "sl";
  if (t.includes("STOP") && !t.includes("TAKE")) return "sl";
  return null;
}

/**
 * Parse SL/TP trigger prices from Binance USD-M GET /fapi/v1/openOrders rows.
 * Uses `origType` when present; trigger from `stopPrice`, then `activatePrice` (trailing).
 */
export function slTpFromOpenOrdersList(all) {
  const map = new Map();
  for (const o of Array.isArray(all) ? all : []) {
    const s = String(o.symbol || "").toUpperCase();
    if (!s) continue;
    if (!map.has(s)) map.set(s, { sl: null, tp: null });
    const typ = String(o.origType || o.orderType || o.type || "");
    let trig = Number(o.stopPrice);
    if (!Number.isFinite(trig) || trig <= 0) trig = Number(o.activatePrice);
    if (!Number.isFinite(trig) || trig <= 0) trig = Number(o.triggerPrice);
    if (!Number.isFinite(trig) || trig <= 0) continue;
    const row = map.get(s);
    const kind = classifyConditionalOrderType(typ);
    if (kind === "tp") row.tp = trig;
    else if (kind === "sl") row.sl = trig;
  }
  return map;
}

export function normalizeAlgoOrdersPayload(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const inner =
      raw.orders ??
      raw.data ??
      raw.rows ??
      raw.result ??
      raw.orderList ??
      raw.algoOrders ??
      raw.openOrders;
    if (Array.isArray(inner)) return inner;
  }
  return [];
}

/**
 * Parse SL/TP from GET /fapi/v1/openAlgoOrders (CONDITIONAL orders after Algo Service migration).
 * Rows use `orderType`, `triggerPrice` (not `stopPrice` on classic openOrders).
 */
export function slTpFromAlgoOrdersList(raw) {
  const map = new Map();
  const all = normalizeAlgoOrdersPayload(raw);
  for (const o of all) {
    const s = String(o.symbol || "").toUpperCase();
    if (!s) continue;
    if (!map.has(s)) map.set(s, { sl: null, tp: null });
    const typ = String(o.orderType || o.origType || o.type || "");
    let trig = Number(o.triggerPrice);
    if (!Number.isFinite(trig) || trig <= 0) trig = Number(o.stopPrice);
    if (!Number.isFinite(trig) || trig <= 0) trig = Number(o.activatePrice);
    const row = map.get(s);
    const tpsl = Number(o.tpTriggerPrice);
    const slsl = Number(o.slTriggerPrice);
    if (Number.isFinite(trig) && trig > 0) {
      const kind = classifyConditionalOrderType(typ);
      if (kind === "tp") row.tp = trig;
      else if (kind === "sl") row.sl = trig;
    }
    if (Number.isFinite(tpsl) && tpsl > 0) row.tp = tpsl;
    if (Number.isFinite(slsl) && slsl > 0) row.sl = slsl;
  }
  return map;
}

/** Merge per-symbol SL/TP maps; non-null values from `overlay` win. */
export function mergeSlTpSymbolMaps(base, overlay) {
  const out = new Map(base);
  for (const [k, v] of overlay) {
    if (!out.has(k)) out.set(k, { sl: null, tp: null });
    const row = out.get(k);
    if (v.sl != null) row.sl = v.sl;
    if (v.tp != null) row.tp = v.tp;
  }
  return out;
}
