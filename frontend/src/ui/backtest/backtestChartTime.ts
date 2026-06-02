import type { UTCTimestamp } from "lightweight-charts";

export type OhlcCandle = { ts: number; open: number; high: number; low: number; close: number };

/** Chart uses real UTC bar times; axis labels format in IST to match the trade table. */
export function formatChartTimeIST(time: UTCTimestamp): string {
  const d = new Date((time as number) * 1000);
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Build chart times aligned 1:1 with candle rows (only bump duplicates). */
export function buildCandleChartSeries(candles: OhlcCandle[]): {
  chartTimesSec: number[];
  indexByTs: Map<number, number>;
} {
  const chartTimesSec: number[] = [];
  const indexByTs = new Map<number, number>();
  let last = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    let t = Math.floor(Number(c.ts) / 1000);
    if (t <= last) t = last + 1;
    last = t;
    chartTimesSec.push(t);
    indexByTs.set(c.ts, i);
  }
  return { chartTimesSec, indexByTs };
}

/**
 * Map trade fill timestamp to the chart time of its OHLC bar (exact open_time match first).
 */
export function chartTimeForTrade(
  iso: string,
  candles: OhlcCandle[],
  chartTimesSec: number[],
  indexByTs: Map<number, number>,
): UTCTimestamp {
  const tms = new Date(iso).getTime();
  const idx = indexByTs.get(tms);
  if (idx != null && chartTimesSec[idx] != null) {
    return chartTimesSec[idx] as UTCTimestamp;
  }
  const rawSec = Math.floor(tms / 1000);
  let lo = 0;
  let hi = chartTimesSec.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chartTimesSec[mid] === rawSec) return rawSec as UTCTimestamp;
    if (chartTimesSec[mid] < rawSec) lo = mid + 1;
    else hi = mid - 1;
  }
  let bestIdx = 0;
  let bestDist = Math.abs(candles[0].ts - tms);
  for (let i = 1; i < candles.length; i++) {
    const d = Math.abs(candles[i].ts - tms);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return chartTimesSec[bestIdx] as UTCTimestamp;
}

/** lightweight-charts requires strictly ascending unique times per series. */
export function nextChartTime(candidateSec: number, lastSec: number): UTCTimestamp {
  const t = Math.floor(candidateSec);
  const next = t <= lastSec ? lastSec + 1 : t;
  return next as UTCTimestamp;
}

/** Nearest bar index for a candle open_time (ms). */
export function barIndexForMs(candles: OhlcCandle[], tsMs: number): number {
  if (!candles.length) return 0;
  let idx = candles.findIndex((c) => c.ts === tsMs);
  if (idx >= 0) return idx;
  let best = 0;
  let bestD = Math.abs(candles[0].ts - tsMs);
  for (let i = 1; i < candles.length; i++) {
    const d = Math.abs(candles[i].ts - tsMs);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export function barAtTradeTime(
  iso: string,
  candles: OhlcCandle[],
  indexByTs: Map<number, number>,
): OhlcCandle | null {
  const tms = new Date(iso).getTime();
  const idx = indexByTs.get(tms);
  if (idx != null) return candles[idx] ?? null;
  const i = candles.findIndex((c) => c.ts >= tms);
  return i >= 0 ? candles[i] : null;
}

export function exitInsideBar(
  direction: string,
  exitPrice: number,
  bar: OhlcCandle | null,
): boolean {
  if (!bar || !Number.isFinite(exitPrice)) return true;
  const lo = Math.min(bar.low, bar.high);
  const hi = Math.max(bar.low, bar.high);
  return exitPrice >= lo - 1e-6 && exitPrice <= hi + 1e-6;
}
