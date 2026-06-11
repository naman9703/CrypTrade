-- Backtest Tier B: Binance kline taker-buy base volume for order-flow delta approximation.

ALTER TABLE ohlcv_candles ADD COLUMN IF NOT EXISTS taker_buy_volume NUMERIC(24, 8);
