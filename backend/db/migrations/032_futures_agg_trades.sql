-- Phase: futures aggTrades cache for tick trailing audit

CREATE TABLE IF NOT EXISTS futures_agg_trades (
  symbol TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  price NUMERIC(18, 8) NOT NULL,
  qty NUMERIC(18, 8),
  is_buyer_maker BOOLEAN,
  agg_id BIGINT NOT NULL,
  PRIMARY KEY (symbol, ts, agg_id)
);

SELECT create_hypertable(
  'futures_agg_trades',
  'ts',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS futures_agg_trades_symbol_ts_idx
  ON futures_agg_trades (symbol, ts);

ALTER TABLE futures_agg_trades SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'symbol'
);

SELECT add_compression_policy('futures_agg_trades', INTERVAL '7 days', if_not_exists => TRUE);
