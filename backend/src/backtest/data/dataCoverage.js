import { getPool } from "../../db/pool.js";
import { tfToMs } from "./timeframe.js";

function normalizeSymbol(symbol) {
  return String(symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/**
 * @returns {Promise<{ have: number, expected: number | null, coveragePct: number | null, minTs: number | null, maxTs: number | null }>}
 */
export async function getCoverage(symbol, tf, { from, to } = {}) {
  const pool = getPool();
  if (!pool) throw new Error("db_not_configured");
  const sym = normalizeSymbol(symbol);
  const timeframe = String(tf || "15m").toLowerCase();
  const step = tfToMs(timeframe);

  const params = [sym, timeframe];
  let where = "symbol = $1 AND timeframe = $2";
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
      expected = Math.max(1, Math.floor((toMs - fromMs) / step));
      coveragePct = Math.min(100, (have / expected) * 100);
    }
  }

  return { have, expected, coveragePct, minTs, maxTs };
}

/**
 * @returns {Promise<Array<{ month: string, have: number, expected: number, coveragePct: number }>>}
 */
export async function getMonthlyCoverage(symbol, tf, fromMs, toMs) {
  const pool = getPool();
  if (!pool) throw new Error("db_not_configured");
  const sym = normalizeSymbol(symbol);
  const timeframe = String(tf || "15m").toLowerCase();
  const step = tfToMs(timeframe);
  const from = Number(fromMs);
  const to = Number(toMs);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];

  const r = await pool.query(
    `SELECT to_char(date_trunc('month', open_time AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,
            COUNT(*)::int AS have
       FROM ohlcv_candles
      WHERE symbol = $1 AND timeframe = $2
        AND open_time >= to_timestamp($3 / 1000.0)
        AND open_time < to_timestamp($4 / 1000.0)
      GROUP BY 1
      ORDER BY 1`,
    [sym, timeframe, from, to],
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
    const expected = sliceTo > sliceFrom ? Math.max(1, Math.floor((sliceTo - sliceFrom) / step)) : 0;
    const month = `${y}-${String(m + 1).padStart(2, "0")}`;
    const row = r.rows.find((x) => x.month === month);
    const have = Number(row?.have ?? 0);
    const coveragePct = expected > 0 ? Math.min(100, (have / expected) * 100) : 0;
    out.push({ month, have, expected, coveragePct });
    cursor = monthEnd;
  }
  return out;
}
