-- Strategy testing battery: full validation (walk-forward, Monte Carlo,
-- parameter sensitivity, cost + black-swan stress) seeded from a completed
-- backtest run. Report, grade, live-fidelity score, and suggested config
-- are stored as JSONB so the battery can evolve without schema churn.

CREATE TABLE IF NOT EXISTS backtest_strategy_tests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users (id),
  seed_run_id         UUID NOT NULL REFERENCES backtest_runs (id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|failed|cancelled
  progress_pct        NUMERIC(5, 1) NOT NULL DEFAULT 0,
  current_phase       TEXT,
  grade               TEXT,            -- A|B|C|F
  live_fidelity_score NUMERIC(5, 1),   -- 0-100
  report              JSONB,
  suggestion          JSONB,
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_backtest_strategy_tests_user
  ON backtest_strategy_tests (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_backtest_strategy_tests_seed_run
  ON backtest_strategy_tests (seed_run_id);
