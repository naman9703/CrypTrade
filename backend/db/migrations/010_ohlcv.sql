-- Phase 1A — 010: ohlcv_candles (Timescale hypertable)
-- PK includes open_time (partition column). Surrogate id supports internal references.

CREATE TABLE ohlcv_candles (
  id BIGSERIAL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  open_time TIMESTAMPTZ NOT NULL,
  open NUMERIC(18, 8) NOT NULL,
  high NUMERIC(18, 8) NOT NULL,
  low NUMERIC(18, 8) NOT NULL,
  close NUMERIC(18, 8) NOT NULL,
  volume NUMERIC(24, 8) NOT NULL,
  quote_volume NUMERIC(24, 8),
  trades_count INTEGER,
  source TEXT NOT NULL DEFAULT 'binance',
  PRIMARY KEY (open_time, id)
);

SELECT create_hypertable(
  'ohlcv_candles',
  'open_time',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

CREATE UNIQUE INDEX unique_ohlcv ON ohlcv_candles (symbol, timeframe, open_time);

ALTER TABLE ohlcv_candles SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'symbol, timeframe'
);

SELECT add_compression_policy('ohlcv_candles', INTERVAL '7 days', if_not_exists => TRUE);
