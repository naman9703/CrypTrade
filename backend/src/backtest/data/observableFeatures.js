/**
 * Additional observable information — source-prefixed features (no accidental mixing).
 */
import { ensureFunding, readFundingRates } from "./fundingIngest.js";
import { ensureOpenInterest, readOpenInterest } from "./openInterestIngest.js";
import {
  ensureBybitPositioning,
  loadBybitSeries,
} from "./bybitMarketIngest.js";
import {
  ensureCoinalyzeData,
  loadCoinalyzeSeries,
} from "./coinalyzeIngest.js";

export {
  nearestBefore,
  computeFundingZ,
  computeOiChangePct,
} from "./l2Features.js";

import { nearestBefore, computeFundingZ, computeOiChangePct } from "./l2Features.js";

const FUNDING_Z_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const OI_LOOKBACK_PAD_MS = 48 * 60 * 60 * 1000;

function oiChangePct(rows, ts, lookbackMs, valueKey = "oiUsdt") {
  if (!rows?.length) return null;
  const now = nearestBefore(rows, ts, "ts");
  const before = nearestBefore(rows, ts - lookbackMs, "ts");
  const nowV = now?.[valueKey];
  const beforeV = before?.[valueKey];
  if (!now || !before || !(nowV > 0) || !(beforeV > 0)) return null;
  return (Number(nowV) - Number(beforeV)) / Number(beforeV);
}

/** Binance-native funding + OI (OI historical ~30d via API). */
export function binanceObservableAt(series, ts) {
  const fundingRow = nearestBefore(series?.funding ?? [], ts, "ts");
  const oiRow = nearestBefore(series?.oi ?? [], ts, "ts");
  return {
    binance_funding_rate: fundingRow?.rate ?? null,
    binance_funding_zscore: computeFundingZ(series?.funding ?? [], ts),
    binance_oi_usdt: oiRow?.oiUsdt ?? null,
    binance_oi_change_4h: oiChangePct(series?.oi ?? [], ts, 4 * 60 * 60_000),
    binance_oi_change_24h: oiChangePct(series?.oi ?? [], ts, 24 * 60 * 60_000),
    binance_long_short_ratio: oiRow?.longShortRatio ?? null,
    binance_has_funding: fundingRow != null ? 1 : 0,
    binance_has_oi: oiRow != null ? 1 : 0,
  };
}

/** Coinalyze aggregated liquidations + OI. */
export function coinalyzeObservableAt(series, ts) {
  const liqRows = pickCoinalyzeRows(series, "liquidations", "liquidationsDaily", ts);
  const oiRows = pickCoinalyzeRows(series, "oi", "oiDaily", ts);
  const liqRow = nearestBefore(liqRows, ts, "ts");
  const oiRow = nearestBefore(oiRows, ts, "ts");
  const liq4h = sumLiqWindow(liqRows, ts, 4 * 60 * 60_000);
  const liq24h = sumLiqWindow(liqRows, ts, 24 * 60 * 60_000);
  const totalUsd =
    liqRow?.liqTotalUsd ??
    ((Number(liqRow?.liqLongUsd) || 0) + (Number(liqRow?.liqShortUsd) || 0) || null);
  return {
    coinalyze_liq_long_usd: liqRow?.liqLongUsd ?? null,
    coinalyze_liq_short_usd: liqRow?.liqShortUsd ?? null,
    coinalyze_liq_total_usd: totalUsd,
    coinalyze_liq_4h_usd: liq4h.total || null,
    coinalyze_liq_24h_usd: liq24h.total || null,
    coinalyze_oi_usd: oiRow?.oiCloseUsd ?? null,
    coinalyze_oi_change_4h: oiChangePct(oiRows, ts, 4 * 60 * 60_000, "oiCloseUsd"),
    coinalyze_oi_change_24h: oiChangePct(oiRows, ts, 24 * 60 * 60_000, "oiCloseUsd"),
    coinalyze_has_liq: liqRow != null ? 1 : 0,
    coinalyze_has_oi: oiRow != null ? 1 : 0,
  };
}

function pickCoinalyzeRows(series, intradayKey, dailyKey, ts) {
  const recentCutoff = Date.now() - 70 * 86400_000;
  const intra = series?.[intradayKey] ?? [];
  const daily = series?.[dailyKey] ?? [];
  if (ts >= recentCutoff && intra.length) return intra;
  if (daily.length) return daily;
  return intra;
}

function sumLiqWindow(rows, ts, windowMs) {
  const from = ts - windowMs;
  let long = 0;
  let short = 0;
  for (const r of rows) {
    if (r.ts <= from || r.ts > ts) continue;
    long += Number(r.liqLongUsd) || 0;
    short += Number(r.liqShortUsd) || 0;
  }
  return { long, short, total: long + short };
}

export function bybitObservableAt(series, ts) {
  const oiRow = nearestBefore(series?.oi ?? [], ts, "ts");
  const lsrRow = nearestBefore(series?.lsr ?? [], ts, "ts");
  const lsr =
    lsrRow?.longShortRatio ??
    (lsrRow?.buyRatio > 0 && lsrRow?.sellRatio > 0 ? lsrRow.buyRatio / lsrRow.sellRatio : null);
  return {
    bybit_oi_usdt: oiRow?.oiUsdt ?? null,
    bybit_oi_change_4h: oiChangePct(series?.oi ?? [], ts, 4 * 60 * 60_000),
    bybit_oi_change_24h: oiChangePct(series?.oi ?? [], ts, 24 * 60 * 60_000),
    bybit_long_short_ratio: lsr,
    bybit_has_oi: oiRow != null ? 1 : 0,
    bybit_has_lsr: lsrRow != null ? 1 : 0,
  };
}

/**
 * Merge all observable sources at entry timestamp (point-in-time, no look-ahead).
 * @param {{ binance?: object, bybit?: object }} series
 */
export function observableFeaturesAt(series, ts) {
  const out = {};
  if (series?.binance) Object.assign(out, binanceObservableAt(series.binance, ts));
  if (series?.bybit) Object.assign(out, bybitObservableAt(series.bybit, ts));
  if (series?.coinalyze) Object.assign(out, coinalyzeObservableAt(series.coinalyze, ts));
  return out;
}

/** @deprecated Use binanceObservableAt — legacy l2_* aliases for old CSVs */
export function l2FeaturesAt(series, ts) {
  const b = binanceObservableAt(series, ts);
  return {
    ...b,
    l2_funding_rate: b.binance_funding_rate,
    l2_funding_zscore: b.binance_funding_zscore,
    l2_oi_usdt: b.binance_oi_usdt,
    l2_oi_change_4h: b.binance_oi_change_4h,
    l2_oi_change_24h: b.binance_oi_change_24h,
    l2_long_short_ratio: b.binance_long_short_ratio,
    l2_has_funding: b.binance_has_funding,
    l2_has_oi: b.binance_has_oi,
  };
}

export async function ensureBinanceObservable(symbol, fromMs, toMs, { oiPeriod = "1h" } = {}) {
  const padFrom = fromMs - FUNDING_Z_WINDOW_MS - OI_LOOKBACK_PAD_MS;
  const [funding, oi] = await Promise.all([
    ensureFunding(symbol, { from: padFrom, to: toMs }).catch((e) => ({ inserted: 0, error: e.message })),
    ensureOpenInterest(symbol, { from: padFrom, to: toMs, period: oiPeriod }).catch((e) => ({
      inserted: 0,
      error: e.message,
    })),
  ]);
  return { funding, oi, source: "binance" };
}

export async function loadBinanceObservableSeries(symbol, fromMs, toMs) {
  const padFrom = fromMs - FUNDING_Z_WINDOW_MS - OI_LOOKBACK_PAD_MS;
  const [funding, oi] = await Promise.all([
    readFundingRates(symbol, padFrom, toMs).catch(() => []),
    readOpenInterest(symbol, padFrom, toMs).catch(() => []),
  ]);
  return { funding, oi, symbol, source: "binance", fromMs: padFrom, toMs };
}

export async function ensureObservableData(symbol, fromMs, toMs, opts = {}) {
  const padFrom = fromMs - FUNDING_Z_WINDOW_MS - OI_LOOKBACK_PAD_MS;
  const tasks = [
    ensureBinanceObservable(symbol, fromMs, toMs, opts),
    opts.skipBybit
      ? null
      : ensureBybitPositioning(symbol, padFrom, toMs, {
          oiIntervalTime: opts.bybitOiInterval ?? "15min",
          lsrPeriod: opts.bybitLsrPeriod ?? "1h",
        }).catch((e) => ({ error: e.message })),
    opts.skipCoinalyze || !process.env.COINALYZE_API_KEY
      ? null
      : ensureCoinalyzeData(symbol, fromMs, toMs, {
          interval: opts.coinalyzeInterval ?? "1hour",
        }).catch((e) => ({ error: e.message })),
  ];
  const [binance, bybit, coinalyze] = await Promise.all(tasks);
  return { binance, bybit, coinalyze };
}

export async function loadObservableSeries(symbol, fromMs, toMs, opts = {}) {
  const padFrom = fromMs - FUNDING_Z_WINDOW_MS - OI_LOOKBACK_PAD_MS;
  const [binance, bybit, coinalyze] = await Promise.all([
    loadBinanceObservableSeries(symbol, fromMs, toMs),
    opts.skipBybit
      ? null
      : loadBybitSeries(symbol, padFrom, toMs, {
          oiIntervalTime: opts.bybitOiInterval ?? "15min",
          lsrPeriod: opts.bybitLsrPeriod ?? "1h",
        }),
    opts.skipCoinalyze || !process.env.COINALYZE_API_KEY
      ? null
      : loadCoinalyzeSeries(symbol, fromMs, toMs, { interval: opts.coinalyzeInterval ?? "1hour" }),
  ]);
  return { binance, bybit, coinalyze, symbol, fromMs, toMs };
}
