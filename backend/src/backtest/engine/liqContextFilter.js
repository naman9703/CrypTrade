/**
 * Liquidity sweep context filters — informational data gates at entry (point-in-time).
 * Validated on holdout in research-liq-liquidity-data-edge.mjs (2025).
 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function liqLong(o) {
  return num(o?.coinalyze_liq_long_usd) ?? (num(o?.coinalyze_liq_24h_usd) != null ? o.coinalyze_liq_24h_usd * 0.5 : null);
}

function liqShort(o) {
  return num(o?.coinalyze_liq_short_usd) ?? (num(o?.coinalyze_liq_24h_usd) != null ? o.coinalyze_liq_24h_usd * 0.5 : null);
}

/** Holdout-validated edge bundle (LONG-biased + cascade stand-down). */
export const LIQ_CONTEXT_EDGE_V1 = {
  id: "edge_v1",
  label: "OI cascade skip + long after short-liq day + neg funding for longs",
  passes(isLong, obs) {
    const oi4h = num(obs?.bybit_oi_change_4h);
    if (oi4h != null && oi4h < -0.03) return false;

    if (isLong) {
      const L = liqLong(obs);
      const S = liqShort(obs);
      if (L != null && S != null && !(S > L)) return false;
      const fz = num(obs?.binance_funding_zscore);
      if (fz != null && fz >= 0) return false;
      return true;
    }

    // Shorts: only cascade filter (directional short-liq rule failed holdout)
    return true;
  },
};

/** BTC research bundle — OI cascade skip + short-only funding gate (no long funding veto). */
export const LIQ_CONTEXT_BTC_EDGE = {
  id: "btc_edge",
  label: "BTC: OI cascade skip + skip shorts when funding z ≤ 0",
  passes(isLong, obs) {
    const oi4h = num(obs?.bybit_oi_change_4h);
    if (oi4h != null && oi4h < -0.03) return false;
    if (!isLong) {
      const fz = num(obs?.binance_funding_zscore);
      if (fz != null && fz <= 0) return false;
    }
    return true;
  },
};

export const LIQ_CONTEXT_FILTERS = {
  none: {
    id: "none",
    label: "No context filter",
    passes: () => true,
  },
  edge_v1: LIQ_CONTEXT_EDGE_V1,
  btc_edge: LIQ_CONTEXT_BTC_EDGE,
};

export function passesLiqContextFilter(isLong, obs, filterId = "edge_v1") {
  const f = LIQ_CONTEXT_FILTERS[filterId] ?? LIQ_CONTEXT_FILTERS.none;
  return f.passes(isLong, obs);
}

export function wrapLiquidityMapAdapterWithContext(baseAdapter, candles, obsSeries, filterId = "edge_v1") {
  if (!filterId || filterId === "none") return baseAdapter;
  return function liquidityMapContextAdapter(bar, idx, ctx = {}) {
    const sig = baseAdapter(bar, idx, ctx);
    if (!sig?.action || sig.action === "HOLD" || sig.action === "EXIT") return sig;
    const ts = Number(candles[idx]?.ts);
    if (!ts) return sig;
    const obs = obsSeries?.observableAt ? obsSeries.observableAt(ts) : obsSeries;
    const isLong = sig.action === "BUY";
    if (!passesLiqContextFilter(isLong, obs, filterId)) return null;
    return sig;
  };
}

/** Hook for buildIntradayBacktestAdapter — filter before daily trade counters increment. */
export function buildIntradayContextFilterHook(obsSeries, filterId = "edge_v1") {
  if (!filterId || filterId === "none") return null;
  return (isLong, ts) => {
    if (!ts) return false;
    const obs = obsSeries?.observableAt ? obsSeries.observableAt(ts) : obsSeries;
    return passesLiqContextFilter(isLong, obs, filterId);
  };
}
