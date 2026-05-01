-- Phase 1A — 005: wallet_snapshots (Timescale hypertable)
-- PK includes captured_at (Timescale: unique constraints must include partition column)

CREATE TABLE wallet_snapshots (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  snapshot_type TEXT NOT NULL,
  total_usdt NUMERIC(18, 8) NOT NULL,
  available_usdt NUMERIC(18, 8) NOT NULL,
  in_positions_usdt NUMERIC(18, 8) NOT NULL,
  balances JSONB NOT NULL,
  positions JSONB,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (captured_at, id)
);

SELECT create_hypertable(
  'wallet_snapshots',
  'captured_at',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => TRUE
);

CREATE INDEX idx_wallet_account_time ON wallet_snapshots (account_id, captured_at DESC);

ALTER TABLE wallet_snapshots SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'account_id'
);

SELECT add_compression_policy('wallet_snapshots', INTERVAL '30 days', if_not_exists => TRUE);
