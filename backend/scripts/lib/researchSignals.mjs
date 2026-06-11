/**
 * Transparent baseline signal generators + lightweight indicators for the
 * Phase 1 research harness. Pure functions over a candle array; each baseline
 * returns a runner adapter `(bar, idx, ctx) => {action, reason}|null` that only
 * fires on the transition bar (not every bar) and respects a small cooldown so
 * trade frequency is realistic.
 */

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (!values.length) return out;
  const k = 2 / (period + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = new Array(closes.length).fill(null);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const mean = sum / period;
    let varSum = 0;
    for (let j = i - period + 1; j <= i; j++) varSum += (closes[j] - mean) ** 2;
    const sd = Math.sqrt(varSum / period);
    mid[i] = mean;
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { mid, upper, lower };
}

/** ADX (Wilder) — trend strength. */
export function adx(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n <= period * 2) return out;
  const tr = new Array(n).fill(0);
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const dn = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > dn && up > 0 ? up : 0;
    minusDM[i] = dn > up && dn > 0 ? dn : 0;
    const pc = candles[i - 1].close;
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - pc),
      Math.abs(candles[i].low - pc),
    );
  }
  let trN = 0;
  let pN = 0;
  let mN = 0;
  for (let i = 1; i <= period; i++) {
    trN += tr[i];
    pN += plusDM[i];
    mN += minusDM[i];
  }
  const dx = [];
  for (let i = period + 1; i < n; i++) {
    trN = trN - trN / period + tr[i];
    pN = pN - pN / period + plusDM[i];
    mN = mN - mN / period + minusDM[i];
    const pdi = trN ? (100 * pN) / trN : 0;
    const mdi = trN ? (100 * mN) / trN : 0;
    const denom = pdi + mdi;
    const d = denom ? (100 * Math.abs(pdi - mdi)) / denom : 0;
    dx.push({ idx: i, d });
  }
  if (dx.length < period) return out;
  let adxVal = dx.slice(0, period).reduce((a, b) => a + b.d, 0) / period;
  out[dx[period - 1].idx] = adxVal;
  for (let k = period; k < dx.length; k++) {
    adxVal = (adxVal * (period - 1) + dx[k].d) / period;
    out[dx[k].idx] = adxVal;
  }
  return out;
}

/**
 * Quick regime label per bar for diagnostics:
 *  - ADX >= 22 and EMA50>EMA200 -> TREND_UP ; < -> TREND_DOWN
 *  - ADX < 18 -> RANGE
 *  - else MIXED
 */
export function classifyBarRegime(ind, i) {
  const a = ind.adx[i];
  const e50 = ind.ema50[i];
  const e200 = ind.ema200[i];
  if (a == null || e50 == null || e200 == null) return "WARMUP";
  if (a >= 22) return e50 >= e200 ? "TREND_UP" : "TREND_DOWN";
  if (a < 18) return "RANGE";
  return "MIXED";
}

export function computeIndicators(candles) {
  const closes = candles.map((c) => c.close);
  return {
    closes,
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    rsi14: rsi(closes, 14),
    atr14: atr(candles, 14),
    bb: bollinger(closes, 20, 2),
    adx: adx(candles, 14),
  };
}

const WARMUP = 210;

/**
 * Build the three baseline adapters over a candle array. Each fires only on the
 * setup transition bar and enforces an internal cooldown (in bars) to avoid
 * machine-gun re-entries on every bar of a trend.
 */
export function buildBaselineSignals(candles) {
  const ind = computeIndicators(candles);
  const COOLDOWN = 6;

  function makeAdapter(fn) {
    let lastEntryIdx = -Infinity;
    return (bar, i) => {
      if (i < WARMUP || i >= candles.length - 1) return null;
      if (i - lastEntryIdx < COOLDOWN) return null;
      const sig = fn(i);
      if (sig && sig.action !== "HOLD") {
        lastEntryIdx = i;
        return sig;
      }
      return null;
    };
  }

  // Trend pullback: EMA stack aligned, price dipped toward EMA20 last bar and
  // closes back through it in the trend direction.
  const trend_pullback = makeAdapter((i) => {
    const e20 = ind.ema20[i];
    const e50 = ind.ema50[i];
    const e200 = ind.ema200[i];
    if (e20 == null || e50 == null || e200 == null) return null;
    const c = candles[i].close;
    const lo = candles[i].low;
    const hi = candles[i].high;
    const a = ind.adx[i] ?? 0;
    if (a < 18) return null; // need trend
    const up = e50 > e200 && e20 > e50;
    const dn = e50 < e200 && e20 < e50;
    if (up && lo <= e20 * 1.001 && c > e20) return { action: "BUY", reason: "trend_pullback" };
    if (dn && hi >= e20 * 0.999 && c < e20) return { action: "SELL", reason: "trend_pullback" };
    return null;
  });

  // Mean reversion: close pierced a Bollinger band with RSI extreme, then the
  // current bar closes back inside the band (reclaim).
  const mean_reversion = makeAdapter((i) => {
    const up = ind.bb.upper[i];
    const lo = ind.bb.lower[i];
    const r = ind.rsi14[i];
    if (up == null || lo == null || r == null) return null;
    const a = ind.adx[i] ?? 100;
    if (a > 25) return null; // avoid strong trends
    const prev = candles[i - 1];
    const c = candles[i].close;
    if (prev.close < ind.bb.lower[i - 1] && c > lo && r < 38) {
      return { action: "BUY", reason: "mean_reversion" };
    }
    if (prev.close > ind.bb.upper[i - 1] && c < up && r > 62) {
      return { action: "SELL", reason: "mean_reversion" };
    }
    return null;
  });

  // Donchian breakout: close above the prior 20-bar high (long) / below low.
  const donchian_break = makeAdapter((i) => {
    const N = 20;
    if (i < N + 1) return null;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - N; j < i; j++) {
      hh = Math.max(hh, candles[j].high);
      ll = Math.min(ll, candles[j].low);
    }
    const a = ind.adx[i] ?? 0;
    if (a < 18) return null; // breakouts need momentum
    const c = candles[i].close;
    if (c > hh) return { action: "BUY", reason: "donchian_break" };
    if (c < ll) return { action: "SELL", reason: "donchian_break" };
    return null;
  });

  return { trend_pullback, mean_reversion, donchian_break };
}
