/**
 * MICRO_EVENT historical replay hydration — liq + CVD (aggTrades) + funding + OI + macro.
 * Book imbalance has no historical L2 source — left null by design.
 */
import axios from "axios";
import { readAggTrades, ensureAggTradesForWindow } from "../../backtest/data/visionTickIngest.js";
import { fetchFundingHistory } from "../../backtest/data/fundingIngest.js";
import { getActiveMicroEventCalendarWindows } from "./microEventCalendar.js";

const FAPI = process.env.BINANCE_FUTURES_REST_BASE || "https://fapi.binance.com";

function normSym(symbol) {
  return String(symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/** @param {{ ts: number, price: number, qty?: number|null, isBuyerMaker?: boolean }[]} trades */
function lowerBoundTs(trades, ts) {
  let lo = 0;
  let hi = trades.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Number(trades[mid].ts) < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function sumAggWindow(trades, windowMs, endMs) {
  const cutoff = endMs - windowMs;
  const start = lowerBoundTs(trades, cutoff);
  let buyUsd = 0;
  let sellUsd = 0;
  for (let i = start; i < trades.length; i++) {
    const t = trades[i];
    const ts = Number(t.ts);
    if (ts > endMs) break;
    const px = Number(t.price);
    const qty = Number(t.qty ?? 0);
    if (!(px > 0) || !(qty > 0)) continue;
    const notional = px * qty;
    if (t.isBuyerMaker === true) sellUsd += notional;
    else buyUsd += notional;
  }
  return { buyUsd, sellUsd, cvdUsd: buyUsd - sellUsd };
}

function cvdSlopeFromTrades(trades, windowMs, endMs) {
  const half = windowMs / 2;
  const recent = sumAggWindow(trades, half, endMs);
  const priorEnd = endMs - half;
  const prior = sumAggWindow(trades, half, priorEnd);
  return recent.cvdUsd - prior.cvdUsd;
}

/** @param {{ ts: number, rate: number }[]} fundingRates */
export function fundingMetricsAtTs(fundingRates, tsMs) {
  const prior = (fundingRates ?? []).filter((r) => Number(r.ts) <= tsMs);
  if (!prior.length) return { fundingRate: null, fundingZ: null, crowdedSide: "neutral" };
  const current = prior[prior.length - 1].rate;
  const window = prior.slice(-90).map((r) => r.rate);
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const std = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length);
  const z = std > 0 ? (current - mean) / std : 0;
  let bias = "neutral";
  if (current > mean * 2) bias = "extremely_long";
  else if (current > mean * 1.5) bias = "crowded_long";
  else if (current < mean * -1) bias = "crowded_short";
  return { fundingRate: current, fundingZ: z, crowdedSide: bias };
}

/**
 * Binance openInterestHist — limited rolling window (~500 bars).
 * @returns {Promise<{ series: { ts: number, oi: number }[], availableFromMs: number|null }>}
 */
export async function fetchOpenInterestHistSeries(symbol, period = "5m", limit = 500) {
  const sym = normSym(symbol);
  try {
    const { data } = await axios.get(`${FAPI}/futures/data/openInterestHist`, {
      params: { symbol: sym, period, limit },
      timeout: 15_000,
    });
    if (!Array.isArray(data) || !data.length) return { series: [], availableFromMs: null };
    const series = data
      .map((row) => ({
        ts: Number(row.timestamp),
        oi: Number(row.sumOpenInterest ?? row.openInterest ?? 0),
      }))
      .filter((r) => Number.isFinite(r.ts) && r.oi > 0)
      .sort((a, b) => a.ts - b.ts);
    return {
      series,
      availableFromMs: series.length ? series[0].ts : null,
    };
  } catch {
    return { series: [], availableFromMs: null };
  }
}

function oiAtOrBefore(series, tsMs) {
  let best = null;
  for (const row of series ?? []) {
    if (row.ts <= tsMs) best = row;
    else break;
  }
  return best;
}

export function oiDeltaPct(series, tsMs, windowMs) {
  const recent = oiAtOrBefore(series, tsMs);
  const prior = oiAtOrBefore(series, tsMs - windowMs);
  if (!recent || !prior || !(prior.oi > 0)) return null;
  return ((recent.oi - prior.oi) / prior.oi) * 100;
}

/**
 * Build per-bar microstructure fields for backtest adapter lookup.
 * @param {number} tsMs
 * @param {object} ctx
 */
export function buildBacktestSnapshotFields(tsMs, ctx) {
  const {
    symbol,
    liqTicks = [],
    liqWindowSec = 90,
    domRatio = 1.2,
    cascadeQuietSec = 900,
    aggTrades = [],
    fundingRates = [],
    oiSeries = [],
    oiAvailableFromMs = null,
  } = ctx;

  const windowMs = liqWindowSec * 1000;
  const quietMs = Math.max(60_000, Number(cascadeQuietSec) * 1000 || 900_000);
  const cutoff = tsMs - windowMs;
  let longUsd = 0;
  let shortUsd = 0;
  let extremeLong = -Infinity;
  let extremeShort = Infinity;
  for (const t of liqTicks) {
    const time = Number(t.time ?? t.ts);
    if (time < cutoff || time > tsMs) continue;
    const px = Number(t.price);
    if (t.side === "SELL") {
      longUsd += Number(t.notionalUsd) || 0;
      if (px > 0) extremeLong = Math.max(extremeLong, px);
    } else {
      shortUsd += Number(t.notionalUsd) || 0;
      if (px > 0) extremeShort = Math.min(extremeShort, px);
    }
  }
  const totalUsd = longUsd + shortUsd;
  let dom = "neutral";
  if (longUsd > shortUsd * domRatio) dom = "longs";
  else if (shortUsd > longUsd * domRatio) dom = "shorts";
  const liqExtremePrice =
    dom === "longs" && Number.isFinite(extremeLong)
      ? extremeLong
      : dom === "shorts" && Number.isFinite(extremeShort)
        ? extremeShort
        : null;

  const priorTicks = liqTicks.filter((t) => {
    const time = Number(t.time ?? t.ts);
    return time >= tsMs - windowMs * 2 && time < tsMs - windowMs;
  });
  let pLong = 0;
  let pShort = 0;
  for (const t of priorTicks) {
    if (t.side === "SELL") pLong += Number(t.notionalUsd) || 0;
    else pShort += Number(t.notionalUsd) || 0;
  }
  const priorTotal = pLong + pShort;
  const liqZLike = priorTotal > 0 ? totalUsd / priorTotal : totalUsd > 0 ? 2 : 0;

  /** Prior lookback: max 1m bucket USD — blocks re-entry after a large minute already fired. */
  let liqQuietPriorUsd = 0;
  let liqQuietPriorMaxBarUsd = 0;
  const quietFrom = tsMs - windowMs - quietMs;
  const quietTo = tsMs - windowMs;
  const quietBuckets = new Map();
  for (const t of liqTicks) {
    const time = Number(t.time ?? t.ts);
    if (time < quietFrom || time >= quietTo) continue;
    const usd = Number(t.notionalUsd) || 0;
    liqQuietPriorUsd += usd;
    const bucket = Math.floor(time / 60_000) * 60_000;
    quietBuckets.set(bucket, (quietBuckets.get(bucket) || 0) + usd);
  }
  for (const v of quietBuckets.values()) {
    if (v > liqQuietPriorMaxBarUsd) liqQuietPriorMaxBarUsd = v;
  }

  const w60 = sumAggWindow(aggTrades, 60_000, tsMs);
  const funding = fundingMetricsAtTs(fundingRates, tsMs);
  const calendarEvents = getActiveMicroEventCalendarWindows(tsMs, symbol);

  const oiRow = oiAtOrBefore(oiSeries, tsMs);
  const oiGateExcluded = oiAvailableFromMs != null && tsMs < oiAvailableFromMs;

  return {
    liqLongUsd: longUsd,
    liqShortUsd: shortUsd,
    liqTotalUsd: totalUsd,
    liqRateUsdPerMin: windowMs > 0 ? (totalUsd / windowMs) * 60_000 : 0,
    liqDom: dom,
    liqZLike,
    liqExtremePrice,
    liqQuietPriorUsd,
    liqQuietPriorMaxBarUsd,
    lastLiqTickMs: tsMs,
    oi: oiRow?.oi ?? null,
    oiDeltaPct1m: oiGateExcluded ? null : oiDeltaPct(oiSeries, tsMs, 60_000),
    oiDeltaPct5m: oiGateExcluded ? null : oiDeltaPct(oiSeries, tsMs, 300_000),
    oiGateExcluded,
    bookImbalance: null,
    bidWallUsd: null,
    askWallUsd: null,
    cvdUsd60s: w60.cvdUsd,
    aggressiveBuyUsd60s: w60.buyUsd,
    aggressiveSellUsd60s: w60.sellUsd,
    cvdSlope60s: cvdSlopeFromTrades(aggTrades, 60_000, tsMs),
    fundingRate: funding.fundingRate,
    fundingZ: funding.fundingZ,
    crowdedSide: funding.crowdedSide,
    calendarActive: calendarEvents.length > 0,
    calendarEvents,
    bookGateExcluded: true,
  };
}

/**
 * @param {string} symbol
 * @param {number} fromMs
 * @param {number} toMs
 * @param {object} [cfg]
 */
export async function hydrateMicroEventBacktestContext(symbol, fromMs, toMs, cfg = {}) {
  const sym = normSym(symbol);
  const liqWindowSec = Number(cfg.microEventLiqWindowSec ?? 90);
  const domRatio = Number(cfg.microEventLiqDomRatio ?? 1.2);
  const cascadeQuietSec = Number(cfg.microEventCascadeQuietSec ?? 900);

  const { readRecentForceOrders } = await import("../../intelligence/collectors/forceOrderPersist.js");
  const { aggregateTicksToLiqSeries } = await import("../liqCascadeIntraday.js");

  const liqTicks = await readRecentForceOrders(sym, fromMs, toMs);
  // Sparse 1m buckets (no zero-pad) — empty minutes must not trigger O(aggTrades) snapshot work.
  const liqSeries = aggregateTicksToLiqSeries(liqTicks, 60_000);

  let aggTrades = [];
  let aggTradeCount = 0;
  try {
    await ensureAggTradesForWindow(sym, fromMs, toMs);
    aggTrades = await readAggTrades(sym, fromMs, toMs);
    aggTradeCount = aggTrades.length;
  } catch {
    aggTrades = [];
  }

  let fundingRates = [];
  try {
    const { readFundingRates, ensureFunding } = await import("../../backtest/data/fundingIngest.js");
    fundingRates = await readFundingRates(sym, fromMs, toMs);
    if (!fundingRates.length) {
      await ensureFunding(sym, { from: fromMs, to: toMs }).catch(() => {});
      fundingRates = await readFundingRates(sym, fromMs, toMs);
    }
    if (!fundingRates.length) {
      fundingRates = await fetchFundingHistory(sym, fromMs, toMs);
    }
  } catch {
    fundingRates = [];
  }

  const { series: oiSeries, availableFromMs: oiAvailableFromMs } = await fetchOpenInterestHistSeries(sym, "5m", 500);

  return {
    liqSeries,
    liqTicks,
    tickCount: liqTicks.length,
    aggTrades,
    aggTradeCount,
    fundingRates,
    oiSeries,
    oiAvailableFromMs,
    oiGateExcludedBeforeMs: oiAvailableFromMs,
    bookGateExcluded: true,
    hydrationMeta: {
      liqWindowSec,
      domRatio,
      cascadeQuietSec,
      symbol: sym,
      cvdSource: aggTradeCount > 0 ? "futures_agg_trades" : "missing",
      fundingSource: fundingRates.length ? "historical_funding_rates" : "missing",
      oiSource: oiSeries.length ? "openInterestHist_5m" : "missing",
      bookSource: "live_only_no_l2_history",
    },
  };
}
