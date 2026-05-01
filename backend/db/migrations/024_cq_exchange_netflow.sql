-- CQ exchange netflow (USD, approximated from native × spot at ingest time)
ALTER TABLE market_intelligence
  ADD COLUMN IF NOT EXISTS cq_exchange_netflow_usd_24h NUMERIC(20,2);
