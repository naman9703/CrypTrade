/**
 * Upsert finalized live Binance candles into `ohlcv_candles` for backtest reuse.
 * Fire-and-forget with debounce — must never block the trading loop.
 */

import { getPool } from "../../db/pool.js";

const pending = new Map();
let flushTimer = null;
const FLUSH_MS = 250;

function archiveEnabled() {
  const raw = String(process.env.BACKTEST_ARCHIVE_LIVE_OHLCV ?? "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no";
}

async function flushPending() {
  const batch = [...pending.values()];
  pending.clear();
  flushTimer = null;
  const pool = getPool();
  if (!pool || !batch.length) return;

  const sql = `
    INSERT INTO ohlcv_candles (symbol, timeframe, open_time, open, high, low, close, volume, source)
    VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5, $6, $7, $8, 'binance_live')
    ON CONFLICT (symbol, timeframe, open_time)
    DO UPDATE SET
      open = EXCLUDED.open,
      high = EXCLUDED.high,
      low = EXCLUDED.low,
      close = EXCLUDED.close,
      volume = EXCLUDED.volume
  `;

  for (const row of batch) {
    try {
      await pool.query(sql, [
        row.symbol,
        row.timeframe,
        row.ts,
        row.open,
        row.high,
        row.low,
        row.close,
        row.volume,
      ]);
    } catch {
      /* never throw into bot loop */
    }
  }
}

/**
 * @param {{ symbol: string, timeframe: string, candle: { ts: number, open: number, high: number, low: number, close: number, volume?: number } }} args
 */
export function scheduleArchiveLiveOhlcvCandle({ symbol, timeframe, candle }) {
  if (!archiveEnabled()) return;
  if (!getPool() || !symbol || !timeframe || !candle) return;
  const ts = Number(candle.ts);
  if (!Number.isFinite(ts) || ts <= 0) return;

  const key = `${symbol}:${timeframe}`;
  pending.set(key, {
    symbol,
    timeframe,
    ts,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.volume) || 0,
  });

  if (flushTimer == null) {
    flushTimer = setTimeout(() => {
      flushPending().catch(() => {});
    }, FLUSH_MS);
    flushTimer.unref?.();
  }
}
