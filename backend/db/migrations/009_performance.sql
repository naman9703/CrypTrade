-- Phase 1A — 009: strategy_performance (one row per strategy_version)

CREATE TABLE strategy_performance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_version_id UUID NOT NULL REFERENCES strategy_versions (id) ON DELETE CASCADE,
  total_trades INTEGER NOT NULL DEFAULT 0,
  winning_trades INTEGER NOT NULL DEFAULT 0,
  losing_trades INTEGER NOT NULL DEFAULT 0,
  win_rate_pct NUMERIC(6, 2) NOT NULL DEFAULT 0,
  total_pnl_usdt NUMERIC(18, 8) NOT NULL DEFAULT 0,
  avg_win_usdt NUMERIC(18, 8),
  avg_loss_usdt NUMERIC(18, 8),
  profit_factor NUMERIC(10, 4),
  max_drawdown_usdt NUMERIC(18, 8),
  max_drawdown_pct NUMERIC(6, 2),
  sharpe_ratio NUMERIC(8, 4),
  avg_hold_sec INTEGER,
  avg_roi_pct NUMERIC(10, 4),
  last_calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_sv_perf UNIQUE (strategy_version_id)
);
