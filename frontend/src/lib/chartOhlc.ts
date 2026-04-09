import type { UTCTimestamp } from "lightweight-charts";
import { isPlausibleCandleClose } from "./symbolPriceSanity";
import type { StCandle } from "./supertrend";

export type OhlcBar = { time: UTCTimestamp; open: number; high: number; low: number; close: number };

/** Drop bars whose close is orders of magnitude off the series median (common when streams mix symbols). */
function rejectOhlcMedianOutliers(dedup: OhlcBar[]): OhlcBar[] {
  const closes = dedup.map((b) => b.close).filter((x) => Number.isFinite(x) && x > 0);
  if (closes.length < 4) return dedup;
  const sorted = [...closes].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  /** Tighter ratio for liquid high-priced pairs so a single ~587 fat-finger cannot sit next to ~66k. */
  const wide = med > 10_000 ? 50 : med > 100 ? 100 : 400;
  const lo = med / wide;
  const hi = med * wide;
  return dedup.filter(
    (b) =>
      Number.isFinite(b.close) &&
      b.close >= lo &&
      b.close <= hi &&
      Number.isFinite(b.low) &&
      b.low >= lo / 50 &&
      Number.isFinite(b.high) &&
      b.high <= hi * 1.5,
  );
}

export function buildOhlc(
  candles: Array<{ ts: number; open: number; high: number; low: number; close: number }>,
  opts?: { symbol?: string },
): OhlcBar[] {
  const sym = opts?.symbol?.trim() ?? "";
  const out: OhlcBar[] = [];
  let prevClose: number | null = null;
  for (const c of candles) {
    const ts = Number(c.ts);
    const t = Number.isFinite(ts) ? (Math.floor(ts / 1000) as UTCTimestamp) : null;
    const open = Number(c.open);
    let high = Number(c.high);
    let low = Number(c.low);
    const close = Number(c.close);
    if (t == null || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
      continue;
    }
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;
    high = Math.max(high, open, close);
    low = Math.min(low, open, close);
    if (high < low) continue;
    if (sym && !isPlausibleCandleClose(sym, close, low, prevClose)) continue;
    out.push({ time: t, open, high, low, close });
    prevClose = close;
  }
  out.sort((a, b) => a.time - b.time);
  const dedup: OhlcBar[] = [];
  for (const bar of out) {
    if (dedup.length && dedup[dedup.length - 1].time === bar.time) dedup[dedup.length - 1] = bar;
    else dedup.push(bar);
  }
  return rejectOhlcMedianOutliers(dedup);
}

export function ohlcBarsToMsCandles(ohlc: OhlcBar[]): StCandle[] {
  return ohlc.map((b) => ({
    ts: Number(b.time) * 1000,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
  }));
}

/**
 * Strict checks before lightweight-charts `update()` — bad ticks cause vertical spikes / scale blowups.
 */
export function isOhlcBarRenderable(bar: OhlcBar, prev: OhlcBar | null, symbol: string): boolean {
  const o = bar.open;
  const h = bar.high;
  const l = bar.low;
  const c = bar.close;
  if (![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) return false;
  const hh = Math.max(h, o, c);
  const ll = Math.min(l, o, c);
  if (hh < ll) return false;
  const prevClose = prev != null && Number.isFinite(prev.close) ? prev.close : null;
  const sym = symbol.trim();
  if (sym && !isPlausibleCandleClose(sym, c, ll, prevClose)) return false;
  const bodyMin = Math.min(o, c);
  const bodyMax = Math.max(o, c);
  if (bodyMin > 10 && ll < bodyMin * 1e-6) return false;
  if (bodyMax > 10 && hh > bodyMax * 250) return false;
  return true;
}
