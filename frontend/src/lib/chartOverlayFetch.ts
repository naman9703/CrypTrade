/** Cached economic-calendar + whale overlay payloads for the chart (dedupe + TTL). */

function chartIntervalMs(interval: string): number {
  const s = String(interval ?? "1m").trim().toLowerCase();
  const m = /^(\d+)(m|h|d|w)$/i.exec(s);
  if (!m) return 60_000;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 60_000;
  const u = m[2].toLowerCase();
  if (u === "m") return n * 60_000;
  if (u === "h") return n * 3_600_000;
  if (u === "d") return n * 86_400_000;
  if (u === "w") return n * 7 * 86_400_000;
  return 60_000;
}

export type ChartOverlayEvent = {
  id: string;
  title: string;
  eventTime: string;
  impactLevel: string;
};

export type ChartOverlayWhale = {
  id: string;
  alertedAt: string;
  amountUsd: number | null;
  symbol: string;
};

export type ChartOverlayData = {
  events: ChartOverlayEvent[];
  whales: ChartOverlayWhale[];
};

const EMPTY_OVERLAY: ChartOverlayData = { events: [], whales: [] };
export { EMPTY_OVERLAY };

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; data: ChartOverlayData }>();
const inFlight = new Map<string, Promise<ChartOverlayData>>();

export function chartOverlayFetchKey(fromIso: string, toIso: string, symbol: string): string {
  return `${String(symbol || "").toUpperCase()}|${fromIso}|${toIso}`;
}

export function chartOverlayDataEqual(a: ChartOverlayData, b: ChartOverlayData): boolean {
  if (a.events.length !== b.events.length || a.whales.length !== b.whales.length) return false;
  for (let i = 0; i < a.events.length; i++) {
    const x = a.events[i]!;
    const y = b.events[i]!;
    if (x.id !== y.id || x.eventTime !== y.eventTime || x.title !== y.title || x.impactLevel !== y.impactLevel) {
      return false;
    }
  }
  for (let i = 0; i < a.whales.length; i++) {
    const x = a.whales[i]!;
    const y = b.whales[i]!;
    if (x.id !== y.id || x.alertedAt !== y.alertedAt || x.amountUsd !== y.amountUsd || x.symbol !== y.symbol) {
      return false;
    }
  }
  return true;
}

/** True when OHLC span is too narrow for calendar/whale overlays (avoids useless duplicate fetches). */
export function chartOverlaySpanReady(firstSec: number, lastSec: number, barCount: number): boolean {
  if (!Number.isFinite(firstSec) || !Number.isFinite(lastSec) || firstSec <= 0 || lastSec <= 0) return false;
  if (barCount < 2) return false;
  if (lastSec <= firstSec) return false;
  return true;
}

export async function fetchChartOverlayDeduped(
  key: string,
  loader: () => Promise<ChartOverlayData>,
): Promise<ChartOverlayData> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.data;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const p = loader()
    .then((data) => {
      cache.set(key, { at: Date.now(), data });
      inFlight.delete(key);
      return data;
    })
    .catch((err) => {
      inFlight.delete(key);
      throw err;
    });
  inFlight.set(key, p);
  return p;
}

/** Test helper — reset module cache between unit tests. */
export function resetChartOverlayFetchCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

/** Min bars in WS store before background REST reconcile may skip replacing the buffer. */
const MIN_STORE_BARS_FOR_REST_TAIL_SKIP = 30;

function maxBarsForHistoryLocal(timeframe: string, hours = 24): number {
  const tf = String(timeframe || "1m").toLowerCase().trim();
  const h = Math.max(0.25, Number(hours) || 24);
  const totalMinutes = h * 60;
  const m = /^(\d+)(m|h|d)$/.exec(tf);
  if (!m) return Math.min(3000, Math.ceil(totalMinutes));
  const n = Number(m[1]);
  const u = m[2];
  let bars: number;
  if (u === "m") bars = Math.ceil(totalMinutes / n);
  else if (u === "h") bars = Math.ceil(h / n);
  else bars = Math.ceil(h / (24 * n));
  return Math.min(3000, Math.max(30, bars));
}

function minStoreBarsForChartWindow(timeframe?: string, hours = 24): number {
  if (!timeframe?.trim()) return MIN_STORE_BARS_FOR_REST_TAIL_SKIP;
  const windowBars = maxBarsForHistoryLocal(timeframe, hours);
  return Math.max(MIN_STORE_BARS_FOR_REST_TAIL_SKIP, Math.floor(windowBars * 0.85));
}

export { minStoreBarsForChartWindow };

/**
 * True when bar open times are spaced wider than the chart interval (e.g. 15m bars on a 1m chart).
 * WS primary buffers can retain wrong-interval klines briefly after a timeframe switch.
 */
export function chartBufferSpacingLooksWrong(
  candles: Array<{ ts?: unknown }> | undefined,
  timeframe?: string,
): boolean {
  const tf = String(timeframe || "").trim();
  if (!tf || !Array.isArray(candles) || candles.length < 8) return false;
  const tfMs = chartIntervalMs(tf);
  if (!Number.isFinite(tfMs) || tfMs <= 0) return false;
  const deltas: number[] = [];
  const start = Math.max(1, candles.length - 40);
  for (let i = start; i < candles.length; i++) {
    const d = Number(candles[i]?.ts) - Number(candles[i - 1]?.ts);
    if (Number.isFinite(d) && d > 0) deltas.push(d);
  }
  if (deltas.length < 4) return false;
  deltas.sort((a, b) => a - b);
  const med = deltas[Math.floor(deltas.length / 2)]!;
  return med > tfMs * 1.8;
}

/**
 * True when the buffer cannot paint a full chart window (thin count, internal gaps, or wrong interval).
 * 1m/24h needs ~1224 bars; ~96 WS bars pass spacing checks but still look like sparse dashes.
 */
export function chartBufferCoverageInsufficient(
  candles: Array<{ ts?: unknown }> | undefined,
  timeframe?: string,
  hours = 24,
): boolean {
  if (!Array.isArray(candles) || candles.length === 0) return true;
  const tf = String(timeframe || "").trim();
  if (chartBufferSpacingLooksWrong(candles, tf)) return true;
  const minBars = minStoreBarsForChartWindow(timeframe, hours);
  if (candles.length < minBars) return true;
  const tfMs = chartIntervalMs(tf);
  if (!Number.isFinite(tfMs) || tfMs <= 0) return false;
  const first = Number(candles[0]?.ts);
  const last = Number(candles[candles.length - 1]?.ts);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) return true;
  const spanSlots = Math.floor((last - first) / tfMs) + 1;
  return spanSlots > candles.length * 1.08;
}

/**
 * Background REST reconcile may skip replacing the WS store when tail is current. Initial hydrate,
 * thin buffers, and wrong-interval spacing must always apply REST history.
 */
export function shouldSkipRestCandleReconcile(opts: {
  preserveView: boolean;
  storeBarCount: number;
  storeMatchesView: boolean;
  storeLastTs: number;
  restLastTs: number;
  timeframe?: string;
  hours?: number;
  storeCandles?: Array<{ ts?: unknown }>;
}): boolean {
  if (!opts.preserveView) return false;
  const minBars = minStoreBarsForChartWindow(opts.timeframe, opts.hours ?? 24);
  if (opts.storeBarCount < minBars) return false;
  if (!opts.storeMatchesView || opts.storeBarCount <= 0) return false;
  if (!Number.isFinite(opts.storeLastTs) || !Number.isFinite(opts.restLastTs)) return false;
  if (chartBufferSpacingLooksWrong(opts.storeCandles, opts.timeframe)) return false;
  if (
    Array.isArray(opts.storeCandles) &&
    opts.storeCandles.length > 0 &&
    chartBufferCoverageInsufficient(opts.storeCandles, opts.timeframe, opts.hours ?? 24)
  ) {
    return false;
  }
  return opts.restLastTs <= opts.storeLastTs;
}

/** REST payload materially longer than WS buffer — always merge (live load with fresh 1-bar tail). */
export function restCandleResponseExpandsStore(storeBarCount: number, restBarCount: number): boolean {
  return restBarCount >= Math.max(MIN_STORE_BARS_FOR_REST_TAIL_SKIP, storeBarCount + 5);
}
