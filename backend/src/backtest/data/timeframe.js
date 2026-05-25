/** Supported backtest / OHLC timeframes (Binance interval strings). */
export const SUPPORTED_TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d"];

const MS_BY_TF = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

export function tfToMs(tf) {
  const key = String(tf || "15m").toLowerCase();
  const ms = MS_BY_TF[key];
  if (!ms) throw new Error(`unsupported_timeframe:${tf}`);
  return ms;
}

export function binanceInterval(tf) {
  const key = String(tf || "15m").toLowerCase();
  if (!MS_BY_TF[key]) throw new Error(`unsupported_timeframe:${tf}`);
  return key;
}
