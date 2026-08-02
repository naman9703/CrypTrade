/**
 * When the live Binance WS buffer has a fresh tail but only a few bars, `/market/candles`
 * must backfill from REST — otherwise the UI chart shows a single candle on load (all modes).
 */

import { maxBarsForHistory } from "./chartWindow.js";
import { binanceIntervalMs } from "./supertrendChartAlign.js";

export function chartMinBarsForSnapshot(supertrendPeriod = 10) {
  return Math.max(30, Number(supertrendPeriod ?? 10) + 2);
}

/**
 * Min bars required before trusting the in-memory feed buffer for a chart window.
 * WS alone accumulates ~1 bar/interval — 30 bars passes the old gate while 1m/24h needs ~1440.
 */
export function chartMinBarsForWindow(timeframe, hours = 24, supertrendPeriod = 10) {
  const stMin = chartMinBarsForSnapshot(supertrendPeriod);
  const windowBars = maxBarsForHistory(timeframe, hours);
  const windowMin = Math.max(stMin, Math.floor(windowBars * 0.85));
  return Math.min(windowBars, windowMin);
}

/**
 * True when bar open times are spaced wider than the configured interval (e.g. 15m bars on a 1m chart).
 * Common on the **primary** symbol buffer after a timeframe switch before REST re-seeds.
 */
export function chartBufferSpacingLooksWrong(candles, timeframe) {
  const tf = String(timeframe || "").trim();
  if (!tf || !Array.isArray(candles) || candles.length < 8) return false;
  const tfMs = binanceIntervalMs(tf);
  if (!Number.isFinite(tfMs) || tfMs <= 0) return false;
  const deltas = [];
  const start = Math.max(1, candles.length - 40);
  for (let i = start; i < candles.length; i++) {
    const d = Number(candles[i]?.ts) - Number(candles[i - 1]?.ts);
    if (Number.isFinite(d) && d > 0) deltas.push(d);
  }
  if (deltas.length < 4) return false;
  deltas.sort((a, b) => a - b);
  const med = deltas[Math.floor(deltas.length / 2)];
  return med > tfMs * 1.8;
}

/**
 * @param {unknown[]} candles
 * @param {{ supertrendPeriod?: number, tailStale?: boolean, timeframe?: string, hours?: number }} opts
 */
export function chartSnapshotNeedsRestRepair(candles, opts = {}) {
  const hours = Math.max(0.25, Number(opts.hours ?? 24));
  const minBars =
    opts.timeframe != null && String(opts.timeframe).trim()
      ? chartMinBarsForWindow(opts.timeframe, hours, opts.supertrendPeriod ?? 10)
      : chartMinBarsForSnapshot(opts.supertrendPeriod ?? 10);
  if (!Array.isArray(candles) || candles.length < minBars) return true;
  if (opts.tailStale === true) return true;
  if (opts.timeframe && chartBufferSpacingLooksWrong(candles, opts.timeframe)) return true;
  return false;
}
