/**
 * L2 observable information — Open Interest + Funding features for research.
 * Point-in-time lookup only (nearest completed observation ≤ ts).
 */
import { ensureFunding, readFundingRates } from "./fundingIngest.js";
import { ensureOpenInterest, readOpenInterest } from "./openInterestIngest.js";

const FUNDING_Z_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const OI_LOOKBACK_PAD_MS = 48 * 60 * 60 * 1000;

/** Binary search: largest index where arr[i].ts <= ts */
export function nearestBefore(arr, ts, key = "ts") {
  if (!arr?.length) return null;
  let lo = 0;
  let hi = arr.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][key] <= ts) {
      best = arr[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export function computeFundingZ(rows, ts, windowMs = FUNDING_Z_WINDOW_MS) {
  if (!rows?.length) return null;
  const start = ts - windowMs;
  const window = rows.filter((r) => r.ts >= start && r.ts <= ts).map((r) => r.rate);
  if (window.length < 5) return null;
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, window.length - 1);
  const std = Math.sqrt(variance);
  if (std <= 0) return 0;
  const last = window[window.length - 1];
  return (last - mean) / std;
}

export function computeOiChangePct(rows, ts, lookbackMs) {
  if (!rows?.length) return null;
  const now = nearestBefore(rows, ts, "ts");
  const before = nearestBefore(rows, ts - lookbackMs, "ts");
  if (!now || !before || !(now.oiUsdt > 0) || !(before.oiUsdt > 0)) return null;
  return (Number(now.oiUsdt) - Number(before.oiUsdt)) / Number(before.oiUsdt);
}

/**
 * Snapshot L2 features at a single timestamp (no look-ahead).
 * @deprecated Prefer observableFeaturesAt from observableFeatures.js
 */
export { l2FeaturesAt, binanceObservableAt as l2FeaturesAtLegacy } from "./observableFeatures.js";

export function flattenL2Features(features) {
  if (!features) return {};
  return { ...features };
}

/**
 * Backfill + read funding and OI for research window.
 */
export async function ensureL2Data(symbol, fromMs, toMs, { oiPeriod = "1h" } = {}) {
  const padFrom = fromMs - FUNDING_Z_WINDOW_MS - OI_LOOKBACK_PAD_MS;
  const [funding, oi] = await Promise.all([
    ensureFunding(symbol, { from: padFrom, to: toMs }).catch((e) => ({ inserted: 0, error: e.message })),
    ensureOpenInterest(symbol, { from: padFrom, to: toMs, period: oiPeriod }).catch((e) => ({
      inserted: 0,
      error: e.message,
    })),
  ]);
  return { funding, oi };
}

/**
 * Read aligned L2 series (does not backfill).
 */
export async function loadL2Series(symbol, fromMs, toMs) {
  const padFrom = fromMs - FUNDING_Z_WINDOW_MS - OI_LOOKBACK_PAD_MS;
  const [funding, oi] = await Promise.all([
    readFundingRates(symbol, padFrom, toMs).catch(() => []),
    readOpenInterest(symbol, padFrom, toMs).catch(() => []),
  ]);
  return { funding, oi, symbol, fromMs: padFrom, toMs };
}

/**
 * Coverage stats for governance / sync reports.
 */
export function l2CoverageSummary(series, fromMs, toMs) {
  const fundingInRange = (series.funding ?? []).filter((r) => r.ts >= fromMs && r.ts <= toMs);
  const oiInRange = (series.oi ?? []).filter((r) => r.ts >= fromMs && r.ts <= toMs);
  return {
    fundingPoints: fundingInRange.length,
    oiPoints: oiInRange.length,
    fundingSpanMs:
      fundingInRange.length >= 2
        ? fundingInRange[fundingInRange.length - 1].ts - fundingInRange[0].ts
        : 0,
    oiSpanMs: oiInRange.length >= 2 ? oiInRange[oiInRange.length - 1].ts - oiInRange[0].ts : 0,
    oiApiRetentionDays: 30,
    oiNote: "Binance openInterestHist serves last 30 days only; funding has full history",
  };
}
