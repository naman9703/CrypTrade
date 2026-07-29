-- Binance USD-M forceOrder (liquidation) tick archive for cascade research + live audit

CREATE TABLE IF NOT EXISTS force_orders (
  symbol TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  side TEXT NOT NULL,
  price NUMERIC(18, 8) NOT NULL,
  qty NUMERIC(18, 8) NOT NULL,
  notional_usd NUMERIC(18, 4) NOT NULL,
  order_id BIGINT,
  PRIMARY KEY (symbol, ts, side, price, qty)
);

SELECT create_hypertable(
  'force_orders',
  'ts',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS force_orders_symbol_ts_idx
  ON force_orders (symbol, ts DESC);

ALTER TABLE force_orders SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'symbol'
);

SELECT add_compression_policy('force_orders', INTERVAL '7 days', if_not_exists => TRUE);
