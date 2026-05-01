-- Phase 1A — 004: accounts + api_credentials

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mode_id SMALLINT NOT NULL REFERENCES trading_modes (id),
  user_id UUID NOT NULL REFERENCES users (id),
  label TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'main',
  binance_uid TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_accounts_mode ON accounts (mode_id, is_active);

CREATE TRIGGER trg_accounts_updated_at
BEFORE UPDATE ON accounts
FOR EACH ROW
EXECUTE PROCEDURE update_updated_at_column();

CREATE TABLE api_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  api_key TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  encryption_ver SMALLINT NOT NULL DEFAULT 1,
  permissions JSONB,
  last_verified_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_cred_account ON api_credentials (account_id, is_active);
