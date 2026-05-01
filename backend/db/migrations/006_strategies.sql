-- Phase 1A — 006: strategies + strategy_versions (immutable versioned config)

CREATE TABLE strategies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id),
  name TEXT NOT NULL,
  description TEXT,
  tags TEXT[],
  is_archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_strategies_user ON strategies (user_id, is_archived);

CREATE TRIGGER trg_strategies_updated_at
BEFORE UPDATE ON strategies
FOR EACH ROW
EXECUTE PROCEDURE update_updated_at_column();

CREATE TABLE strategy_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id UUID NOT NULL REFERENCES strategies (id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  label TEXT,
  promoted_from UUID REFERENCES strategy_versions (id) ON DELETE SET NULL,
  cfg_symbol TEXT,
  cfg_timeframe TEXT,
  cfg_symbol_mode TEXT,
  cfg_market_mode TEXT,
  cfg_strategy_mode TEXT,
  cfg_manual_strategy TEXT,
  cfg_ai_threshold NUMERIC,
  cfg_risk_per_trade NUMERIC,
  cfg_risk_unit TEXT,
  cfg_max_daily_loss NUMERIC,
  cfg_max_daily_loss_unit TEXT,
  cfg_capital_mode TEXT,
  cfg_capital_fixed_usdt NUMERIC,
  cfg_capital_pct NUMERIC,
  cfg_compound_pnl BOOLEAN,
  cfg_st_period INTEGER,
  cfg_st_multiplier NUMERIC,
  cfg_st_wilder_atr BOOLEAN,
  cfg_st_spot_auto BOOLEAN,
  cfg_st_futures_auto BOOLEAN,
  cfg_futures_leverage_mode TEXT,
  cfg_futures_leverage INTEGER,
  cfg_futures_fixed_sl_pct NUMERIC,
  cfg_futures_fixed_tp_pct NUMERIC,
  cfg_entry_open_style TEXT,
  cfg_max_entry_slippage_pct NUMERIC,
  cfg_max_signal_lag_ms INTEGER,
  cfg_trailing_auto BOOLEAN,
  cfg_trailing_mode TEXT,
  cfg_trail_buffer_mode TEXT,
  cfg_trail_buffer_rate NUMERIC,
  cfg_trail_open_fee_rate NUMERIC,
  cfg_trail_close_fee_rate NUMERIC,
  cfg_mde JSONB,
  cfg_universe JSONB,
  cfg_signal_gates JSONB,
  cfg_surf_pulse_ml_threshold NUMERIC,
  cfg_raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID NOT NULL REFERENCES users (id),
  UNIQUE (strategy_id, version_number)
);

CREATE OR REPLACE FUNCTION set_strategy_version_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  SELECT COALESCE(MAX(version_number), 0) + 1
  INTO NEW.version_number
  FROM strategy_versions
  WHERE strategy_id = NEW.strategy_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_strategy_version_number
BEFORE INSERT ON strategy_versions
FOR EACH ROW
EXECUTE PROCEDURE set_strategy_version_number();

CREATE INDEX idx_sv_strategy ON strategy_versions (strategy_id, version_number DESC);
