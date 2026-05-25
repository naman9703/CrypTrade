import axios from "axios";
import { getPool } from "../../db/pool.js";

const FAPI = process.env.BINANCE_FUTURES_REST_BASE || "https://fapi.binance.com";

function normalizeSymbol(symbol) {
  return String(symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

async function fetchOiHist(symbol, period, fromMs, toMs) {
  const out = [];
  let end = toMs;
  let guard = 0;
  while (end > fromMs && guard < 100) {
    guard += 1;
    const { data } = await axios.get(`${FAPI}/futures/data/openInterestHist`, {
      params: {
        symbol,
        period,
        limit: 500,
        endTime: Math.floor(end),
      },
      timeout: 20_000,
    });
    if (!Array.isArray(data) || !data.length) break;
    for (const row of data) {
      const ts = Number(row.timestamp);
      const oi = Number(row.sumOpenInterest ?? row.sumOpenInterestValue);
      if (!Number.isFinite(ts) || !Number.isFinite(oi)) continue;
      out.push({ ts, oiUsdt: oi });
    }
    const first = Number(data[0].timestamp);
    if (!Number.isFinite(first) || data.length < 500) break;
    end = first - 1;
    if (first <= fromMs) break;
  }
  const byTs = new Map(out.map((r) => [r.ts, r]));
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

async function fetchLatestLsr(symbol) {
  try {
    const { data } = await axios.get(`${FAPI}/futures/data/globalLongShortAccountRatio`, {
      params: { symbol, period: "1h", limit: 1 },
      timeout: 10_000,
    });
    const row = Array.isArray(data) ? data[0] : null;
    const ts = Number(row?.timestamp);
    const lsr = Number(row?.longShortRatio);
    if (Number.isFinite(ts) && Number.isFinite(lsr)) return { ts, longShortRatio: lsr };
  } catch {
    /* optional */
  }
  return null;
}

/**
 * @returns {Promise<{ inserted: number }>}
 */
export async function ensureOpenInterest(symbol, { from, to, period = "1h" } = {}) {
  const pool = getPool();
  if (!pool) throw new Error("db_not_configured");
  const sym = normalizeSymbol(symbol);
  const fromMs = Number(from);
  const toMs = Number(to ?? Date.now());
  const rows = await fetchOiHist(sym, period, fromMs, toMs);
  const lsr = await fetchLatestLsr(sym);
  const sql = `
    INSERT INTO historical_open_interest (symbol, ts, oi_usdt, long_short_ratio)
    VALUES ($1, to_timestamp($2 / 1000.0), $3, $4)
    ON CONFLICT (symbol, ts) DO UPDATE SET
      oi_usdt = EXCLUDED.oi_usdt,
      long_short_ratio = COALESCE(EXCLUDED.long_short_ratio, historical_open_interest.long_short_ratio)
  `;
  let inserted = 0;
  for (const r of rows) {
    const res = await pool.query(sql, [sym, r.ts, r.oiUsdt, lsr?.longShortRatio ?? null]);
    if (res.rowCount > 0) inserted += 1;
  }
  return { inserted };
}

/**
 * @returns {Promise<Array<{ ts: number, oiUsdt: number, longShortRatio?: number }>>}
 */
export async function readOpenInterest(symbol, fromMs, toMs) {
  const pool = getPool();
  if (!pool) return [];
  const sym = normalizeSymbol(symbol);
  const r = await pool.query(
    `SELECT EXTRACT(EPOCH FROM ts) * 1000 AS ts,
            oi_usdt::float8 AS oi_usdt,
            long_short_ratio::float8 AS long_short_ratio
       FROM historical_open_interest
      WHERE symbol = $1
        AND ts >= to_timestamp($2 / 1000.0)
        AND ts <= to_timestamp($3 / 1000.0)
      ORDER BY ts ASC`,
    [sym, fromMs, toMs],
  );
  return r.rows.map((row) => ({
    ts: Math.round(Number(row.ts)),
    oiUsdt: Number(row.oi_usdt),
    longShortRatio:
      row.long_short_ratio != null ? Number(row.long_short_ratio) : undefined,
  }));
}
