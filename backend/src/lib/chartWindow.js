/**
 * Max kline count needed to cover `hours` of history for a Binance interval string (e.g. 1m, 5m, 1h).
 * Capped so buffers and payloads stay bounded.
 */
export function maxBarsForHistory(timeframe, hours = 24) {
  const tf = String(timeframe || "1m").toLowerCase().trim();
  const h = Math.max(0.25, Number(hours) || 24);
  const totalMinutes = h * 60;
  const m = tf.match(/^(\d+)(m|h|d)$/);
  if (!m) return Math.min(3000, Math.ceil(totalMinutes));

  const n = Number(m[1]);
  const u = m[2];
  let bars;
  if (u === "m") bars = Math.ceil(totalMinutes / n);
  else if (u === "h") bars = Math.ceil(h / n);
  else bars = Math.ceil(h / (24 * n));

  return Math.min(3000, Math.max(30, bars));
}

/** Min intraday bars to compute local weekly H/L fallback (14d), capped at Binance REST page size. */
export function mlctsMinKlineBars(timeframe, days = 14) {
  const tf = String(timeframe || "15m").toLowerCase().trim();
  const d = Math.max(7, Number(days) || 14);
  const totalMinutes = d * 24 * 60;
  const m = tf.match(/^(\d+)(m|h|d)$/);
  if (!m) return Math.min(3000, 1500);
  const n = Number(m[1]);
  const u = m[2];
  let minutesPerBar;
  if (u === "m") minutesPerBar = n;
  else if (u === "h") minutesPerBar = n * 60;
  else minutesPerBar = n * 24 * 60;
  return Math.min(3000, Math.max(672, Math.ceil(totalMinutes / minutesPerBar)));
}
