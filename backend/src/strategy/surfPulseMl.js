/**
 * SurfPulse ML — trend + pullback + volatility breakout, gated by an 8-feature XGBoost win model.
 * Named for the “surf the trend, paddle on the pullback” metaphor from the strategy guide.
 */

import { clamp } from "../lib/math.js";

const FUNDING_CAP = Number(process.env.SURF_PULSE_FUNDING_CAP ?? 0.0005); // ±0.05%
const REGIME_4H_ADX_MIN = Number(process.env.SURF_PULSE_4H_ADX_MIN ?? 20);
const TREND_ADX_MIN = Number(process.env.SURF_PULSE_ADX_MIN ?? 25);
const PULLBACK_ATR_MAX = Number(process.env.SURF_PULSE_PULLBACK_ATR_MAX ?? 1.5);
const VOL_RATIO_MIN = Number(process.env.SURF_PULSE_VOL_RATIO_MIN ?? 1.5);
const MIN_CANDLES = Math.max(80, Number(process.env.SURF_PULSE_MIN_CANDLES ?? 200));

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    prev = i === 0 ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsi(values, period = 14) {
  let gains = 0;
  let losses = 0;
  const out = new Array(values.length).fill(50);
  for (let i = 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    const g = Math.max(0, ch);
    const l = Math.max(0, -ch);
    if (i <= period) {
      gains += g;
      losses += l;
      continue;
    }
    if (i === period + 1) {
      gains /= period;
      losses /= period;
    } else {
      gains = (gains * (period - 1) + g) / period;
      losses = (losses * (period - 1) + l) / period;
    }
    const rs = losses === 0 ? 100 : gains / losses;
    out[i] = clamp(100 - 100 / (1 + rs), 0, 100);
  }
  return out;
}

function atr(candles, period = 14) {
  const tr = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = i === 0 ? c.close : candles[i - 1].close;
    const a = c.high - c.low;
    const b = Math.abs(c.high - prevClose);
    const d = Math.abs(c.low - prevClose);
    tr.push(Math.max(a, b, d));
  }
  const out = new Array(candles.length).fill(0);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += tr[i];
    if (i >= period) sum -= tr[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Same structure as indicators.js aggregateCandles */
export function aggregateCandles(srcCandles, factor) {
  const agg = [];
  for (let i = 0; i + factor <= srcCandles.length; i += factor) {
    const chunk = srcCandles.slice(i, i + factor);
    agg.push({
      open: Number(chunk[0].open ?? chunk[0].close),
      high: Math.max(...chunk.map((c) => Number(c.high ?? c.close))),
      low: Math.min(...chunk.map((c) => Number(c.low ?? c.close))),
      close: Number(chunk[chunk.length - 1].close),
      volume: chunk.reduce((s, c) => s + Number(c.volume ?? 0), 0),
    });
  }
  return agg;
}

function adxSeries(candles, period = 14) {
  const plusDM = [];
  const minusDM = [];
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    const prevClose = prev.close;
    tr.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prevClose), Math.abs(cur.low - prevClose)));
  }
  const smooth = (arr) => {
    const out = new Array(arr.length).fill(0);
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
      sum += arr[i];
      if (i >= period) sum -= arr[i - period];
      if (i >= period - 1) out[i] = sum;
    }
    return out;
  };
  const smTR = smooth(tr);
  const smPlus = smooth(plusDM);
  const smMinus = smooth(minusDM);
  const dx = new Array(tr.length).fill(0);
  for (let i = 0; i < tr.length; i++) {
    const trv = smTR[i];
    if (trv === 0) continue;
    const pDI = (100 * smPlus[i]) / trv;
    const mDI = (100 * smMinus[i]) / trv;
    dx[i] = (100 * Math.abs(pDI - mDI)) / (pDI + mDI || 1);
  }
  const adxSeriesInner = ema(dx, period);
  const out = new Array(candles.length).fill(0);
  for (let i = 0; i < adxSeriesInner.length; i++) out[i + 1] = adxSeriesInner[i];
  return out;
}

/**
 * Last 4h ADX > threshold (from 1m candles). If history too short, returns ok=true (lenient).
 */
export function regime4hAdxPasses(candles) {
  const need = 240 * 16; // ~16 four-hour bars
  if (candles.length < need) return { ok: true, skipped: true, adx: null };
  const slice = candles.slice(-need);
  const h4 = aggregateCandles(slice, 240);
  if (h4.length < 15) return { ok: true, skipped: true, adx: null };
  const adx = adxSeries(h4, 14);
  const last = adx.at(-1) ?? 0;
  return { ok: last > REGIME_4H_ADX_MIN, skipped: false, adx: last };
}

function htfEma20over50(candles, factor) {
  const agg = aggregateCandles(candles, factor);
  if (agg.length < 55) return null;
  const closes = agg.map((c) => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  return (e20.at(-1) ?? 0) > (e50.at(-1) ?? 0);
}

/**
 * Optional HTF confirm: EMA20 > EMA50 on 5m OR 15m (long); bearish on either for short.
 */
export function higherTimeframeTrendOk(candles, direction) {
  const ok5 = htfEma20over50(candles, 5);
  const ok15 = htfEma20over50(candles, 15);
  if (ok5 == null && ok15 == null) return true;
  if (direction === "long") {
    return Boolean(ok5) || Boolean(ok15);
  }
  return ok5 === false || ok15 === false;
}

/** 8 features aligned with SurfPulse training / guide */
export function extractSurfPulseFeatures(candles) {
  if (!Array.isArray(candles) || candles.length < 55) return null;
  const closes = candles.map((c) => Number(c.close));
  const opens = candles.map((c) => Number(c.open ?? c.close));
  const highs = candles.map((c) => Number(c.high ?? c.close));
  const lows = candles.map((c) => Number(c.low ?? c.close));
  const volumes = candles.map((c) => Number(c.volume ?? 0));
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(
    candles.map((c, i) => ({
      high: highs[i],
      low: lows[i],
      close: closes[i],
    })),
    14
  );
  const adx14 = adxSeries(
    candles.map((c, i) => ({
      high: highs[i],
      low: lows[i],
      close: closes[i],
    })),
    14
  );
  const volMa = ema(volumes, 20);
  const i = closes.length - 1;
  const volRatio = volMa[i] > 0 ? volumes[i] / volMa[i] : 1;
  const bodySize = Math.abs(closes[i] - opens[i]);
  const emaDiff = (ema20[i] ?? 0) - (ema50[i] ?? 0);
  return {
    ema20: ema20[i] ?? 0,
    ema50: ema50[i] ?? 0,
    adx: adx14[i] ?? 0,
    rsi: rsi14[i] ?? 50,
    atr: atr14[i] ?? 0,
    vol_ratio: volRatio,
    body_size: bodySize,
    ema_diff: emaDiff,
  };
}

/**
 * Rule-based signal (Door 1). ML gate is applied in the bot via /predict/surfpulse.
 * @param {object} p
 * @param {Array} p.candles oldest-first
 * @param {{ fundingRate?: number | null }} [p.surfPulse]
 */
export function surfPulseHardRules({ candles, surfPulse }) {
  if (!Array.isArray(candles) || candles.length < MIN_CANDLES) {
    return { action: "HOLD", reason: "surfpulse_insufficient_candles", features: null };
  }
  const closes = candles.map((c) => Number(c.close));
  const opens = candles.map((c) => Number(c.open ?? c.close));
  const highs = candles.map((c) => Number(c.high ?? c.close));
  const lows = candles.map((c) => Number(c.low ?? c.close));
  const volumes = candles.map((c) => Number(c.volume ?? 0));
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(
    candles.map((c, i) => ({
      high: highs[i],
      low: lows[i],
      close: closes[i],
    })),
    14
  );
  const adx14 = adxSeries(
    candles.map((c, i) => ({
      high: highs[i],
      low: lows[i],
      close: closes[i],
    })),
    14
  );
  const volMa = ema(volumes, 20);
  const last = closes.length - 1;
  const prev = last - 1;
  const lastC = closes[last];
  const prevH = highs[prev];
  const prevL = lows[prev];
  const atr = atr14[last] || 1e-12;
  let atrMa10 = 0;
  for (let j = Math.max(0, last - 9); j <= last; j++) atrMa10 += atr14[j] || 0;
  atrMa10 /= Math.min(10, last + 1);
  const volRatio = volMa[last] > 0 ? volumes[last] / volMa[last] : 1;
  const e20 = ema20[last] ?? 0;
  const e50 = ema50[last] ?? 0;
  const adx = adx14[last] ?? 0;
  const rsi = rsi14[last] ?? 50;

  const { ok: regimeOk, skipped: regimeSkipped } = regime4hAdxPasses(candles);
  if (!regimeOk && !regimeSkipped) {
    return { action: "HOLD", reason: "surfpulse_regime_4h_flat", features: extractSurfPulseFeatures(candles) };
  }

  const fr = surfPulse?.fundingRate;
  let fundingLongOk = true;
  let fundingShortOk = true;
  if (fr != null && Number.isFinite(Number(fr))) {
    const r = Number(fr);
    fundingLongOk = r <= FUNDING_CAP;
    fundingShortOk = r >= -FUNDING_CAP;
  }

  const pullbackLong = Math.abs(lastC - e20) / atr < PULLBACK_ATR_MAX;
  const pullbackShort = Math.abs(lastC - e20) / atr < PULLBACK_ATR_MAX;

  const entryLong =
    lastC > prevH && volRatio > VOL_RATIO_MIN && rsi > 50 && atr > atrMa10;
  const entryShort =
    lastC < prevL && volRatio > VOL_RATIO_MIN && rsi < 50 && atr > atrMa10;

  const trendLong = e20 > e50 && adx > TREND_ADX_MIN;
  const trendShort = e20 < e50 && adx > TREND_ADX_MIN;

  const htfLong = higherTimeframeTrendOk(candles, "long");
  const htfShort = higherTimeframeTrendOk(candles, "short");

  const features = extractSurfPulseFeatures(candles);

  if (
    trendLong &&
    htfLong &&
    pullbackLong &&
    entryLong &&
    fundingLongOk
  ) {
    return { action: "BUY", reason: "surfpulse_long_setup", features };
  }
  if (
    trendShort &&
    htfShort &&
    pullbackShort &&
    entryShort &&
    fundingShortOk
  ) {
    return { action: "SELL", reason: "surfpulse_short_setup", features };
  }

  return { action: "HOLD", reason: "surfpulse_no_setup", features };
}

export const SURF_PULSE_ML = {
  name: "SurfPulse ML (trend + pullback + XGBoost gate)",
  signal(ctx) {
    return surfPulseHardRules({ candles: ctx.candles, surfPulse: ctx.surfPulse });
  },
};
