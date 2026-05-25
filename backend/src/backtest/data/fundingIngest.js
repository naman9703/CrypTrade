import axios from "axios";
import { getPool } from "../../db/pool.js";

const FAPI = process.env.BINANCE_FUTURES_REST_BASE || "https://fapi.binance.com";

function normalizeSymbol(symbol) {
  return String(symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

async function fetchFundingHistory(symbol, fromMs, toMs) {
  const out = [];
  let start = fromMs;
  let guard = 0;
  while (start < toMs && guard < 200) {
    guard += 1;
    const { data } = await axios.get(`${FAPI}/fapi/v1/fundingRate`, {
      params: { symbol, startTime: Math.floor(start), endTime: Math.floor(toMs), limit: 1000 },
      timeout: 20_000,
    });
    if (!Array.isArray(data) || !data.length) break;
    for (const row of data) {
      const ts = Number(row.fundingTime);
      const rate = Number(row.fundingRate);
      if (Number.isFinite(ts) && Number.isFinite(rate)) out.push({ ts, rate });
    }
    const last = Number(data[data.length - 1].fundingTime);
    if (!Number.isFinite(last) || data.length < 1000) break;
    start = last + 1;
  }
  const byTs = new Map(out.map((r) => [r.ts, r]));
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * @returns {Promise<{ inserted: number }>}
 */
export async function ensureFunding(symbol, { from, to } = {}) {
  const pool = getPool();
  if (!pool) throw new Error("db_not_configured");
  const sym = normalizeSymbol(symbol);
  const fromMs = Number(from);
  const toMs = Number(to ?? Date.now());
  const rows = await fetchFundingHistory(sym, fromMs, toMs);
  const sql = `
    INSERT INTO historical_funding_rates (symbol, ts, funding_rate)
    VALUES ($1, to_timestamp($2 / 1000.0), $3)
    ON CONFLICT (symbol, ts) DO UPDATE SET funding_rate = EXCLUDED.funding_rate
  `;
  let inserted = 0;
  for (const r of rows) {
    const res = await pool.query(sql, [sym, r.ts, r.rate]);
    if (res.rowCount > 0) inserted += 1;
  }
  return { inserted };
}

/**
 * @returns {Promise<Array<{ ts: number, rate: number }>>}
 */
export async function readFundingRates(symbol, fromMs, toMs) {
  const pool = getPool();
  if (!pool) return [];
  const sym = normalizeSymbol(symbol);
  const r = await pool.query(
    `SELECT EXTRACT(EPOCH FROM ts) * 1000 AS ts, funding_rate::float8 AS rate
       FROM historical_funding_rates
      WHERE symbol = $1
        AND ts >= to_timestamp($2 / 1000.0)
        AND ts <= to_timestamp($3 / 1000.0)
      ORDER BY ts ASC`,
    [sym, fromMs, toMs],
  );
  return r.rows.map((row) => ({ ts: Math.round(Number(row.ts)), rate: Number(row.rate) }));
}
