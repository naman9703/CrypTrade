-- Multi-coin portfolio backtest runs.
-- Single-coin runs: is_portfolio = false, symbols = NULL (unchanged).
-- Portfolio runs: is_portfolio = true, symbols = ARRAY['BTCUSDT',...], symbol = 'PORTFOLIO'.

ALTER TABLE backtest_runs
  ADD COLUMN IF NOT EXISTS symbols TEXT[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS is_portfolio BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_backtest_runs_is_portfolio
  ON backtest_runs (is_portfolio)
  WHERE is_portfolio = true;
