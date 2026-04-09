import { roundTo } from "./math.js";
import { tradeCloseFeeUsdtFromNotional, tradeCloseFeeRate } from "./tradeCloseFee.js";

const STABLE_USD = new Set(["USDT", "USDC", "BUSD", "TUSD", "FDUSD"]);

/**
 * Sum Binance spot `fills[].commission` keyed by `commissionAsset`.
 * @param {Array<{ commission?: string, commissionAsset?: string }> | undefined} fills
 * @returns {Record<string, number>}
 */
export function sumCommissionsByAssetFromFills(fills) {
  const byAsset = {};
  if (!Array.isArray(fills)) return byAsset;
  for (const f of fills) {
    const asset = String(f?.commissionAsset ?? "").toUpperCase();
    const c = Number(f?.commission);
    if (!asset || !Number.isFinite(c) || c === 0) continue;
    byAsset[asset] = (byAsset[asset] || 0) + c;
  }
  return byAsset;
}

export function mergeByAsset(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0) continue;
    const kk = String(k).toUpperCase();
    out[kk] = (out[kk] || 0) + n;
  }
  return out;
}

/**
 * Approximate total commissions in USDT (stable fees 1:1; others via SYMBOLUSDT ticker).
 * Returns null if any non-stable asset cannot be priced.
 */
export async function commissionsByAssetToUsdApprox(byAsset, usdtPriceForAsset, log) {
  let usd = 0;
  for (const [asset, amt] of Object.entries(byAsset || {})) {
    const a = String(asset).toUpperCase();
    const n = Number(amt);
    if (!Number.isFinite(n) || n === 0) continue;
    if (STABLE_USD.has(a)) {
      usd += n;
      continue;
    }
    const px = await usdtPriceForAsset(a);
    if (!Number.isFinite(px) || px <= 0) {
      log?.warn?.("binance_fee_usd_unpriced_asset", { asset: a });
      return null;
    }
    usd += n * px;
  }
  return roundTo(usd, 8);
}

/**
 * @param {{ http: { get: Function }, path?: string, log?: { warn?: Function } }} opts
 * @returns {(asset: string) => Promise<number | null>}
 */
export function createUsdtTicker({ http, path, log }) {
  const tickerPath = path || "/v3/ticker/price";
  const cache = new Map();
  const ttlMs = 60_000;
  return async function usdtPriceForAsset(asset) {
    const a = String(asset || "").toUpperCase();
    if (!a) return null;
    if (STABLE_USD.has(a)) return 1;
    const sym = `${a}USDT`;
    const hit = cache.get(sym);
    if (hit && Date.now() - hit.t < ttlMs) return hit.px;
    try {
      const { data } = await http.get(tickerPath, { params: { symbol: sym } });
      const px = Number(data?.price);
      if (!Number.isFinite(px) || px <= 0) return null;
      cache.set(sym, { t: Date.now(), px });
      return px;
    } catch (e) {
      log?.warn?.("binance_ticker_for_fee_failed", { symbol: sym, error: String(e?.message || e) });
      return null;
    }
  };
}

/**
 * Gross / fee / net for a spot round-trip close given modeled entry+exit fees in USDT terms.
 * Unknown fee legs are treated as 0 (conservative net).
 */
export function spotRoundTripPnlWithFees(pos, exitPx, qty, exitFeeUsd) {
  const gross = (Number(exitPx) - Number(pos.entryPrice)) * Number(qty);
  const rate = tradeCloseFeeRate();
  const q = Number(qty);
  const exitPxN = Number(exitPx);
  const entryPxN = Number(pos.entryPrice);

  const entFetched = Number(pos?.spotEntryFeeUsd);
  let ent =
    Number.isFinite(entFetched) && entFetched > 0
      ? entFetched
      : tradeCloseFeeUsdtFromNotional(q, entryPxN, rate) ?? 0;

  const extFetched = Number(exitFeeUsd);
  let ext =
    Number.isFinite(extFetched) && extFetched > 0
      ? extFetched
      : tradeCloseFeeUsdtFromNotional(q, exitPxN, rate) ?? 0;

  const feeSum = ent + ext;
  const net = roundTo(gross - feeSum, 4);
  return {
    grossPnl: roundTo(gross, 4),
    pnl: net,
    fee: roundTo(feeSum, 6),
  };
}
