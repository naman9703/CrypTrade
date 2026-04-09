/**
 * Supertrend — Pine v4 `study("Supertrend")` (TradingView built-in) line-for-line semantics.
 *
 * Pine reference (execution order per bar, `hl2` source, `changeATR` = Wilder `atr(Periods)`):
 *   atr  = changeATR ? atr(Periods) : sma(tr, Periods)
 *   up   = src - Multiplier * atr
 *   up1  = nz(up[1], up)                       // prior finalized up, else current basic
 *   up  := close[1] > up1 ? max(up, up1) : up   // prior bar close vs up1; up = basic before :=
 *   dn   = src + Multiplier * atr
 *   dn1  = nz(dn[1], dn)
 *   dn  := close[1] < dn1 ? min(dn, dn1) : dn
 *   trend := nz(trend[1], 1)
 *   trend := trend == -1 and close > dn1 ? 1 : trend == 1 and close < up1 ? -1 : trend
 *   buySignal  = trend == 1 and trend[1] == -1
 *   sellSignal = trend == -1 and trend[1] == 1
 *
 * Realtime: replays the same logic with the **current** bar’s `close` updated each tick (WebSocket
 * kline). That matches TradingView when the chart updates on the open candle. Historical bars use
 * their final OHLC.
 *
 * @param {Array<{ ts: number, open: number, high: number, low: number, close: number }>} candles oldest first
 * @param {{ period?: number, multiplier?: number, wilderAtr?: boolean }} opts — `wilderAtr: true` <=> Pine `changeATR: true`
 * @returns {Array<{ ts: number, ready: boolean, up?: number, dn?: number, trend?: number, line?: number, buySignal?: boolean, sellSignal?: boolean }>}
 */
export function computeSupertrendSeries(candles, opts = {}) {
  const period = Math.max(1, Number(opts.period ?? 10));
  const multiplier = Number(opts.multiplier ?? 3);
  const wilderAtr = opts.wilderAtr !== false;

  const out = [];
  const trArr = [];
  let atr = null;
  let prevClose = null;
  let finalUp = null;
  let finalDn = null;
  let trend = 1;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const high = Number(c.high);
    const low = Number(c.low);
    const close = Number(c.close);
    const hl2 = (high + low) / 2;

    const tr =
      prevClose == null
        ? high - low
        : Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trArr.push(tr);

    if (i < period - 1) {
      out.push({ ts: c.ts, ready: false });
      prevClose = close;
      continue;
    }

    if (wilderAtr) {
      if (i === period - 1) {
        atr = trArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
      } else {
        atr = (atr * (period - 1) + tr) / period;
      }
    } else {
      atr = trArr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
    }

    if (!Number.isFinite(atr) || atr <= 0) {
      out.push({ ts: c.ts, ready: false });
      prevClose = close;
      continue;
    }

    const basicUp = hl2 - multiplier * atr;
    const basicDn = hl2 + multiplier * atr;
    const up1 = finalUp ?? basicUp;
    const dn1 = finalDn ?? basicDn;
    const pc = prevClose;

    const newFinalUp = pc > up1 ? Math.max(basicUp, up1) : basicUp;
    const newFinalDn = pc < dn1 ? Math.min(basicDn, dn1) : basicDn;

    const prevTrend = trend;
    if (trend === -1 && close > dn1) trend = 1;
    else if (trend === 1 && close < up1) trend = -1;

    const buySignal = trend === 1 && prevTrend === -1;
    const sellSignal = trend === -1 && prevTrend === 1;

    finalUp = newFinalUp;
    finalDn = newFinalDn;
    prevClose = close;

    out.push({
      ts: c.ts,
      ready: true,
      up: newFinalUp,
      dn: newFinalDn,
      trend,
      line: trend === 1 ? newFinalUp : newFinalDn,
      buySignal,
      sellSignal,
      /** Wilder/SMA ATR at this bar — for signal strength / filters. */
      atr: atr,
    });
  }

  return out;
}
