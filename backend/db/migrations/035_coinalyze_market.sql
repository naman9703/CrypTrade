-- Coinalyze aggregated futures data (liquidations, OI, L/S) — research ingest.

CREATE TABLE IF NOT EXISTS historical_coinalyze_liquidations (
  symbol            TEXT NOT NULL,
  coinalyze_symbol  TEXT NOT NULL,
  ts                TIMESTAMPTZ NOT NULL,
  interval_name     TEXT NOT NULL DEFAULT '1hour',
  liq_long_usd      NUMERIC(20, 2),
  liq_short_usd     NUMERIC(20, 2),
  source            TEXT NOT NULL DEFAULT 'coinalyze',
  PRIMARY KEY (symbol, ts, interval_name)
);

SELECT create_hypertable(
  'historical_coinalyze_liquidations',
  'ts',
  chunk_time_interval => INTERVAL '30 days',
  if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_hcl_symbol_ts
  ON historical_coinalyze_liquidations (symbol, ts DESC);

CREATE TABLE IF NOT EXISTS historical_coinalyze_open_interest (
  symbol            TEXT NOT NULL,
  coinalyze_symbol  TEXT NOT NULL,
  ts                TIMESTAMPTZ NOT NULL,
  interval_name     TEXT NOT NULL DEFAULT '1hour',
  oi_close_usd      NUMERIC(20, 2),
  source            TEXT NOT NULL DEFAULT 'coinalyze',
  PRIMARY KEY (symbol, ts, interval_name)
);

SELECT create_hypertable(
  'historical_coinalyze_open_interest',
  'ts',
  chunk_time_interval => INTERVAL '30 days',
  if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_hcoi_symbol_ts
  ON historical_coinalyze_open_interest (symbol, ts DESC);
