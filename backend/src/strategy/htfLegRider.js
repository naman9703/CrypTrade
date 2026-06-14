/**
 * HTF_LEG_RIDER — 1h EMA trend + 15m Donchian breakout (captures large legs).
 *
 * Complements HTF_RSI (mean-reversion). Enters when price breaks the N-bar
 * range in the direction of the hourly trend with volume confirmation.
 */

import { ema } from "./indicators.js";
import { dirStore } from "./adapterPersisted.js";

const WARMUP = 100;
const DEFAULT_LOOKBACK = 48;
const DEFAULT_MIN_HTF_SEP = 0.0008;
const DEFAULT_VOL_MULT = 1.2;

function aggregateToHourly(candles) {
  if (!candles.length) return [];
  const hourly = [];
  let cur = null;
  for (const c of candles) {
    const hourTs = Math.floor(c.ts / 3600000) * 3600000;
    if (!cur || cur.ts !== hourTs) {
      if (cur) hourly.push(cur);
      cur = {
        ts: hourTs,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: Number(c.volume) || 0,
      };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += Number(c.volume) || 0;
    }
  }
  if (cur) hourly.push(cur);
  return hourly;
}

function hourIndexForBar(barTs, hourly) {
  const hourTs = Math.floor(barTs / 3600000) * 3600000;
  let lo = 0;
  let hi = hourly.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (hourly[mid].ts <= hourTs) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/**
 * @param {Array<{ts:number,open:number,high:number,low:number,close:number,volume?:number}>} candles
 * @param {{ lookback?: number, minHtfSep?: number, volMult?: number }} opts
 */
export function buildHtfLegRiderSignalSeries(candles, opts = {}) {
  const lookback = Number(opts.lookback ?? DEFAULT_LOOKBACK);
  const minSep = Number(opts.minHtfSep ?? DEFAULT_MIN_HTF_SEP);
  const volMult = Number(opts.volMult ?? DEFAULT_VOL_MULT);
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < WARMUP + lookback) return out;

  const hourly = aggregateToHourly(candles);
  if (hourly.length < 55) return out;
  const hCloses = hourly.map((c) => c.close);
  const hEma21 = ema(hCloses, 21);
  const hEma50 = ema(hCloses, 50);
  const volumes = candles.map((c) => Number(c.volume) || 0);

  for (let i = WARMUP + lookback; i < n; i++) {
    const hIdx = hourIndexForBar(candles[i].ts, hourly);
    if (hIdx < 50) continue;
    const e21 = hEma21[hIdx];
    const e50 = hEma50[hIdx];
    if (!Number.isFinite(e21) || !Number.isFinite(e50) || e50 === 0) continue;
    const sep = Math.abs(e21 - e50) / Math.abs(e50);
    if (sep < minSep) continue;
    const htfUp = e21 > e50;
    const htfDown = e21 < e50;

    const slice = candles.slice(i - lookback, i);
    const rangeHigh = Math.max(...slice.map((c) => c.high));
    const rangeLow = Math.min(...slice.map((c) => c.low));
    const bar = candles[i];
    const volSlice = volumes.slice(Math.max(0, i - 20), i);
    const avgVol = volSlice.length ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 0;
    if (avgVol > 0 && volumes[i] < volMult * avgVol) continue;

    if (htfUp && bar.close > rangeHigh && bar.close > bar.open) {
      out[i] = { action: "BUY", reason: "htf_leg_breakout_long" };
    } else if (htfDown && bar.close < rangeLow && bar.close < bar.open) {
      out[i] = { action: "SELL", reason: "htf_leg_breakout_short" };
    }
  }
  return out;
}

export function buildHtfLegRiderBacktestAdapter(candles, opts = {}) {
  const lookback = Number(opts.lookback ?? opts.htfLegRiderLookback ?? DEFAULT_LOOKBACK);
  const series = buildHtfLegRiderSignalSeries(candles, { ...opts, lookback });
  const local = { lastDir: 0 };
  return function htfLegRiderAdapter(bar, idx, ctx) {
    const sig = series[idx];
    if (!sig) return null;
    const d = dirStore(ctx, local);
    if (sig.action === "BUY" && d.lastDir !== 1) {
      d.lastDir = 1;
      return { action: "BUY", reason: sig.reason };
    }
    if (sig.action === "SELL" && d.lastDir !== -1) {
      d.lastDir = -1;
      return { action: "SELL", reason: sig.reason };
    }
    return null;
  };
}

export const HTF_LEG_RIDER = {
  name: "HTF trend + range breakout (ride large legs)",
  signal() {
    return { action: "HOLD", reason: "use_backtest_adapter" };
  },
};
