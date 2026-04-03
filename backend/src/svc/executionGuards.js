import axios from "axios";

/**
 * Best bid/ask spread in basis points vs mid (or last price fallback).
 */
export function spreadBpsFromBook(book, referenceMid) {
  const bids = book?.bids || [];
  const asks = book?.asks || [];
  if (!bids.length || !asks.length) return null;
  const bb = Number(bids[0]?.[0]);
  const ba = Number(asks[0]?.[0]);
  if (!Number.isFinite(bb) || !Number.isFinite(ba) || ba <= bb) return null;
  const mid =
    Number.isFinite(Number(referenceMid)) && Number(referenceMid) > 0
      ? Number(referenceMid)
      : (bb + ba) / 2;
  if (!mid || mid <= 0) return null;
  return ((ba - bb) / mid) * 10000;
}

/**
 * Sum(price * qty) for top N levels on the side we would lift (BUY → asks, SELL → bids).
 */
export function depthNotionalUsd(book, side, levels = 5) {
  const n = Math.max(1, Math.min(20, Number(levels) || 5));
  const lvls = side === "BUY" ? book?.asks || [] : book?.bids || [];
  let sum = 0;
  for (let i = 0; i < Math.min(n, lvls.length); i++) {
    const p = Number(lvls[i]?.[0]);
    const q = Number(lvls[i]?.[1]);
    if (Number.isFinite(p) && Number.isFinite(q)) sum += p * q;
  }
  return sum > 0 ? sum : null;
}

const FUNDING_URL = process.env.BINANCE_FUNDING_REST_URL || "https://fapi.binance.com/fapi/v1/premiumIndex";

/**
 * Last funding rate (decimal per 8h period, e.g. 0.0001 = 0.01%).
 */
export async function fetchBinanceFuturesFundingRate(symbol) {
  const sym = String(symbol || "").toUpperCase();
  if (!sym) return null;
  try {
    const { data } = await axios.get(FUNDING_URL, {
      params: { symbol: sym },
      timeout: Number(process.env.FUNDING_FETCH_TIMEOUT_MS || 5000),
    });
    const r = Number(data?.lastFundingRate);
    return Number.isFinite(r) ? r : null;
  } catch {
    return null;
  }
}

/**
 * Block when funding is extreme against the position (longs pay when rate >> 0).
 * maxAbsRate: e.g. 0.0005 = 0.05% per funding interval.
 */
export function fundingBlocksTrade(side, fundingRate, maxAbsRate) {
  const cap = Number(maxAbsRate);
  if (!Number.isFinite(cap) || cap <= 0) return { ok: true };
  const r = Number(fundingRate);
  if (!Number.isFinite(r)) return { ok: true };
  if (Math.abs(r) < cap) return { ok: true };
  if (side === "BUY" && r > cap) {
    return { ok: false, reason: "funding_extreme_long_pays", rate: r, cap };
  }
  if (side === "SELL" && r < -cap) {
    return { ok: false, reason: "funding_extreme_short_pays", rate: r, cap };
  }
  return { ok: true };
}
