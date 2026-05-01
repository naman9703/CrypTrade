-- Phase 1A — 007: bot_instances, capital_allotments, instance_status_log
-- wallet_snapshots hypertable PK is (captured_at, id) — link via both columns when set.

CREATE TABLE bot_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts (id),
  strategy_version_id UUID NOT NULL REFERENCES strategy_versions (id),
  label TEXT,
  status TEXT NOT NULL DEFAULT 'stopped',
  last_start_at TIMESTAMPTZ,
  last_stop_at TIMESTAMPTZ,
  last_stop_reason TEXT,
  error_message TEXT,
  runtime_state JSONB,
  total_trades INTEGER NOT NULL DEFAULT 0,
  total_pnl_usdt NUMERIC(18, 8) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_instances_account_status ON bot_instances (account_id, status);
CREATE INDEX idx_instances_strategy_version ON bot_instances (strategy_version_id);

CREATE TRIGGER trg_bot_instances_updated_at
BEFORE UPDATE ON bot_instances
FOR EACH ROW
EXECUTE PROCEDURE update_updated_at_column();

CREATE TABLE capital_allotments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id UUID NOT NULL REFERENCES bot_instances (id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts (id),
  allotment_mode TEXT NOT NULL,
  configured_usdt NUMERIC(18, 8) NOT NULL,
  configured_pct NUMERIC(5, 2),
  reserved_usdt NUMERIC(18, 8) NOT NULL DEFAULT 0,
  realised_pnl NUMERIC(18, 8) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  wallet_snapshot_id UUID,
  wallet_snapshot_captured_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at TIMESTAMPTZ,
  CONSTRAINT fk_capital_wallet_snapshot
    FOREIGN KEY (wallet_snapshot_captured_at, wallet_snapshot_id)
    REFERENCES wallet_snapshots (captured_at, id)
);

CREATE INDEX idx_capital_account_active ON capital_allotments (account_id, status);

CREATE TABLE instance_status_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id UUID NOT NULL REFERENCES bot_instances (id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  triggered_by TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
