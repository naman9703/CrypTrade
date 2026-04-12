import { formatPriceToTick } from "./binanceFuturesBracketPrices.js";

/**
 * Re-base absolute SL/TP from the anchor used to compute them (e.g. last close) to the actual fill,
 * preserving distances. Long spot BUY: stop below anchor, TP above.
 */
export function reanchorSpotLongSlTpToFill({ anchorPx, filledPx, stopLossPx, takeProfitPx }) {
  const a = Number(anchorPx);
  const f = Number(filledPx);
  const s = Number(stopLossPx);
  const t = Number(takeProfitPx);
  if (!Number.isFinite(a) || !Number.isFinite(f) || a <= 0 || f <= 0 || !Number.isFinite(s) || !Number.isFinite(t)) {
    return { stopLoss: s, takeProfit: t };
  }
  const slDist = a - s;
  const tpDist = t - a;
  if (!(slDist > 0) || !(tpDist > 0)) {
    return { stopLoss: s, takeProfit: t };
  }
  return { stopLoss: f - slDist, takeProfit: f + tpDist };
}

function fmt(px, tickStr, mode) {
  const m = mode === "up" ? "ceil" : "floor";
  return formatPriceToTick(Number(px), { tickSize: String(tickStr ?? "0.01") }, m);
}

/**
 * Binance spot OCO SELL after BUY: limit TP above ref, stop trigger below ref, stopLimit below stop.
 * Uses the same tick math as USD-M brackets so tiny ticks (meme pairs) round safely.
 * Retries with a larger min-move if the first attempt fails after tick rounding.
 */
function ocoOnce({ refPx, takeProfitPx, stopLossPx, tickSize, minMoveFrac }) {
  const ref = Number(refPx);
  let tp = Number(takeProfitPx);
  let stop = Number(stopLossPx);
  const tick = Number(tickSize || 0.01);
  if (!Number.isFinite(ref) || ref <= 0) return null;

  const minMove = Math.max(tick * 3, ref * minMoveFrac);
  if (!Number.isFinite(tp) || tp <= ref) tp = ref + minMove;
  if (!Number.isFinite(stop) || stop >= ref) stop = ref - minMove;

  let stopLimit = stop - Math.max(tick, stop * 0.0002);
  if (stopLimit >= stop) stopLimit = stop - tick;

  const priceStr = fmt(tp, tickSize, "up");
  const stopStr = fmt(stop, tickSize, "down");
  if (!priceStr || !stopStr) return null;

  let stopLimitStr = fmt(stopLimit, tickSize, "down");
  if (!stopLimitStr) return null;

  if (Number(stopLimitStr) >= Number(stopStr)) {
    stopLimitStr = fmt(Number(stopStr) - tick, tickSize, "down");
  }
  if (!stopLimitStr) return null;

  if (Number(priceStr) <= ref || Number(stopStr) >= ref || Number(stopLimitStr) >= Number(stopStr)) return null;
  return { price: priceStr, stopPrice: stopStr, stopLimitPrice: stopLimitStr };
}

export function buildSpotOcoSellPrices(opts) {
  const baseFrac = opts.minMoveFrac != null && Number.isFinite(Number(opts.minMoveFrac)) ? Number(opts.minMoveFrac) : 0.0005;
  const fracs = [baseFrac, 0.002, 0.01, 0.02];
  const seen = new Set();
  for (const minMoveFrac of fracs) {
    if (seen.has(minMoveFrac)) continue;
    seen.add(minMoveFrac);
    const r = ocoOnce({ ...opts, minMoveFrac });
    if (r) return r;
  }
  return null;
}
