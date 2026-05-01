-- Phase 4 — reward/risk ratio (avg win / |avg loss|) persisted with other performance metrics.

ALTER TABLE strategy_performance
  ADD COLUMN IF NOT EXISTS rr_ratio NUMERIC(10, 4);
