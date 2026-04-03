import { clamp } from "../lib/math.js";

function ema(values, period) {
  const k = 2 / (period + 1);
  let out = [];
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

// Lightweight ADX approximation (good enough for regime gating)
function adx(candles, period = 14) {
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

  // ADX is EMA of DX
  const adxSeries = ema(dx, period);
  // align to candles length
  const out = new Array(candles.length).fill(0);
  for (let i = 0; i < adxSeries.length; i++) out[i + 1] = adxSeries[i];
  return out;
}

function sma(values, period) {
  const out = new Array(values.length).fill(0);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out[i] = i >= period - 1 ? sum / period : sum / (i + 1);
  }
  return out;
}

function stddev(values, period) {
  const means = sma(values, period);
  const out = new Array(values.length).fill(0);
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - period + 1);
    const slice = values.slice(start, i + 1);
    const mean = means[i];
    const variance = slice.reduce((a, v) => a + (v - mean) ** 2, 0) / slice.length;
    out[i] = Math.sqrt(variance);
  }
  return out;
}

export function computeIndicators(candles) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high ?? c.close);
  const lows = candles.map((c) => c.low ?? c.close);
  const volumes = candles.map((c) => c.volume ?? 0);
  const emaFast = ema(closes, 12);
  const emaSlow = ema(closes, 26);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(candles, 14);
  const adx14 = adx(candles, 14);

  const volMA = ema(volumes, 20);
  const volumeSpike = volumes.map((v, i) => (volMA[i] ? v / volMA[i] : 1));

  // MACD
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const macdSignal = ema(macdLine, 9);
  const macdHist = macdLine.map((v, i) => v - macdSignal[i]);

  // Bollinger Bands
  const sma20 = sma(closes, 20);
  const std20 = stddev(closes, 20);
  const bbUpper = sma20.map((v, i) => v + 2 * std20[i]);
  const bbLower = sma20.map((v, i) => v - 2 * std20[i]);
  const bbWidth = sma20.map((v, i) => (v > 0 ? (bbUpper[i] - bbLower[i]) / v : 0));
  const bbPos = bbLower.map((v, i) =>
    bbUpper[i] - v > 0 ? (closes[i] - v) / (bbUpper[i] - v) : 0.5
  );

  // Stochastic RSI
  const stochRsi = rsi14.map((v, i) => {
    const start = Math.max(0, i - 13);
    const slice = rsi14.slice(start, i + 1);
    const lo = Math.min(...slice);
    const hi = Math.max(...slice);
    return hi - lo > 0 ? (v - lo) / (hi - lo) : 0.5;
  });

  // Multi-timeframe: aggregate 1m candles into 5m and 15m bars
  function aggregateCandles(srcCandles, factor) {
    const agg = [];
    for (let i = 0; i + factor <= srcCandles.length; i += factor) {
      const chunk = srcCandles.slice(i, i + factor);
      agg.push({
        open: chunk[0].open,
        high: Math.max(...chunk.map((c) => c.high ?? c.close)),
        low: Math.min(...chunk.map((c) => c.low ?? c.close)),
        close: chunk[chunk.length - 1].close,
        volume: chunk.reduce((s, c) => s + (c.volume ?? 0), 0),
      });
    }
    return agg;
  }

  function computeHTFSignals(srcCandles, factor) {
    const htfCandles = aggregateCandles(srcCandles, factor);
    if (htfCandles.length < 14) return { ema_slope: 0, rsi: 50 };
    const htfCloses = htfCandles.map((c) => c.close);
    const htfEma12 = ema(htfCloses, 12);
    const htfEma26 = ema(htfCloses, 26);
    const htfRsi14 = rsi(htfCloses, 14);
    const last12 = htfEma12.at(-1) ?? 0;
    const prev12 = htfEma12.at(-2) ?? last12;
    const lastPrice = htfCloses.at(-1) || 1;
    return {
      ema_slope: lastPrice > 0 ? (last12 - prev12) / lastPrice : 0,
      ema_trend: last12 > (htfEma26.at(-1) ?? 0) ? 1 : -1,
      rsi: htfRsi14.at(-1) ?? 50,
    };
  }

  const htf5m = candles.length >= 70 ? computeHTFSignals(candles, 5) : { ema_slope: 0, ema_trend: 0, rsi: 50 };
  const htf15m = candles.length >= 210 ? computeHTFSignals(candles, 15) : { ema_slope: 0, ema_trend: 0, rsi: 50 };

  const prevMacdHist = macdHist.length >= 2 ? macdHist[macdHist.length - 2] : 0;

  const last = closes.length - 1;
  const lastClose = closes[last] || 1;
  const latest = {
    ema_fast: emaFast.at(-1) ?? 0,
    ema_slow: emaSlow.at(-1) ?? 0,
    rsi_14: rsi14.at(-1) ?? 50,
    atr_14: atr14.at(-1) ?? 0,
    adx_14: adx14.at(-1) ?? 0,
    volume_spike: volumeSpike.at(-1) ?? 1,
    macd_line: macdLine.at(-1) ?? 0,
    macd_signal: macdSignal.at(-1) ?? 0,
    macd_hist: macdHist.at(-1) ?? 0,
    bb_width: bbWidth.at(-1) ?? 0,
    bb_pos: clamp(bbPos.at(-1) ?? 0.5, 0, 1),
    stoch_rsi: clamp(stochRsi.at(-1) ?? 0.5, 0, 1),
    atr_pct: atr14.at(-1) ? atr14.at(-1) / lastClose : 0,
    hl_range_pct: lastClose > 0 ? ((highs[last] ?? 0) - (lows[last] ?? 0)) / lastClose : 0,
    macd_hist_prev: prevMacdHist,
    htf_5m_ema_slope: htf5m.ema_slope,
    htf_5m_ema_trend: htf5m.ema_trend ?? 0,
    htf_5m_rsi: htf5m.rsi,
    htf_15m_ema_slope: htf15m.ema_slope,
    htf_15m_ema_trend: htf15m.ema_trend ?? 0,
    htf_15m_rsi: htf15m.rsi,
  };

  return { latest };
}

