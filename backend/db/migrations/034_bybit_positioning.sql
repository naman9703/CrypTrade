-- Bybit positioning data (cross-venue proxy for research — not Binance ground truth).

CREATE TABLE IF NOT EXISTS historical_bybit_open_interest (
  symbol         TEXT NOT NULL,
  ts             TIMESTAMPTZ NOT NULL,
  interval_time  TEXT NOT NULL DEFAULT '15min',
  oi_base        NUMERIC(24, 8),
  oi_usdt        NUMERIC(20, 2),
  source         TEXT NOT NULL DEFAULT 'bybit',
  PRIMARY KEY (symbol, ts, interval_time)
);

SELECT create_hypertable(
  'historical_bybit_open_interest',
  'ts',
  chunk_time_interval => INTERVAL '30 days',
  if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_hboi_symbol_ts
  ON historical_bybit_open_interest (symbol, ts DESC);

CREATE TABLE IF NOT EXISTS historical_bybit_account_ratio (
  symbol   TEXT NOT NULL,
  ts       TIMESTAMPTZ NOT NULL,
  period   TEXT NOT NULL DEFAULT '1h',
  buy_ratio  NUMERIC(10, 6),
  sell_ratio NUMERIC(10, 6),
  source   TEXT NOT NULL DEFAULT 'bybit',
  PRIMARY KEY (symbol, ts, period)
);

SELECT create_hypertable(
  'historical_bybit_account_ratio',
  'ts',
  chunk_time_interval => INTERVAL '30 days',
  if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_hbar_symbol_ts
  ON historical_bybit_account_ratio (symbol, ts DESC);
