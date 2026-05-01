-- Phase 3D — strategy/instance config split
--
-- Mental model:
--   STRATEGY  = signal brain (HOW to decide to trade) — reusable across instances
--   INSTANCE  = operational deployment (WHAT to trade, how much capital, what risk)
--
-- This migration introduces typed JSONB blocks on strategy_versions for the signal
-- brain layers, and adds inst_* columns on bot_instances for operational config.
--
-- Backward compatibility:
--   - cfg_raw on strategy_versions remains the merged "flat" payload the bot engine
--     consumes (preserves runtime behavior of bot.js without a rewrite).
--   - Existing scalar cfg_* columns on strategy_versions stay in place; the new
--     typed JSONB blocks are additive and authoritative for "what is the strategy".
--   - inst_* columns on bot_instances are NULL-able; when NULL the engine falls back
--     to the strategy's flat cfg_raw values (current behavior).

-- ─── strategy_versions: typed signal-brain blocks ──────────────────────────────

ALTER TABLE strategy_versions
  ADD COLUMN IF NOT EXISTS primary_signal_type TEXT NOT NULL DEFAULT 'SUPERTREND',
  ADD COLUMN IF NOT EXISTS cfg_supertrend JSONB,
  ADD COLUMN IF NOT EXISTS cfg_surf_pulse JSONB,
  ADD COLUMN IF NOT EXISTS cfg_ema_cross  JSONB,
  ADD COLUMN IF NOT EXISTS cfg_rsi        JSONB,
  ADD COLUMN IF NOT EXISTS cfg_ai         JSONB,
  ADD COLUMN IF NOT EXISTS cfg_entry      JSONB,
  ADD COLUMN IF NOT EXISTS cfg_exit       JSONB,
  ADD COLUMN IF NOT EXISTS cfg_leverage   JSONB;

ALTER TABLE strategy_versions
  ADD CONSTRAINT chk_strategy_primary_signal_type
  CHECK (primary_signal_type IN ('SUPERTREND', 'SURF_PULSE_ML', 'EMA_CROSS', 'RSI', 'MANUAL'));

CREATE INDEX IF NOT EXISTS idx_sv_primary_signal_type
  ON strategy_versions (primary_signal_type);

-- ─── bot_instances: operational config (per-deployment) ───────────────────────

ALTER TABLE bot_instances
  ADD COLUMN IF NOT EXISTS inst_symbol              TEXT,
  ADD COLUMN IF NOT EXISTS inst_timeframe           TEXT,
  ADD COLUMN IF NOT EXISTS inst_symbol_mode         TEXT,
  ADD COLUMN IF NOT EXISTS inst_market_mode         TEXT,
  ADD COLUMN IF NOT EXISTS inst_universe            JSONB,
  ADD COLUMN IF NOT EXISTS inst_risk_per_trade      NUMERIC,
  ADD COLUMN IF NOT EXISTS inst_risk_unit           TEXT,
  ADD COLUMN IF NOT EXISTS inst_max_daily_loss      NUMERIC,
  ADD COLUMN IF NOT EXISTS inst_max_daily_loss_unit TEXT,
  ADD COLUMN IF NOT EXISTS inst_capital_mode        TEXT,
  ADD COLUMN IF NOT EXISTS inst_capital_usdt        NUMERIC,
  ADD COLUMN IF NOT EXISTS inst_capital_pct         NUMERIC,
  ADD COLUMN IF NOT EXISTS inst_compound_pnl        BOOLEAN;
