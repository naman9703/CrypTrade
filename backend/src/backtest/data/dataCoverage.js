import { getPool } from "../../db/pool.js";
import { tfToMs } from "./timeframe.js";
import {
  planPatchRangesFromCoverage,
  preferredOhlcSources,
} from "./coverageGaps.js";

function normalizeSymbol(symbol) {
  return String(symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/** Fallback row size when the sample query returns no rows. */
const DEFAULT_ROW_DISK_BYTES = 196;
/** Plain `{ts,o,h,l,c,v}` objects loaded by the backtest worker. */
const MEM_BYTES_PER_BAR = 112;

/**
 * Estimate Postgres heap bytes + backtest in-memory load for matching `ohlcv_candles` rows.
 * Uses an exact SUM for small windows; otherwise AVG(sample) × count.
 *
 * @returns {Promise<{ diskBytes: number, memBytesEst: number, diskBytesFull: number | null, memBytesFull: number | null }>}
 */
export async function estimateCandleFootprint(pool, where, params, have, expected = null) {
  const noRows = {
    diskBytes: 0,
    memBytesEst: 0,
    diskBytesFull: expected != null && expected > 0 ? Math.round(DEFAULT_ROW_DISK_BYTES * expected) : null,
    memBytesFull: expected != null && expected > 0 ? expected * MEM_BYTES_PER_BAR : null,
  };
  if (have <= 0) return noRows;

  let diskBytes;
  if (have <= 5000) {
    const sr = await pool.query(
      `SELECT COALESCE(SUM(pg_column_size(t)), 0)::bigint AS storage_bytes
         FROM ohlcv_candles t
        WHERE ${where}`,
      params,
    );
    diskBytes = Number(sr.rows[0]?.storage_bytes ?? 0);
  } else {
    const sampleLimit = 2000;
    const sr = await pool.query(
      `SELECT COALESCE(AVG(pg_column_size(t)), 0)::float8 AS avg_bytes
         FROM (
           SELECT t FROM ohlcv_candles t
            WHERE ${where}
            LIMIT $${params.length + 1}
         ) s`,
      [...params, sampleLimit],
    );
    const avg = Number(sr.rows[0]?.avg_bytes ?? 0) || DEFAULT_ROW_DISK_BYTES;
    diskBytes = Math.round(avg * have);
  }

  const memBytesEst = have * MEM_BYTES_PER_BAR;
  let diskBytesFull = null;
  let memBytesFull = null;
  if (expected != null && expected > 0) {
    memBytesFull = expected * MEM_BYTES_PER_BAR;
    diskBytesFull = Math.round((diskBytes / have) * expected);
  }

  return { diskBytes, memBytesEst, diskBytesFull, memBytesFull };
}

/**
 * @param {object} [opts]
 * @param {number} [opts.from]
 * @param {number} [opts.to]
 * @param {"futures"|"spot"} [opts.market] when set, count only preferred venue sources (accurate fill)
 */
export async function getCoverage(symbol, tf, { from, to, market } = {}) {
  const pool = getPool();
  if (!pool) throw new Error("db_not_configured");
  const sym = normalizeSymbol(symbol);
  const timeframe = String(tf || "15m").toLowerCase();
  const step = tfToMs(timeframe);

  const params = [sym, timeframe];
  let where = "symbol = $1 AND timeframe = $2";
  // Prefer venue sources so wrong-source rows cannot mark the window "filled".
  if (market === "spot" || market === "futures") {
    params.push(preferredOhlcSources(market));
    where += ` AND source = ANY($${params.length}::text[])`;
  }
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
  let remainingMs = null;
  let remainingDays = null;
  let remainingBars = null;
  let patchFrom = null;
  let patchTo = null;
  if (from != null && to != null) {
    const fromMs = Number(from);
    const toMs = Number(to);
    if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs) {
      // Count only closed bars so an in-progress candle does not keep the window "unfilled".
      const closedTo = Math.min(toMs, Math.floor(toMs / step) * step);
      expected = closedTo > fromMs ? Math.max(1, Math.floor((closedTo - fromMs) / step)) : 1;
      coveragePct = Math.min(100, (have / expected) * 100);
      const patch = planPatchRangesFromCoverage({
        from: fromMs,
        to: toMs,
        stepMs: step,
        minTs,
        maxTs,
        monthly: [],
      });
      remainingMs = patch.remainingMs;
      remainingDays = patch.remainingDays;
      remainingBars = patch.remainingBars;
      patchFrom = patch.patchFrom;
      patchTo = patch.patchTo;
    }
  }

  const footprint = await estimateCandleFootprint(pool, where, params, have, expected);
  return {
    have,
    expected,
    coveragePct,
    minTs,
    maxTs,
    remainingMs,
    remainingDays,
    remainingBars,
    patchFrom,
    patchTo,
    ...footprint,
  };
}

/**
 * @param {object} [opts]
 * @param {"futures"|"spot"} [opts.market]
 * @returns {Promise<Array<{ month: string, have: number, expected: number, coveragePct: number }>>}
 */
export async function getMonthlyCoverage(symbol, tf, fromMs, toMs, opts = {}) {
  const pool = getPool();
  if (!pool) throw new Error("db_not_configured");
  const sym = normalizeSymbol(symbol);
  const timeframe = String(tf || "15m").toLowerCase();
  const step = tfToMs(timeframe);
  const from = Number(fromMs);
  const to = Number(toMs);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];

  const market = opts.market === "spot" || opts.market === "futures" ? opts.market : null;
  const params = [sym, timeframe];
  let sourceClause = "";
  if (market) {
    params.push(preferredOhlcSources(market));
    sourceClause = ` AND source = ANY($${params.length}::text[])`;
  }
  const fromIdx = params.length + 1;
  const toIdx = params.length + 2;
  params.push(from, to);

  const r = await pool.query(
    `SELECT to_char(date_trunc('month', open_time AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,
            COUNT(*)::int AS have
       FROM ohlcv_candles
      WHERE symbol = $1 AND timeframe = $2${sourceClause}
        AND open_time >= to_timestamp($${fromIdx} / 1000.0)
        AND open_time < to_timestamp($${toIdx} / 1000.0)
      GROUP BY 1
      ORDER BY 1`,
    params,
  );

  const out = [];
  let cursor = Date.UTC(
    new Date(from).getUTCFullYear(),
    new Date(from).getUTCMonth(),
    1,
  );
  const end = to;
  while (cursor < end) {
    const y = new Date(cursor).getUTCFullYear();
    const m = new Date(cursor).getUTCMonth();
    const monthStart = Date.UTC(y, m, 1);
    const monthEnd = Date.UTC(y, m + 1, 1);
    const sliceFrom = Math.max(from, monthStart);
    const sliceTo = Math.min(end, monthEnd);
    const closedSliceTo = Math.min(sliceTo, Math.floor(sliceTo / step) * step);
    const expected =
      closedSliceTo > sliceFrom ? Math.max(1, Math.floor((closedSliceTo - sliceFrom) / step)) : 0;
    const month = `${y}-${String(m + 1).padStart(2, "0")}`;
    const row = r.rows.find((x) => x.month === month);
    const have = Number(row?.have ?? 0);
    const coveragePct = expected > 0 ? Math.min(100, (have / expected) * 100) : 0;
    out.push({ month, have, expected, coveragePct });
    cursor = monthEnd;
  }
  return out;
}
