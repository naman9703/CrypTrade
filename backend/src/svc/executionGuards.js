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

/** Env-driven spread / depth guards (shared by strategy + Supertrend open paths). */
export function readLiquidityGuardConfig(overrides = {}) {
  const tradeSpread = Number(process.env.TRADE_MAX_SPREAD_BPS || 0);
  const tradeDepth = Number(process.env.TRADE_MIN_DEPTH_NOTIONAL_USD || 0);
  const stSpread = Number(process.env.SUPERTREND_MAX_SPREAD_BPS ?? tradeSpread);
  const stDepth = Number(process.env.SUPERTREND_MIN_DEPTH_NOTIONAL_USD ?? tradeDepth);
  return {
    maxSpreadBps: Number(overrides.maxSpreadBps ?? stSpread),
    minDepthUsd: Number(overrides.minDepthUsd ?? stDepth),
    depthLevels: Math.max(1, Math.min(20, Math.floor(Number(overrides.depthLevels ?? process.env.TRADE_DEPTH_LEVELS ?? 5)))),
    /** Block when order notional exceeds this fraction of visible depth (0 = off). */
    maxOrderVsDepthFrac: Number(
      overrides.maxOrderVsDepthFrac ?? process.env.TRADE_MAX_ORDER_VS_DEPTH_FRAC ?? process.env.SUPERTREND_MAX_ORDER_VS_DEPTH_FRAC ?? 0,
    ),
  };
}

/**
 * Spread + depth guards before market entry.
 * @param {{ book: object | null, side: 'BUY'|'SELL', referenceMid: number, orderNotionalUsd?: number, config?: ReturnType<typeof readLiquidityGuardConfig> }}
 */
export function evaluateLiquidityGuards({ book, side, referenceMid, orderNotionalUsd = 0, config }) {
  const cfg = config || readLiquidityGuardConfig();
  const ref = Number(referenceMid);
  const orderN = Number(orderNotionalUsd);

  if (cfg.maxSpreadBps > 0 && book) {
    const sp = spreadBpsFromBook(book, ref);
    if (sp != null && sp > cfg.maxSpreadBps) {
      return {
        ok: false,
        reason: "spread_too_wide",
        spreadBps: sp,
        maxSpreadBps: cfg.maxSpreadBps,
      };
    }
  }

  if (cfg.minDepthUsd > 0 && book) {
    const notion = depthNotionalUsd(book, side, cfg.depthLevels);
    if (notion != null && notion < cfg.minDepthUsd) {
      return {
        ok: false,
        reason: "depth_too_thin",
        depthNotionalUsd: notion,
        minDepthUsd: cfg.minDepthUsd,
      };
    }
    if (cfg.maxOrderVsDepthFrac > 0 && Number.isFinite(orderN) && orderN > 0 && notion != null && notion > 0) {
      const maxOrder = notion * cfg.maxOrderVsDepthFrac;
      if (orderN > maxOrder) {
        return {
          ok: false,
          reason: "order_exceeds_depth",
          depthNotionalUsd: notion,
          orderNotionalUsd: orderN,
          maxOrderVsDepthFrac: cfg.maxOrderVsDepthFrac,
        };
      }
    }
  }

  return { ok: true };
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
