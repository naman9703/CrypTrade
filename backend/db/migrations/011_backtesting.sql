-- Phase 1A — 011: backtest_runs + backtest_trades

CREATE TABLE backtest_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_version_id UUID NOT NULL REFERENCES strategy_versions (id),
  user_id UUID NOT NULL REFERENCES users (id),
  label TEXT,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  start_date TIMESTAMPTZ NOT NULL,
  end_date TIMESTAMPTZ NOT NULL,
  initial_capital NUMERIC(18, 8) NOT NULL,
  final_capital NUMERIC(18, 8),
  engine_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  progress_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
  total_trades INTEGER,
  win_rate_pct NUMERIC(6, 2),
  total_pnl_usdt NUMERIC(18, 8),
  max_drawdown_pct NUMERIC(6, 2),
  sharpe_ratio NUMERIC(8, 4),
  profit_factor NUMERIC(10, 4),
  metrics JSONB,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bt_runs_version ON backtest_runs (strategy_version_id, created_at DESC);

CREATE TABLE backtest_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  backtest_run_id UUID NOT NULL REFERENCES backtest_runs (id) ON DELETE CASCADE,
  trade_number INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry_time TIMESTAMPTZ NOT NULL,
  exit_time TIMESTAMPTZ,
  entry_price NUMERIC(18, 8) NOT NULL,
  exit_price NUMERIC(18, 8),
  quantity NUMERIC(18, 8) NOT NULL,
  sl_price NUMERIC(18, 8),
  tp_price NUMERIC(18, 8),
  exit_reason TEXT,
  gross_pnl NUMERIC(18, 8),
  fees_usdt NUMERIC(18, 8),
  net_pnl NUMERIC(18, 8),
  roi_pct NUMERIC(10, 4),
  capital_after NUMERIC(18, 8),
  mae NUMERIC(18, 8),
  mfe NUMERIC(18, 8),
  signal_context JSONB
);

CREATE INDEX idx_bt_trades_run ON backtest_trades (backtest_run_id, trade_number);
