/** Cached economic-calendar + whale overlay payloads for the chart (dedupe + TTL). */

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

/**
 * Background REST reconcile may skip when WS tail is already current. Initial hydrate and thin
 * buffers (e.g. one WS tick before REST returns) must always apply REST history.
 */
export function shouldSkipRestCandleReconcile(opts: {
  preserveView: boolean;
  storeBarCount: number;
  storeMatchesView: boolean;
  storeLastTs: number;
  restLastTs: number;
}): boolean {
  if (!opts.preserveView) return false;
  if (opts.storeBarCount < MIN_STORE_BARS_FOR_REST_TAIL_SKIP) return false;
  if (!opts.storeMatchesView || opts.storeBarCount <= 0) return false;
  if (!Number.isFinite(opts.storeLastTs) || !Number.isFinite(opts.restLastTs)) return false;
  return opts.restLastTs <= opts.storeLastTs;
}

/** REST payload materially longer than WS buffer — always merge (live load with fresh 1-bar tail). */
export function restCandleResponseExpandsStore(storeBarCount: number, restBarCount: number): boolean {
  return restBarCount >= Math.max(MIN_STORE_BARS_FOR_REST_TAIL_SKIP, storeBarCount + 5);
}
