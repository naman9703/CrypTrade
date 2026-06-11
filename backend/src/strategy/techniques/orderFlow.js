/**
 * Order-flow delta + CVD for intraday SR_INTRADAY / INTRADAY_PRO.
 *
 * Guide alignment (order_flow_complete_guide):
 * - Delta = aggressive buy volume − aggressive sell volume (NOT close-position guess).
 * - CVD = cumulative delta; divergence vs price is a leading exhaustion signal.
 *
 * Data tiers:
 * - aggtrade: bar.buy_volume / bar.sell_volume (live Binance aggTrade multiplex)
 * - taker:    bar.taker_buy_volume vs bar.volume (kline ingest — backtest Tier B)
 * - proxy:    OHLC close-position estimate (Tier C — opt-in via allowProxy)
 */

/** @typedef {'aggtrade'|'taker'|'proxy'|'none'} OrderFlowDataTier */

/**
 * @param {object} bar
 * @param {{ allowProxy?: boolean }} [opts]
 * @returns {{ delta: number, buy: number, sell: number, tier: OrderFlowDataTier }}
 */
export function barDeltaMeta(bar, opts = {}) {
  const buyVol = Number(bar?.buy_volume);
  const sellVol = Number(bar?.sell_volume);
  if (Number.isFinite(buyVol) && Number.isFinite(sellVol) && (buyVol > 0 || sellVol > 0)) {
    return { delta: buyVol - sellVol, buy: buyVol, sell: sellVol, tier: "aggtrade" };
  }

  const takerBuy = Number(bar?.taker_buy_volume);
  const vol = Number(bar?.volume) || 0;
  if (Number.isFinite(takerBuy) && takerBuy >= 0 && vol > 0) {
    const sell = Math.max(0, vol - takerBuy);
    return { delta: takerBuy - sell, buy: takerBuy, sell, tier: "taker" };
  }

  if (opts.allowProxy === false) {
    return { delta: 0, buy: 0, sell: 0, tier: "none" };
  }

  const range = Number(bar?.high) - Number(bar?.low) || 1e-12;
  const buyPct = (Number(bar?.close) - Number(bar?.low)) / range;
  const proxyDelta = vol * (2 * buyPct - 1);
  const proxyBuy = Math.max(0, (vol + proxyDelta) / 2);
  const proxySell = Math.max(0, vol - proxyBuy);
  return { delta: proxyDelta, buy: proxyBuy, sell: proxySell, tier: "proxy" };
}

/** @param {object} bar @param {{ allowProxy?: boolean }} [opts] */
export function barDelta(bar, opts = {}) {
  return barDeltaMeta(bar, opts).delta;
}

/** @param {object[]} candles @param {{ allowProxy?: boolean }} [opts] */
export function buildCvdSeries(candles, opts = {}) {
  const out = new Array(candles.length).fill(0);
  let cvd = 0;
  for (let i = 0; i < candles.length; i++) {
    cvd += barDelta(candles[i], opts);
    out[i] = cvd;
  }
  return out;
}

/** @param {object[]} candles @param {{ allowProxy?: boolean }} [opts] */
export function resolveSeriesDataTier(candles, opts = {}) {
  let agg = 0;
  let taker = 0;
  let proxy = 0;
  for (const c of candles) {
    const t = barDeltaMeta(c, opts).tier;
    if (t === "aggtrade") agg += 1;
    else if (t === "taker") taker += 1;
    else if (t === "proxy") proxy += 1;
  }
  if (agg > 0) return "aggtrade";
  if (taker > candles.length * 0.5) return "taker";
  if (proxy > 0) return "proxy";
  return "none";
}

/** Bullish: CVD rising over lookback; bearish: falling */
export function cvdMomentum(cvdSeries, idx, lookback = 6) {
  if (idx < lookback) return { bullish: false, bearish: false, slope: 0 };
  const now = cvdSeries[idx];
  const prev = cvdSeries[idx - lookback];
  const slope = now - prev;
  return {
    bullish: slope > 0,
    bearish: slope < 0,
    slope,
  };
}

export function deltaImbalance(candles, idx, lookback = 5, opts = {}) {
  let buy = 0;
  let sell = 0;
  for (let i = Math.max(0, idx - lookback + 1); i <= idx; i++) {
    const m = barDeltaMeta(candles[i], opts);
    buy += m.buy;
    sell += m.sell;
  }
  const total = buy + sell || 1;
  return { buyPct: buy / total, sellPct: sell / total, buy, sell };
}
