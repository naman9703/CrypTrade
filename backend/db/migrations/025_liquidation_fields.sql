-- Binance forceOrder stream aggregates (rolling 4h), persisted on intelligence snapshots
ALTER TABLE market_intelligence
  ADD COLUMN IF NOT EXISTS liq_long_usd    NUMERIC(20,2),
  ADD COLUMN IF NOT EXISTS liq_short_usd   NUMERIC(20,2),
  ADD COLUMN IF NOT EXISTS liq_total_usd   NUMERIC(20,2),
  ADD COLUMN IF NOT EXISTS liq_dominance   TEXT,
  ADD COLUMN IF NOT EXISTS liq_intensity   TEXT;
