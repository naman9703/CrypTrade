/**
 * Mark-price candles for live-parity trailing replay.
 * Stored in `ohlcv_candles` as `{tf}_mark` (e.g. `1m_mark`, `5m_mark`), distinct from trade OHLC.
 */

import { getPool } from "../../db/pool.js";
import { fetchBinanceMarkPriceKlinesRange } from "../../lib/binanceMarkPriceKlinesRest.js";
import { estimateCandleFootprint } from "./dataCoverage.js";
import { READ_CANDLES_SLICE_MS, upsertOhlcvCandles, readCandles } from "./klineIngest.js";
import { tfToMs } from "./timeframe.js";

export const MARK_MICRO_TIMEFRAME = "1m_mark";
export const MARK_MICRO_SOURCE = "binance_futures_mark";

/** DB timeframe key for Binance mark klines at interval `tf` (e.g. `5m` → `5m_mark`). */
export function markDbTimeframe(tf) {
  const key = String(tf || "1m").trim().toLowerCase();
  return `${key}_mark`;
}

function normalizeSymbol(symbol) {
  return String(symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

async function readMarkSlice(symbol, fromMs, toMs, { interval = "1m" } = {}) {
  const pool = getPool();
  if (!pool) throw new Error("db_not_configured");
  const sym = normalizeSymbol(symbol);
  const from = Number(fromMs);
  const to = Number(toMs);
  const dbTf = markDbTimeframe(interval);
  const r = await pool.query(
    `SELECT EXTRACT(EPOCH FROM open_time) * 1000 AS ts,
            open::float8 AS open, high::float8 AS high, low::float8 AS low,
            close::float8 AS close
       FROM ohlcv_candles
      WHERE symbol = $1 AND timeframe = $2 AND source = $3
        AND open_time >= to_timestamp($4 / 1000.0)
        AND open_time < to_timestamp($5 / 1000.0)
      ORDER BY open_time ASC`,
    [sym, dbTf, MARK_MICRO_SOURCE, from, to],
  );
  return r.rows.map((row) => ({
    ts: Math.round(Number(row.ts)),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: 0,
    kind: "mark",
  }));
}

/**
 * Per-minute merge: trade 1m fills gaps; mark wins when both exist (live parity).
 * @param {Array<{ ts: number, open: number, high: number, low: number, close: number, volume?: number, kind?: string }>} markBars
 * @param {Array<{ ts: number, open: number, high: number, low: number, close: number, volume?: number }>} tradeBars
 */
export function mergeMicroTrailBars(markBars, tradeBars) {
  const byTs = new Map();
  for (const b of tradeBars ?? []) {
    const ts = Math.round(Number(b.ts));
    if (!Number.isFinite(ts)) continue;
    byTs.set(ts, {
      ts,
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
      volume: Number(b.volume) || 0,
      kind: "trade",
    });
  }
  for (const b of markBars ?? []) {
    const ts = Math.round(Number(b.ts));
    if (!Number.isFinite(ts)) continue;
    byTs.set(ts, {
      ts,
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
      volume: 0,
      kind: "mark",
    });
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * Read 1m micro bars for trailing replay.
 * Default: mark per minute where available, trade 1m for missing minutes.
 * @param {"mark"|"trade"} [priceSource] — `"trade"` skips mark entirely.
 */
export async function readMicroTrailBars(symbol, fromMs, toMs, { priceSource = "mark" } = {}) {
  const from = Number(fromMs);
  const to = Number(toMs);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];

  const tradeOnly = String(priceSource || "mark").toLowerCase() === "trade";
  const out = [];

  for (let cursor = from; cursor < to; cursor += READ_CANDLES_SLICE_MS) {
    const sliceTo = Math.min(to, cursor + READ_CANDLES_SLICE_MS);
    if (tradeOnly) {
      const trade = await readCandles(symbol, "1m", cursor, sliceTo, { market: "futures" }).catch(() => []);
      for (const b of trade) out.push({ ...b, kind: "trade" });
      continue;
    }
    const [mark, trade] = await Promise.all([
      readMarkSlice(symbol, cursor, sliceTo).catch(() => []),
      readCandles(symbol, "1m", cursor, sliceTo, { market: "futures" }).catch(() => []),
    ]);
    const part = mergeMicroTrailBars(mark, trade);
    for (const b of part) out.push(b);
  }
  return out;
}

/**
 * Read mark-price klines at any supported interval (direct Binance mark OHLC, no trade merge).
 * @param {string} interval — e.g. `"5m"`, `"15m"`
 */
export async function readMarkTrailBars(symbol, interval, fromMs, toMs) {
  const from = Number(fromMs);
  const to = Number(toMs);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];

  const out = [];
  for (let cursor = from; cursor < to; cursor += READ_CANDLES_SLICE_MS) {
    const sliceTo = Math.min(to, cursor + READ_CANDLES_SLICE_MS);
    const part = await readMarkSlice(symbol, cursor, sliceTo, { interval }).catch(() => []);
    for (const b of part) out.push(b);
  }
  return out;
}

const MARK_STEP_MS = 60_000;

/**
 * Mark-price 1m coverage for the backtest data panel.
 */
export async function getMarkCoverage(symbol, { from, to } = {}) {
  const pool = getPool();
  if (!pool) throw new Error("db_not_configured");
  const sym = normalizeSymbol(symbol);
  const params = [sym, MARK_MICRO_TIMEFRAME, MARK_MICRO_SOURCE];
  let where =
    "symbol = $1 AND timeframe = $2 AND source = $3";
  if (from != null) {
    params.push(Number(from));
    where += ` AND open_time >= to_timestamp($${params.length} / 1000.0)`;
  }
  if (to != null) {
    params.push(Number(to));
    where += ` AND open_time < to_timestamp($${params.length} / 1000.0)`;
  }
  const r = await pool.query(
    `SELECT COUNT(*)::int AS have,
            MIN(EXTRACT(EPOCH FROM open_time) * 1000) AS min_ts,
            MAX(EXTRACT(EPOCH FROM open_time) * 1000) AS max_ts
       FROM ohlcv_candles
      WHERE ${where}`,
    params,
  );
  const have = Number(r.rows[0]?.have ?? 0);
  const minTs = r.rows[0]?.min_ts != null ? Math.round(Number(r.rows[0].min_ts)) : null;
  const maxTs = r.rows[0]?.max_ts != null ? Math.round(Number(r.rows[0].max_ts)) : null;
  let expected = null;
  let coveragePct = null;
  if (from != null && to != null) {
    const fromMs = Number(from);
    const toMs = Number(to);
    if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs) {
      expected = Math.max(1, Math.floor((toMs - fromMs) / MARK_STEP_MS));
      coveragePct = Math.min(100, (have / expected) * 100);
    }
  }
  const footprint = await estimateCandleFootprint(pool, where, params, have, expected);
  return { have, expected, coveragePct, minTs, maxTs, ...footprint };
}

/** Monthly mark 1m coverage grid (same shape as trade OHLC monthly). */
export async function getMarkMonthlyCoverage(symbol, fromMs, toMs) {
  const pool = getPool();
  if (!pool) throw new Error("db_not_configured");
  const sym = normalizeSymbol(symbol);
  const from = Number(fromMs);
  const to = Number(toMs);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];

  const r = await pool.query(
    `SELECT to_char(date_trunc('month', open_time AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,
            COUNT(*)::int AS have
       FROM ohlcv_candles
      WHERE symbol = $1 AND timeframe = $2 AND source = $3
        AND open_time >= to_timestamp($4 / 1000.0)
        AND open_time < to_timestamp($5 / 1000.0)
      GROUP BY 1
      ORDER BY 1`,
    [sym, MARK_MICRO_TIMEFRAME, MARK_MICRO_SOURCE, from, to],
  );

  const out = [];
  let cursor = Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), 1);
  const end = to;
  while (cursor < end) {
    const y = new Date(cursor).getUTCFullYear();
    const m = new Date(cursor).getUTCMonth();
    const monthStart = Date.UTC(y, m, 1);
    const monthEnd = Date.UTC(y, m + 1, 1);
    const sliceFrom = Math.max(from, monthStart);
    const sliceTo = Math.min(end, monthEnd);
    const expected =
      sliceTo > sliceFrom ? Math.max(1, Math.floor((sliceTo - sliceFrom) / MARK_STEP_MS)) : 0;
    const month = `${y}-${String(m + 1).padStart(2, "0")}`;
    const row = r.rows.find((x) => x.month === month);
    const have = Number(row?.have ?? 0);
    const coveragePct = expected > 0 ? Math.min(100, (have / expected) * 100) : 0;
    out.push({ month, have, expected, coveragePct });
    cursor = monthEnd;
  }
  return out;
}

/**
 * Backfill Binance mark-price klines into `ohlcv_candles`.
 * @param {object} [opts]
 * @param {string} [opts.interval] — Binance interval (`1m`, `5m`, `15m`, …); default `1m`.
 * @returns {Promise<{ inserted: number, gaps: number, interval: string }>}
 */
export async function ensureMarkKlines(symbol, { from, to, interval = "1m", onProgress } = {}) {
  const pool = getPool();
  if (!pool) throw new Error("db_not_configured");
  const sym = normalizeSymbol(symbol);
  const intv = String(interval || "1m").trim().toLowerCase();
  const dbTf = markDbTimeframe(intv);
  const fromMs = Number(from);
  const toMs = Number(to ?? Date.now());
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new Error("invalid_mark_kline_range");
  }

  let inserted = 0;
  let fetchedTotal = 0;
  const stepMs = tfToMs(intv);
  const expected = Math.max(0, Math.floor((toMs - fromMs) / stepMs));
  const span = Math.max(1, toMs - fromMs);
  const report =
    typeof onProgress === "function"
      ? (pct, phase) => {
          try {
            onProgress({ pct: Math.max(0, Math.min(100, pct)), phase });
          } catch {
            /* ignore */
          }
        }
      : null;

  for (let cursor = fromMs; cursor < toMs; cursor += READ_CANDLES_SLICE_MS) {
    const sliceTo = Math.min(toMs, cursor + READ_CANDLES_SLICE_MS);
    const sliceSpan = Math.max(1, sliceTo - cursor);
    const fetched = await fetchBinanceMarkPriceKlinesRange({
      symbol: sym,
      interval: intv,
      startTime: cursor,
      endTime: sliceTo,
      onProgress: ({ pct }) => {
        const local = Math.max(0, Math.min(100, Number(pct) || 0));
        const globalPct = (((cursor - fromMs) + (local / 100) * sliceSpan) / span) * 100;
        report?.(globalPct, "mark");
      },
    });
    fetchedTotal += fetched.length;
    if (fetched.length) {
      inserted += await upsertOhlcvCandles(sym, dbTf, fetched, MARK_MICRO_SOURCE);
    }
    report?.(((sliceTo - fromMs) / span) * 100, "mark");
  }

  report?.(100, "mark");
  const gaps = Math.max(0, expected - fetchedTotal);
  return { inserted, gaps, interval: intv };
}
