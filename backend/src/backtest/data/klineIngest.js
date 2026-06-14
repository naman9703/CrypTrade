/**
 * OHLC backfill + read from `ohlcv_candles` (Timescale).
 */

import { getPool } from "../../db/pool.js";
import { fetchBinanceKlinesRange } from "../../lib/binanceKlinesRest.js";
import { binanceInterval, tfToMs } from "./timeframe.js";

function normalizeSymbol(symbol) {
  return String(symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

const UPSERT_CHUNK = 400;

/**
 * Max window per DB read/backfill slice. Long ranges on Timescale hypertables
 * exhaust Postgres `max_locks_per_transaction` → "out of shared memory".
 */
export const READ_CANDLES_SLICE_MS = 90 * 24 * 60 * 60 * 1000;

/** Timescale compresses ohlcv chunks after 7d; bulk upsert must decompress them. */
const TIMESCALE_DECOMPRESS_UNLIMITED =
  "SET timescaledb.max_tuples_decompressed_per_dml_transaction = 0";

async function upsertCandlesChunk(client, symbol, tf, chunk, source) {
  const values = [];
  const params = [];
  let p = 1;
  for (const c of chunk) {
    values.push(
      `($${p++}, $${p++}, to_timestamp($${p++} / 1000.0), $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`,
    );
    params.push(
      symbol,
      tf,
      c.ts,
      c.open,
      c.high,
      c.low,
      c.close,
      c.volume ?? 0,
      c.taker_buy_volume ?? null,
      source,
    );
  }
  const sql = `
    INSERT INTO ohlcv_candles (symbol, timeframe, open_time, open, high, low, close, volume, taker_buy_volume, source)
    VALUES ${values.join(", ")}
    ON CONFLICT (symbol, timeframe, open_time)
    DO UPDATE SET
      open = EXCLUDED.open,
      high = EXCLUDED.high,
      low = EXCLUDED.low,
      close = EXCLUDED.close,
      volume = EXCLUDED.volume,
      taker_buy_volume = EXCLUDED.taker_buy_volume,
      source = EXCLUDED.source
  `;
  const res = await client.query(sql, params);
  return res.rowCount > 0 ? res.rowCount : chunk.length;
}

async function upsertCandles(symbol, tf, rows, source = "binance") {
  const pool = getPool();
  if (!pool || !rows.length) return 0;
  const client = await pool.connect();
  let inserted = 0;
  try {
    await client.query(TIMESCALE_DECOMPRESS_UNLIMITED);
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const chunk = rows.slice(i, i + UPSERT_CHUNK);
      inserted += await upsertCandlesChunk(client, symbol, tf, chunk, source);
    }
  } finally {
    client.release();
  }
  return inserted;
}

/**
 * Backfill missing klines from Binance REST into `ohlcv_candles`.
 * @returns {Promise<{ inserted: number, gaps: number }>}
 */
export async function ensureKlines(symbol, tf, { from, to, market = "futures" } = {}) {
  const pool = getPool();
  if (!pool) throw new Error("db_not_configured");
  const sym = normalizeSymbol(symbol);
  const timeframe = String(tf || "15m").toLowerCase();
  const fromMs = Number(from);
  const toMs = Number(to ?? Date.now());
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new Error("invalid_kline_range");
  }

  const step = tfToMs(timeframe);
  const expected = Math.max(0, Math.floor((toMs - fromMs) / step));
  const feedKind = market === "spot" ? "BINANCE" : "BINANCE_FUTURES";
  const interval = binanceInterval(timeframe);

  let inserted = 0;
  let fetchedTotal = 0;
  const source = market === "spot" ? "binance_spot" : "binance_futures";

  for (let cursor = fromMs; cursor < toMs; cursor += READ_CANDLES_SLICE_MS) {
    const sliceTo = Math.min(toMs, cursor + READ_CANDLES_SLICE_MS);
    const fetched = await fetchBinanceKlinesRange({
      symbol: sym,
      interval,
      startTime: cursor,
      endTime: sliceTo,
      feedKind,
    });
    fetchedTotal += fetched.length;
    if (fetched.length) {
      inserted += await upsertCandles(sym, timeframe, fetched, source);
    }
  }

  const gaps = Math.max(0, expected - fetchedTotal);
  return { inserted, gaps };
}

function preferredSources(market = "futures") {
  return market === "spot" ? ["binance_spot", "binance"] : ["binance_futures"];
}

/**
 * @param {object} [opts]
 * @param {"futures"|"spot"} [opts.market]
 * @param {boolean} [opts.excludeLiveArchive=true] skip `binance_live` rows (spot/WS contamination)
 * @returns {Promise<Array<{ ts: number, open: number, high: number, low: number, close: number, volume: number }>>}
 */
async function readCandlesSlice(symbol, tf, fromMs, toMs, opts = {}) {
  const pool = getPool();
  if (!pool) throw new Error("db_not_configured");
  const sym = normalizeSymbol(symbol);
  const timeframe = String(tf || "15m").toLowerCase();
  const from = Number(fromMs);
  const to = Number(toMs);
  const market = opts.market === "spot" ? "spot" : "futures";
  const allowLive = opts.allowLiveArchive === true;
  const sources = allowLive
    ? [...preferredSources(market), "binance_live"]
    : preferredSources(market);
  const r = await pool.query(
    `SELECT EXTRACT(EPOCH FROM open_time) * 1000 AS ts,
            open::float8 AS open, high::float8 AS high, low::float8 AS low,
            close::float8 AS close, volume::float8 AS volume,
            taker_buy_volume::float8 AS taker_buy_volume
       FROM ohlcv_candles
      WHERE symbol = $1 AND timeframe = $2
        AND open_time >= to_timestamp($3 / 1000.0)
        AND open_time < to_timestamp($4 / 1000.0)
        AND source = ANY($5::text[])
      ORDER BY open_time ASC`,
    [sym, timeframe, from, to, sources],
  );
  return r.rows.map((row) => ({
    ts: Math.round(Number(row.ts)),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume) || 0,
    ...(row.taker_buy_volume != null && Number.isFinite(Number(row.taker_buy_volume))
      ? { taker_buy_volume: Number(row.taker_buy_volume) }
      : {}),
  }));
}

export async function readCandles(symbol, tf, fromMs, toMs, opts = {}) {
  const from = Number(fromMs);
  const to = Number(toMs);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];

  const span = to - from;
  if (span <= READ_CANDLES_SLICE_MS) {
    return readCandlesSlice(symbol, tf, from, to, opts);
  }

  const out = [];
  for (let cursor = from; cursor < to; cursor += READ_CANDLES_SLICE_MS) {
    const sliceTo = Math.min(to, cursor + READ_CANDLES_SLICE_MS);
    const part = await readCandlesSlice(symbol, tf, cursor, sliceTo, opts);
    if (part.length) out.push(...part);
  }
  return out;
}
