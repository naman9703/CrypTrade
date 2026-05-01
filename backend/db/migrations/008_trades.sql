-- Phase 1A — 008: trade_signals, trades, trade_fills
-- strategy_version_id on trades supports idx_trades_strategy / PnL roll-up without always joining bot_instances.

CREATE TABLE trade_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id UUID NOT NULL REFERENCES bot_instances (id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  bar_close_time TIMESTAMPTZ NOT NULL,
  st_value NUMERIC,
  ai_probability NUMERIC,
  mde_score NUMERIC,
  signal_strength NUMERIC,
  was_executed BOOLEAN NOT NULL DEFAULT false,
  gate_reason TEXT,
  raw_context JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_signals_instance_time ON trade_signals (instance_id, created_at DESC);

CREATE TABLE trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id UUID NOT NULL REFERENCES bot_instances (id) ON DELETE CASCADE,
  strategy_version_id UUID REFERENCES strategy_versions (id),
  signal_id UUID REFERENCES trade_signals (id),
  symbol TEXT NOT NULL,
  market_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  status TEXT NOT NULL,
  entry_price NUMERIC(18, 8),
  exit_price NUMERIC(18, 8),
  quantity NUMERIC(18, 8),
  notional_usdt NUMERIC(18, 8),
  leverage INTEGER,
  sl_price NUMERIC(18, 8),
  tp_price NUMERIC(18, 8),
  exit_reason TEXT,
  gross_pnl NUMERIC(18, 8),
  fees_usdt NUMERIC(18, 8),
  net_pnl NUMERIC(18, 8),
  roi_pct NUMERIC(10, 4),
  hold_duration_sec INTEGER,
  binance_order_ids TEXT[],
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_trades_instance ON trades (instance_id, closed_at DESC);
CREATE INDEX idx_trades_strategy ON trades (strategy_version_id);
CREATE INDEX idx_trades_symbol_time ON trades (symbol, closed_at DESC);

CREATE TABLE trade_fills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id UUID NOT NULL REFERENCES trades (id) ON DELETE CASCADE,
  binance_order_id TEXT NOT NULL,
  binance_trade_id TEXT,
  fill_type TEXT NOT NULL,
  side TEXT NOT NULL,
  price NUMERIC(18, 8) NOT NULL,
  quantity NUMERIC(18, 8) NOT NULL,
  fee_asset TEXT,
  fee_amount NUMERIC(18, 8),
  fee_usdt NUMERIC(18, 8),
  is_maker BOOLEAN,
  filled_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_fills_trade ON trade_fills (trade_id);
