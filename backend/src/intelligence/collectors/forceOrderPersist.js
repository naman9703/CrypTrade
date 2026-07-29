/**
 * Batch persist Binance forceOrder ticks to TimescaleDB.
 */
import { getPool } from "../../db/pool.js";

/** @typedef {{ symbol: string, ts: number, side: string, price: number, qty: number, notionalUsd: number, orderId?: number }} ForceOrderRow */

const queue = [];
let flushTimer = null;
const FLUSH_MS = Number(process.env.FORCE_ORDER_FLUSH_MS || 2000);
const BATCH_MAX = Number(process.env.FORCE_ORDER_BATCH_MAX || 200);

async function flushQueue() {
  if (queue.length === 0) return;
  const pool = getPool();
  if (!pool) return;

  const batch = queue.splice(0, BATCH_MAX);
  const values = [];
  const params = [];
  let i = 1;
  for (const r of batch) {
    values.push(`($${i++}, to_timestamp($${i++} / 1000.0), $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
    params.push(
      r.symbol,
      r.ts,
      r.side,
      r.price,
      r.qty,
      r.notionalUsd,
      r.orderId ?? null,
    );
  }
  try {
    await pool.query(
      `INSERT INTO force_orders (symbol, ts, side, price, qty, notional_usd, order_id)
       VALUES ${values.join(", ")}
       ON CONFLICT (symbol, ts, side, price, qty) DO NOTHING`,
      params,
    );
  } catch (err) {
    console.warn("[force_orders] persist failed:", err?.message || err);
  }
  if (queue.length > 0) scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushQueue();
  }, FLUSH_MS);
  flushTimer.unref?.();
}

/** @param {ForceOrderRow} row */
export function enqueueForceOrder(row) {
  if (!row?.symbol || !Number.isFinite(row.ts) || !Number.isFinite(row.notionalUsd)) return;
  queue.push(row);
  if (queue.length >= BATCH_MAX) void flushQueue();
  else scheduleFlush();
}

export async function readRecentForceOrders(symbol, fromMs, toMs = Date.now()) {
  const pool = getPool();
  if (!pool) return [];
  const sym = String(symbol || "").trim().toUpperCase();
  const { rows } = await pool.query(
    `SELECT EXTRACT(EPOCH FROM ts) * 1000 AS ts, side, price::float8 AS price,
            qty::float8 AS qty, notional_usd::float8 AS notional_usd
     FROM force_orders
     WHERE symbol = $1 AND ts >= to_timestamp($2 / 1000.0) AND ts <= to_timestamp($3 / 1000.0)
     ORDER BY ts ASC`,
    [sym, fromMs, toMs],
  );
  return rows.map((r) => ({
    time: Number(r.ts),
    side: String(r.side),
    price: Number(r.price),
    qty: Number(r.qty),
    notionalUsd: Number(r.notional_usd),
  }));
}

export async function flushForceOrdersNow() {
  await flushQueue();
}
