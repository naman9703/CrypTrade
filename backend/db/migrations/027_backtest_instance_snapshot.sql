-- 027 — Backtest instance snapshot audit fields
-- Backtests may run against a strategy-only snapshot or a live-equivalent
-- strategy + bot_instance operational merge. Store the source and merged
-- operational inputs so completed runs remain reproducible after instance edits.

ALTER TABLE backtest_runs
  ADD COLUMN IF NOT EXISTS bot_instance_id UUID REFERENCES bot_instances (id),
  ADD COLUMN IF NOT EXISTS instance_operational_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS config_source TEXT NOT NULL DEFAULT 'strategy_only';

CREATE INDEX IF NOT EXISTS idx_bt_runs_bot_instance
  ON backtest_runs (bot_instance_id, created_at DESC)
  WHERE bot_instance_id IS NOT NULL;
