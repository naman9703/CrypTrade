-- Phase 3A: strategies scoped to trading_modes for filtering / instances.

ALTER TABLE strategies
  ADD COLUMN IF NOT EXISTS mode_id SMALLINT REFERENCES trading_modes (id);

CREATE INDEX IF NOT EXISTS idx_strategies_mode ON strategies (mode_id, is_archived);
