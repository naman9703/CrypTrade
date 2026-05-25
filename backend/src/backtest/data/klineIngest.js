/**
 * OHLC backfill + read from `ohlcv_candles` (Timescale).
 */

import { getPool } from "../../db/pool.js";
import { fetchBinanceKlinesRange } from "../../lib/binanceKlinesRest.js";
import { binanceInterval, tfToMs } from "./timeframe.js";

function normalizeSymbol(symbol) {
  return String(symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

async function upsertCandles(symbol, tf, rows, source = "binance") {
  const pool = getPool();
  if (!pool || !rows.length) return 0;
  const sql = `
    INSERT INTO ohlcv_candles (symbol, timeframe, open_time, open, high, low, close, volume, source)
    VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5, $6, $7, $8, $9)
    ON CONFLICT (symbol, timeframe, open_time)
    DO UPDATE SET
      open = EXCLUDED.open,
      high = EXCLUDED.high,
      low = EXCLUDED.low,
      close = EXCLUDED.close,
      volume = EXCLUDED.volume,
      source = EXCLUDED.source
  `;
  let inserted = 0;
  for (const c of rows) {
    const res = await pool.query(sql, [
      symbol,
      tf,
      c.ts,
      c.open,
      c.high,
      c.low,
      c.close,
      c.volume ?? 0,
      source,
    ]);
    inserted += res.rowCount > 0 ? 1 : 0;
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

  const fetched = await fetchBinanceKlinesRange({
    symbol: sym,
    interval,
    startTime: fromMs,
    endTime: toMs,
    feedKind,
  });

  const inserted = await upsertCandles(sym, timeframe, fetched, market === "spot" ? "binance_spot" : "binance_futures");
  const gaps = Math.max(0, expected - fetched.length);
  return { inserted, gaps };
}

/**
 * @returns {Promise<Array<{ ts: number, open: number, high: number, low: number, close: number, volume: number }>>}
 */
export async function readCandles(symbol, tf, fromMs, toMs) {
  const pool = getPool();
  if (!pool) throw new Error("db_not_configured");
  const sym = normalizeSymbol(symbol);
  const timeframe = String(tf || "15m").toLowerCase();
  const from = Number(fromMs);
  const to = Number(toMs);
  const r = await pool.query(
    `SELECT EXTRACT(EPOCH FROM open_time) * 1000 AS ts,
            open::float8 AS open, high::float8 AS high, low::float8 AS low,
            close::float8 AS close, volume::float8 AS volume
       FROM ohlcv_candles
      WHERE symbol = $1 AND timeframe = $2
        AND open_time >= to_timestamp($3 / 1000.0)
        AND open_time < to_timestamp($4 / 1000.0)
      ORDER BY open_time ASC`,
    [sym, timeframe, from, to],
  );
  return r.rows.map((row) => ({
    ts: Math.round(Number(row.ts)),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume) || 0,
  }));
}
