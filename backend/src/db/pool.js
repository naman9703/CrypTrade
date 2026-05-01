import pg from "pg";

const { Pool } = pg;

/** @type {pg.Pool | null} */
let pool = null;

function buildPoolConfig() {
  const url = String(process.env.DATABASE_URL || "").trim();
  if (url) {
    return {
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX || 20),
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30_000),
      connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 5000),
    };
  }
  const host = String(process.env.DB_HOST || "").trim();
  if (!host) return null;
  return {
    host,
    port: Number(process.env.DB_PORT || 5432),
    database: String(process.env.DB_NAME || "trading"),
    user: String(process.env.DB_USER || "postgres"),
    password: String(process.env.DB_PASSWORD || ""),
    ssl: String(process.env.DB_SSL || "").toLowerCase() === "true" ? { rejectUnauthorized: false } : false,
    max: Number(process.env.PG_POOL_MAX || 20),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30_000),
    connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 5000),
  };
}

/**
 * @param {{ info?: Function, warn?: Function, error?: Function }} log
 * @returns {Promise<pg.Pool | null>}
 */
export async function initPool(log) {
  const cfg = buildPoolConfig();
  if (!cfg) {
    log?.warn?.("db_pool_skipped", {
      hint: "Set DATABASE_URL (or DB_HOST + DB_NAME + DB_USER + DB_PASSWORD) to enable Postgres.",
    });
    return null;
  }
  pool = new Pool(cfg);
  try {
    const r = await pool.query("SELECT NOW() AS t");
    log?.info?.("db_connected", { time: r.rows[0]?.t });
  } catch (err) {
    log?.error?.("db_connect_failed", { error: String(err?.message || err) });
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
    pool = null;
    process.exit(1);
  }
  return pool;
}

/** @returns {pg.Pool | null} */
export function getPool() {
  return pool;
}

export async function closePool() {
  if (!pool) return;
  await pool.end();
  pool = null;
}
