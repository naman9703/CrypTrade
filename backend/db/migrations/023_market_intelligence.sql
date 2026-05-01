-- Market intelligence snapshots (hypertable)
CREATE TABLE market_intelligence (
  id              UUID DEFAULT gen_random_uuid(),
  symbol          TEXT NOT NULL,
  captured_at     TIMESTAMPTZ NOT NULL,

  fear_greed_value       SMALLINT,
  fear_greed_label       TEXT,
  fear_greed_24h_change  SMALLINT,

  funding_rate           NUMERIC(12,8),
  funding_rate_30d_avg   NUMERIC(12,8),
  funding_rate_zscore    NUMERIC(6,3),
  funding_predicted      NUMERIC(12,8),
  funding_next_time      TIMESTAMPTZ,
  funding_bias           TEXT,

  oi_usdt                NUMERIC(20,2),
  oi_change_4h_pct       NUMERIC(8,4),
  oi_change_24h_pct      NUMERIC(8,4),

  long_short_ratio       NUMERIC(8,4),
  top_trader_ls_ratio    NUMERIC(8,4),

  book_imbalance_ratio   NUMERIC(6,4),
  bid_wall_usdt          NUMERIC(20,2),
  ask_wall_usdt          NUMERIC(20,2),

  options_max_pain          NUMERIC(20,2),
  options_max_pain_distance NUMERIC(8,4),
  options_put_call_ratio    NUMERIC(6,4),
  options_implied_vol       NUMERIC(8,4),
  options_gex               NUMERIC(20,2),
  options_gex_regime        TEXT,
  options_bias              TEXT,

  exchange_netflow_24h      NUMERIC(20,2),
  exchange_netflow_zscore   NUMERIC(6,3),
  stablecoin_inflow_24h     NUMERIC(20,2),

  social_sentiment_score    NUMERIC(6,3),
  social_volume_change_pct  NUMERIC(8,4),

  tf_confluence_score       SMALLINT,
  tf_breakdown              JSONB,
  tf_bias                   TEXT,

  realised_vol_24h          NUMERIC(8,4),
  implied_vol               NUMERIC(8,4),
  iv_rv_ratio               NUMERIC(6,3),
  vol_regime                TEXT,
  adx_regime                TEXT,
  combined_regime           TEXT,

  composite_score           SMALLINT,
  composite_bias            TEXT,
  composite_confidence      NUMERIC(6,2),
  composite_size_multiplier NUMERIC(4,2),
  bullish_signals           JSONB DEFAULT '[]',
  bearish_signals           JSONB DEFAULT '[]',
  signal_breakdown          JSONB DEFAULT '{}',

  PRIMARY KEY (symbol, captured_at)
);

SELECT create_hypertable('market_intelligence', 'captured_at',
  chunk_time_interval => INTERVAL '1 day');

CREATE INDEX idx_mi_symbol_time
  ON market_intelligence(symbol, captured_at DESC);

-- Market events calendar
CREATE TABLE market_events (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_type   TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  event_time   TIMESTAMPTZ NOT NULL,
  asset        TEXT,
  impact_level TEXT NOT NULL DEFAULT 'medium',
  source       TEXT,
  is_recurring BOOLEAN DEFAULT false,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_market_events_upcoming
  ON market_events(event_time);

-- Whale alerts
CREATE TABLE whale_alerts (
  id            UUID DEFAULT gen_random_uuid(),
  symbol        TEXT NOT NULL,
  amount_usd    NUMERIC(20,2),
  direction     TEXT,
  from_entity   TEXT,
  to_entity     TEXT,
  tx_hash       TEXT,
  alerted_at    TIMESTAMPTZ NOT NULL,
  impact_score  SMALLINT,
  PRIMARY KEY   (id, alerted_at)
);

SELECT create_hypertable('whale_alerts', 'alerted_at',
  chunk_time_interval => INTERVAL '7 days');
