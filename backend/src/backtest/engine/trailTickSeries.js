/**
 * Build ordered tick series for trailing tick audit (mark + aggTrade hybrid).
 */

const DEFAULT_DOWNSAMPLE_MS = 250;
const DEFAULT_MAX_TICKS = 500_000;

/**
 * @param {Array<{ ts: number, open: number, high: number, low: number, close: number }>} markBars
 * @returns {Map<number, { ts: number, open: number, high: number, low: number, close: number }>}
 */
export function indexMarkBarsByMinute(markBars) {
  const byTs = new Map();
  for (const b of markBars ?? []) {
    const ts = Math.floor(Number(b.ts) / 60_000) * 60_000;
    if (!Number.isFinite(ts)) continue;
    byTs.set(ts, {
      ts,
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
    });
  }
  return byTs;
}

/**
 * Forward-fill mark close for a timestamp.
 * @param {Map<number, object>} markByMinute
 * @param {number} ts
 * @returns {number|null}
 */
export function markCloseAtTs(markByMinute, ts) {
  const t = Number(ts);
  if (!Number.isFinite(t)) return null;
  const minute = Math.floor(t / 60_000) * 60_000;
  let bar = markByMinute.get(minute);
  if (bar) return Number(bar.close);
  const keys = [...markByMinute.keys()].sort((a, b) => a - b);
  let last = null;
  for (const k of keys) {
    if (k > minute) break;
    last = markByMinute.get(k);
  }
  return last ? Number(last.close) : null;
}

/**
 * @param {Array<{ ts: number, price: number }>} aggTrades
 * @param {Map<number, object>} markByMinute
 * @param {'hybrid'|'aggTrade_proxy'} [mode]
 * @returns {Array<{ ts: number, markPx: number, tradePx: number|null, source: string }>}
 */
export function buildHybridTickSeries(aggTrades, markByMinute, mode = "hybrid") {
  const out = [];
  for (const t of aggTrades ?? []) {
    const ts = Number(t.ts);
    const tradePx = Number(t.price);
    if (!Number.isFinite(ts) || !Number.isFinite(tradePx) || tradePx <= 0) continue;
    const markPx =
      mode === "aggTrade_proxy" ? tradePx : (markCloseAtTs(markByMinute, ts) ?? tradePx);
    if (!Number.isFinite(markPx) || markPx <= 0) continue;
    out.push({
      ts,
      markPx,
      tradePx,
      source: mode === "aggTrade_proxy" ? "aggTrade_proxy" : "aggTrade+mark1m",
    });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * Four checkpoints per minute from mark OHLC.
 * @param {Array<{ ts: number, open: number, high: number, low: number, close: number }>} markBars
 * @param {number} fromMs
 * @param {number} toMs
 */
export function buildMarkOhlcTickSeries(markBars, fromMs, toMs) {
  const from = Number(fromMs);
  const to = Number(toMs);
  const out = [];
  for (const b of markBars ?? []) {
    const base = Number(b.ts);
    if (!Number.isFinite(base) || base < from || base > to) continue;
    const o = Number(b.open);
    const h = Number(b.high);
    const l = Number(b.low);
    const c = Number(b.close);
    const pts = [
      { ts: base, px: o },
      { ts: base + 15_000, px: h },
      { ts: base + 30_000, px: l },
      { ts: base + 45_000, px: c },
    ];
    for (const p of pts) {
      if (!Number.isFinite(p.px) || p.px <= 0) continue;
      out.push({ ts: p.ts, markPx: p.px, tradePx: null, source: "mark_1m_ohlc" });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * Bucket ticks to reduce count (min/max/last mark per bucket).
 * @param {Array<{ ts: number, markPx: number, tradePx?: number|null, source?: string }>} ticks
 * @param {number} bucketMs
 */
export function downsampleTicks(ticks, bucketMs = DEFAULT_DOWNSAMPLE_MS) {
  const bucket = Math.max(50, Number(bucketMs) || DEFAULT_DOWNSAMPLE_MS);
  const byBucket = new Map();
  for (const t of ticks ?? []) {
    const ts = Number(t.ts);
    if (!Number.isFinite(ts)) continue;
    const key = Math.floor(ts / bucket) * bucket;
    let row = byBucket.get(key);
    if (!row) {
      row = {
        ts: key,
        markPx: Number(t.markPx),
        markMin: Number(t.markPx),
        markMax: Number(t.markPx),
        tradePx: t.tradePx != null ? Number(t.tradePx) : null,
        source: t.source ?? "downsampled",
        lastTs: ts,
      };
      byBucket.set(key, row);
      continue;
    }
    const px = Number(t.markPx);
    if (Number.isFinite(px)) {
      row.markMin = Math.min(row.markMin, px);
      row.markMax = Math.max(row.markMax, px);
      if (ts >= row.lastTs) {
        row.markPx = px;
        row.lastTs = ts;
      }
    }
    if (t.tradePx != null) row.tradePx = Number(t.tradePx);
  }
  const out = [];
  for (const row of [...byBucket.values()].sort((a, b) => a.ts - b.ts)) {
    const isLong = true;
    void isLong;
    out.push(
      { ts: row.ts, markPx: row.markMin, tradePx: row.tradePx, source: `${row.source}:min` },
      { ts: row.ts + Math.floor(bucket / 3), markPx: row.markMax, tradePx: row.tradePx, source: `${row.source}:max` },
      { ts: row.ts + Math.floor((2 * bucket) / 3), markPx: row.markPx, tradePx: row.tradePx, source: `${row.source}:last` },
    );
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * @param {Array<{ ts: number }>} ticks
 * @param {{ force?: boolean, maxTicks?: number, bucketMs?: number }} [opts]
 */
export function maybeDownsampleTicks(ticks, opts = {}) {
  const maxTicks = Number(opts.maxTicks ?? DEFAULT_MAX_TICKS);
  const force = opts.force === true;
  if (force || !Array.isArray(ticks) || ticks.length <= maxTicks) return ticks ?? [];
  return downsampleTicks(ticks, opts.bucketMs ?? DEFAULT_DOWNSAMPLE_MS);
}

/**
 * Merge overlapping [from,to] intervals per symbol.
 * @param {Array<{ symbol: string, fromMs: number, toMs: number }>} windows
 */
export function mergeHoldWindows(windows) {
  const bySym = new Map();
  for (const w of windows ?? []) {
    const sym = String(w.symbol || "").toUpperCase();
    const fromMs = Number(w.fromMs);
    const toMs = Number(w.toMs);
    if (!sym || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) continue;
    if (!bySym.has(sym)) bySym.set(sym, []);
    bySym.get(sym).push({ fromMs, toMs });
  }
  const out = [];
  for (const [symbol, list] of bySym) {
    const sorted = [...list].sort((a, b) => a.fromMs - b.fromMs);
    let cur = { ...sorted[0] };
    for (let i = 1; i < sorted.length; i++) {
      const n = sorted[i];
      if (n.fromMs <= cur.toMs) {
        cur.toMs = Math.max(cur.toMs, n.toMs);
      } else {
        out.push({ symbol, fromMs: cur.fromMs, toMs: cur.toMs });
        cur = { ...n };
      }
    }
    out.push({ symbol, fromMs: cur.fromMs, toMs: cur.toMs });
  }
  return out;
}

/** UTC calendar days (YYYY-MM-DD) covering [fromMs, toMs]. */
export function calendarDaysInRange(fromMs, toMs) {
  const from = Number(fromMs);
  const to = Number(toMs);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const days = new Set();
  const d = new Date(from);
  d.setUTCHours(0, 0, 0, 0);
  while (d.getTime() <= to) {
    days.add(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const endDay = new Date(to);
  endDay.setUTCHours(0, 0, 0, 0);
  days.add(endDay.toISOString().slice(0, 10));
  return [...days].sort();
}
