-- Binance Vision feeds for MLCTS backtest (metrics OI + bookDepth imbalance)

CREATE TABLE IF NOT EXISTS futures_vision_metrics (
  symbol              TEXT NOT NULL,
  ts                  TIMESTAMPTZ NOT NULL,
  oi_contracts        NUMERIC(24, 8),
  oi_usdt             NUMERIC(24, 2),
  taker_ls_ratio      NUMERIC(12, 8),
  long_short_ratio    NUMERIC(12, 8),
  PRIMARY KEY (symbol, ts)
);

SELECT create_hypertable(
  'futures_vision_metrics',
  'ts',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_fvm_symbol_ts
  ON futures_vision_metrics (symbol, ts DESC);

CREATE TABLE IF NOT EXISTS futures_book_depth_imbalance (
  symbol              TEXT NOT NULL,
  ts                  TIMESTAMPTZ NOT NULL,
  imbalance_ratio     NUMERIC(8, 6) NOT NULL,
  bid_notional        NUMERIC(24, 2),
  ask_notional        NUMERIC(24, 2),
  PRIMARY KEY (symbol, ts)
);

SELECT create_hypertable(
  'futures_book_depth_imbalance',
  'ts',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_fbdi_symbol_ts
  ON futures_book_depth_imbalance (symbol, ts DESC);
