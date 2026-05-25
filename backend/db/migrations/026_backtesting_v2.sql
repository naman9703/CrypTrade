-- 026 — Backtesting v2: simulator engine schema + historical macro tables
-- Extends 011_backtesting (backtest_runs, backtest_trades) and adds
-- backtest_equity_points, backtest_optimizations, plus historical_funding_rates,
-- historical_fear_greed, historical_open_interest used for approximate
-- intelligence-gate replay.

-- ─── backtest_runs additions (idempotent) ──────────────────────────────────
ALTER TABLE backtest_runs
  ADD COLUMN IF NOT EXISTS cost_model         JSONB,
  ADD COLUMN IF NOT EXISTS gate_mode          TEXT,
  ADD COLUMN IF NOT EXISTS config_snapshot    JSONB,
  ADD COLUMN IF NOT EXISTS walk_forward_split JSONB,
  ADD COLUMN IF NOT EXISTS finished_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS optimization_id    UUID,
  ADD COLUMN IF NOT EXISTS shadow_run_id      UUID,
  ADD COLUMN IF NOT EXISTS data_coverage_pct  NUMERIC(6, 2);

CREATE INDEX IF NOT EXISTS idx_bt_runs_user_created
  ON backtest_runs (user_id, created_at DESC);

-- ─── backtest_trades additions (idempotent) ────────────────────────────────
ALTER TABLE backtest_trades
  ADD COLUMN IF NOT EXISTS funding_paid        NUMERIC(18, 8) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS slippage_cost       NUMERIC(18, 8) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bars_held           INTEGER,
  ADD COLUMN IF NOT EXISTS mae_pct             NUMERIC(10, 4),
  ADD COLUMN IF NOT EXISTS mfe_pct             NUMERIC(10, 4),
  ADD COLUMN IF NOT EXISTS intel_score_at_entry NUMERIC(6, 2),
  ADD COLUMN IF NOT EXISTS gate_action         TEXT;

-- ─── backtest_equity_points ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS backtest_equity_points (
  run_id        UUID NOT NULL REFERENCES backtest_runs (id) ON DELETE CASCADE,
  ts            TIMESTAMPTZ NOT NULL,
  equity        NUMERIC(18, 8) NOT NULL,
  drawdown_pct  NUMERIC(8, 4) NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, ts)
);

CREATE INDEX IF NOT EXISTS idx_bt_equity_run_ts
  ON backtest_equity_points (run_id, ts);

-- ─── backtest_optimizations ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS backtest_optimizations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users (id),
  strategy_version_id UUID NOT NULL REFERENCES strategy_versions (id),
  symbol              TEXT NOT NULL,
  timeframe           TEXT NOT NULL,
  param_grid          JSONB NOT NULL,
  walk_forward_split  JSONB,
  n_runs              INTEGER NOT NULL DEFAULT 0,
  n_completed         INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'queued',
  best_run_id         UUID REFERENCES backtest_runs (id),
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bt_opt_user_created
  ON backtest_optimizations (user_id, created_at DESC);

-- ─── historical_funding_rates ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS historical_funding_rates (
  symbol        TEXT NOT NULL,
  ts            TIMESTAMPTZ NOT NULL,
  funding_rate  NUMERIC(12, 8) NOT NULL,
  PRIMARY KEY (symbol, ts)
);

SELECT create_hypertable(
  'historical_funding_rates',
  'ts',
  chunk_time_interval => INTERVAL '30 days',
  if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_hfr_symbol_ts
  ON historical_funding_rates (symbol, ts DESC);

-- ─── historical_fear_greed ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS historical_fear_greed (
  ts     TIMESTAMPTZ PRIMARY KEY,
  value  INTEGER NOT NULL,
  label  TEXT
);

CREATE INDEX IF NOT EXISTS idx_hfg_ts
  ON historical_fear_greed (ts DESC);

-- ─── historical_open_interest ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS historical_open_interest (
  symbol            TEXT NOT NULL,
  ts                TIMESTAMPTZ NOT NULL,
  oi_usdt           NUMERIC(20, 2),
  long_short_ratio  NUMERIC(10, 4),
  PRIMARY KEY (symbol, ts)
);

SELECT create_hypertable(
  'historical_open_interest',
  'ts',
  chunk_time_interval => INTERVAL '30 days',
  if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_hoi_symbol_ts
  ON historical_open_interest (symbol, ts DESC);
