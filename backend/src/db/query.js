import { getPool } from "./pool.js";

/**
 * @param {string} sql
 * @param {unknown[]} [params]
 */
export async function query(sql, params = []) {
  const pool = getPool();
  if (!pool) throw new Error("db_not_configured");
  try {
    return await pool.query(sql, params);
  } catch (err) {
    console.error("[db] Query error:", err?.message || err, { sql: sql.slice(0, 200), params });
    throw err;
  }
}

/**
 * @param {(client: import('pg').PoolClient) => Promise<unknown>} fn
 */
export async function withTransaction(fn) {
  const pool = getPool();
  if (!pool) throw new Error("db_not_configured");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
