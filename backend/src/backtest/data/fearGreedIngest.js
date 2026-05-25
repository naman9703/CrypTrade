import axios from "axios";
import { getPool } from "../../db/pool.js";

const URL = "https://api.alternative.me/fng/";

/**
 * @returns {Promise<{ inserted: number }>}
 */
export async function ensureFearGreed({ limit = 0 } = {}) {
  const pool = getPool();
  if (!pool) throw new Error("db_not_configured");
  const lim = Number(limit) > 0 ? Number(limit) : 0;
  const { data } = await axios.get(URL, {
    params: { limit: lim, format: "json" },
    timeout: 20_000,
  });
  const rows = Array.isArray(data?.data) ? data.data : [];
  const sql = `
    INSERT INTO historical_fear_greed (ts, value, label)
    VALUES (to_timestamp($1), $2, $3)
    ON CONFLICT (ts) DO UPDATE SET value = EXCLUDED.value, label = EXCLUDED.label
  `;
  let inserted = 0;
  for (const row of rows) {
    const tsSec = Number(row.timestamp);
    const value = Number(row.value);
    if (!Number.isFinite(tsSec) || !Number.isFinite(value)) continue;
    const res = await pool.query(sql, [tsSec, Math.round(value), String(row.value_classification || "")]);
    if (res.rowCount > 0) inserted += 1;
  }
  return { inserted };
}

/**
 * @returns {Promise<Array<{ ts: number, value: number, label?: string }>>}
 */
export async function readFearGreed(fromMs, toMs) {
  const pool = getPool();
  if (!pool) return [];
  const r = await pool.query(
    `SELECT EXTRACT(EPOCH FROM ts) * 1000 AS ts, value, label
       FROM historical_fear_greed
      WHERE ts >= to_timestamp($1 / 1000.0)
        AND ts <= to_timestamp($2 / 1000.0)
      ORDER BY ts ASC`,
    [fromMs, toMs],
  );
  return r.rows.map((row) => ({
    ts: Math.round(Number(row.ts)),
    value: Number(row.value),
    label: row.label ?? undefined,
  }));
}
