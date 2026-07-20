/**
 * SCALP_MR — mean-reversion scalper (5m).
 *
 * BB pierce + reclaim, RSI extreme, ADX range cap, ATR% band, volume filter.
 * Structure SL beyond pierce; TP1 @1R partial; TP2 at BB mid capped by range RR.
 *
 * Retail-scalping edge is fee discipline — max trades/day + min bar gap are first-class knobs.
 */

import { ema, rsi as rsiFn, atr as atrFn, adx as adxFn } from "./indicators.js";
import { inSmcKillzone } from "./techniques/sessionKillzones.js";
import { dayStore } from "./adapterPersisted.js";
import { SCALP_MR_BNB_5M } from "./presets/scalpMrOptimized.js";

export const SCALP_MR_WARMUP = 120;
export const SCALP_MR_PAD_BARS = 120;

export const SCALP_MR_DEFAULTS = Object.freeze({
  bbPeriod: 20,
  bbMult: 2,
  rsiPeriod: 14,
  rsiBuyMax: 38,
  rsiSellMin: 62,
  maxAdx: 25,
  minAtrPct: 0.08,
  maxAtrPct: 0.55,
  minVolVsAvg: 1.15,
  volLookback: 20,
  rangeRR: 1.5,
  atrSlMult: 0.55,
  minReclaimAtr: 0.2,
  requireConfirmCandle: true,
  usePartialTp: false,
  slMode: "pierce",
  minRr: 1.2,
  minTpPct: 0.25,
  tradeSides: "BOTH",
  requireHtfAlign: true,
  htfBarsPerHour: 12,
  htfMinSepPct: 0.00025,
  twoBarReclaim: true,
  maxBbWidthPct: 1.8,
  minBbWidthPct: 0.35,
  maxTradesPerDay: 10,
  minBarGap: 3,
  killzoneMode: "LONDON_NY",
  killzoneEnabled: true,
});

const SCALP_USER_KEYS = [
  "symbol",
  "timeframe",
  "marketMode",
  "market",
  "futuresLeverage",
  "leverage",
  "futuresLeverageMode",
  "backtestPositionSizing",
  "riskPerTrade",
  "riskPerTradeUnit",
  "scalpMrBbPeriod",
  "scalpMrBbMult",
  "scalpMrRsiPeriod",
  "scalpMrRsiBuyMax",
  "scalpMrRsiSellMin",
  "scalpMrMaxAdx",
  "scalpMrMinAtrPct",
  "scalpMrMaxAtrPct",
  "scalpMrMinVolVsAvg",
  "scalpMrVolLookback",
  "scalpMrRangeRR",
  "scalpMrAtrSlMult",
  "scalpMrMinReclaimAtr",
  "scalpMrRequireConfirmCandle",
  "scalpMrUsePartialTp",
  "scalpMrSlMode",
  "scalpMrMinRr",
  "scalpMrMinTpPct",
  "scalpMrTradeSides",
  "scalpMrRequireHtfAlign",
  "scalpMrHtfBarsPerHour",
  "scalpMrHtfMinSepPct",
  "scalpMrTwoBarReclaim",
  "scalpMrMaxBbWidthPct",
  "scalpMrMinBbWidthPct",
  "scalpMrMaxTradesPerDay",
  "scalpMrMinBarGap",
  "scalpMrKillzoneMode",
  "intradaySmcKillzoneEnabled",
  "intradaySmcKillzoneMode",
  "intradayLiqPartialTp",
  "intradayLiqTp1Enabled",
  "intradayLiqTp2Enabled",
  "intradayLiqBreakevenAfterPartial",
  "intradayLiqEntryAtSignalClose",
];

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function utcDayId(ts) {
  return Math.floor(Number(ts) / 86_400_000);
}

function bollinger(closes, period, mult) {
  const mid = new Array(closes.length).fill(null);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const mean = sum / period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (closes[j] - mean) ** 2;
    const sd = Math.sqrt(v / period);
    mid[i] = mean;
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { mid, upper, lower };
}

function buildH1EmaBiasSeries(candles, barsPerHour = 12, minSepPct = 0.00025) {
  const n = candles.length;
  const h1Up = new Array(n).fill(false);
  const h1Down = new Array(n).fill(false);
  const k21 = 2 / 22;
  const k50 = 2 / 51;
  let ema21 = null;
  let ema50 = null;
  let committed = 0;
  let bucketStart = 0;
  let bucketClose = null;

  for (let i = 0; i < n; i++) {
    const inBucket = i - bucketStart;
    bucketClose = candles[i].close;
    const bucketDone = inBucket === barsPerHour - 1;
    if (bucketDone) {
      ema21 = ema21 == null ? bucketClose : ema21 + k21 * (bucketClose - ema21);
      ema50 = ema50 == null ? bucketClose : ema50 + k50 * (bucketClose - ema50);
      committed += 1;
      bucketStart = i + 1;
    }
    if (committed < 30 || ema21 == null || ema50 == null) continue;
    const sep = Math.abs(ema21 - ema50) / Math.max(ema50, 1e-9);
    if (sep < minSepPct) continue;
    if (ema21 > ema50) h1Up[i] = true;
    else if (ema21 < ema50) h1Down[i] = true;
  }
  return { h1Up, h1Down };
}

function bbWidthPct(up, lo, mid) {
  if (up == null || lo == null || mid == null || mid === 0) return null;
  return ((up - lo) / mid) * 100;
}

function precompute(candles, o) {
  const closes = candles.map((c) => c.close);
  const vols = candles.map((c) => Number(c.volume) || 0);
  const bb = bollinger(closes, o.bbPeriod, o.bbMult);
  const bbWidth = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    bbWidth[i] = bbWidthPct(bb.upper[i], bb.lower[i], bb.mid[i]);
  }
  const htf = buildH1EmaBiasSeries(candles, o.htfBarsPerHour, o.htfMinSepPct);
  return {
    closes,
    vols,
    rsi: rsiFn(closes, o.rsiPeriod),
    atr: atrFn(candles, 14),
    adx: adxFn(candles, 14),
    bb,
    bbWidth,
    h1Up: htf.h1Up,
    h1Down: htf.h1Down,
  };
}

function avgVolume(vols, i, lookback) {
  const start = Math.max(0, i - lookback);
  const slice = vols.slice(start, i);
  if (!slice.length) return 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function buildBrackets(side, entry, slPrice, mid, o) {
  const risk = Math.abs(entry - slPrice);
  if (!(risk > 0) || !(entry > 0)) return null;

  if (!o.usePartialTp) {
    let tpPrice = mid;
    const meanR = Math.abs(mid - entry) / risk;
    const capR = Math.min(o.rangeRR, Math.max(o.minRr, 2));
    if (!Number.isFinite(meanR) || meanR < o.minRr) {
      tpPrice = side === "BUY" ? entry + o.minRr * risk : entry - o.minRr * risk;
    } else if (meanR > capR) {
      tpPrice = side === "BUY" ? entry + capR * risk : entry - capR * risk;
    }
    const rr = Math.abs(tpPrice - entry) / risk;
    const tpPct = Math.abs(tpPrice - entry) / entry;
    if (tpPct < o.minTpPct || rr < o.minRr) return null;
    return {
      slPct: risk / entry,
      tpPct: Math.abs(tpPrice - entry) / entry,
      slPrice,
      tpPrice,
      partialTp: false,
      tp2Enabled: false,
      rr,
    };
  }

  let tpPrice = mid;
  const meanR = Math.abs(mid - entry) / risk;
  if (!Number.isFinite(meanR) || meanR < 1) tpPrice = side === "BUY" ? entry + risk : entry - risk;
  else if (meanR > o.rangeRR) tpPrice = side === "BUY" ? entry + o.rangeRR * risk : entry - o.rangeRR * risk;
  const rr = Math.abs(tpPrice - entry) / risk;
  const tp1Price = side === "BUY" ? entry + risk : entry - risk;
  return {
    slPct: risk / entry,
    tpPct: Math.abs(tpPrice - entry) / entry,
    tp1Pct: Math.abs(tp1Price - entry) / entry,
    slPrice,
    tpPrice,
    tp2Price: tpPrice,
    tp1Price,
    partialTp: true,
    tp2Enabled: true,
    rr,
  };
}

export function optsFromScalpMrCfg(cfg = {}) {
  const c = resolveScalpMrCfg(cfg);
  const killzoneMode = String(
    c.scalpMrKillzoneMode ?? c.intradaySmcKillzoneMode ?? SCALP_MR_DEFAULTS.killzoneMode,
  ).toUpperCase();
  return {
    bbPeriod: num(c.scalpMrBbPeriod, SCALP_MR_DEFAULTS.bbPeriod),
    bbMult: num(c.scalpMrBbMult, SCALP_MR_DEFAULTS.bbMult),
    rsiPeriod: num(c.scalpMrRsiPeriod, SCALP_MR_DEFAULTS.rsiPeriod),
    rsiBuyMax: num(c.scalpMrRsiBuyMax, SCALP_MR_DEFAULTS.rsiBuyMax),
    rsiSellMin: num(c.scalpMrRsiSellMin, SCALP_MR_DEFAULTS.rsiSellMin),
    maxAdx: num(c.scalpMrMaxAdx, SCALP_MR_DEFAULTS.maxAdx),
    minAtrPct: num(c.scalpMrMinAtrPct, SCALP_MR_DEFAULTS.minAtrPct),
    maxAtrPct: num(c.scalpMrMaxAtrPct, SCALP_MR_DEFAULTS.maxAtrPct),
    minVolVsAvg: num(c.scalpMrMinVolVsAvg, SCALP_MR_DEFAULTS.minVolVsAvg),
    volLookback: num(c.scalpMrVolLookback, SCALP_MR_DEFAULTS.volLookback),
    rangeRR: num(c.scalpMrRangeRR, SCALP_MR_DEFAULTS.rangeRR),
    atrSlMult: num(c.scalpMrAtrSlMult, SCALP_MR_DEFAULTS.atrSlMult),
    minReclaimAtr: num(c.scalpMrMinReclaimAtr, SCALP_MR_DEFAULTS.minReclaimAtr),
    requireConfirmCandle: c.scalpMrRequireConfirmCandle !== false,
    usePartialTp: c.scalpMrUsePartialTp === true,
    slMode: String(c.scalpMrSlMode ?? SCALP_MR_DEFAULTS.slMode).toLowerCase(),
    minRr: num(c.scalpMrMinRr, SCALP_MR_DEFAULTS.minRr),
    minTpPct: num(c.scalpMrMinTpPct, SCALP_MR_DEFAULTS.minTpPct) / 100,
    tradeSides: String(c.scalpMrTradeSides ?? SCALP_MR_DEFAULTS.tradeSides).toUpperCase(),
    requireHtfAlign: c.scalpMrRequireHtfAlign !== false,
    htfBarsPerHour: Math.max(4, Math.floor(num(c.scalpMrHtfBarsPerHour, SCALP_MR_DEFAULTS.htfBarsPerHour))),
    htfMinSepPct: num(c.scalpMrHtfMinSepPct, SCALP_MR_DEFAULTS.htfMinSepPct),
    twoBarReclaim: c.scalpMrTwoBarReclaim !== false,
    maxBbWidthPct: num(c.scalpMrMaxBbWidthPct, SCALP_MR_DEFAULTS.maxBbWidthPct),
    minBbWidthPct: num(c.scalpMrMinBbWidthPct, SCALP_MR_DEFAULTS.minBbWidthPct),
    maxTradesPerDay: Math.max(1, Math.floor(num(c.scalpMrMaxTradesPerDay, SCALP_MR_DEFAULTS.maxTradesPerDay))),
    minBarGap: Math.max(0, Math.floor(num(c.scalpMrMinBarGap, SCALP_MR_DEFAULTS.minBarGap))),
    killzoneMode,
    killzoneEnabled: c.intradaySmcKillzoneEnabled !== false,
  };
}

export function resolveScalpMrCfg(cfg = {}) {
  const out = { ...SCALP_MR_BNB_5M };
  for (const k of SCALP_USER_KEYS) {
    if (cfg[k] !== undefined) out[k] = cfg[k];
  }
  out.manualStrategy = "SCALP_MR";
  out.strategyMode = cfg.strategyMode ?? "MANUAL";
  return out;
}

export function scalpMrPadFromMs(fromMs, tf = "5m") {
  const tfMs = tf === "1m" ? 60_000 : tf === "15m" ? 900_000 : tf === "1h" ? 3_600_000 : 300_000;
  return fromMs - SCALP_MR_PAD_BARS * tfMs;
}

function evaluateBar(candles, i, P, o) {
  const up = P.bb.upper[i];
  const lo = P.bb.lower[i];
  const mid = P.bb.mid[i];
  const r = P.rsi[i];
  const atrv = P.atr[i];
  const adxv = P.adx[i];
  if (up == null || lo == null || mid == null || r == null || atrv == null || adxv == null) return null;

  if (adxv > o.maxAdx) return null;

  const bar = candles[i];
  const prev = candles[i - 1];
  const prev2 = candles[i - 2];
  if (!prev || !prev2) return null;
  const prevLo = P.bb.lower[i - 1];
  const prevUp = P.bb.upper[i - 1];
  const prev2Lo = P.bb.lower[i - 2];
  const prev2Up = P.bb.upper[i - 2];
  if (prevLo == null || prevUp == null || prev2Lo == null || prev2Up == null) return null;

  const width = P.bbWidth[i];
  if (width == null || width < o.minBbWidthPct || width > o.maxBbWidthPct) return null;

  const atrPct = (atrv / bar.close) * 100;
  if (atrPct < o.minAtrPct || atrPct > o.maxAtrPct) return null;

  const vAvg = avgVolume(P.vols, i, o.volLookback);
  if (!(vAvg > 0) || P.vols[i] < vAvg * o.minVolVsAvg) return null;

  let side = null;
  if (o.twoBarReclaim) {
    const piercedLow = prev2.close < prev2Lo || prev.close < prevLo;
    const reclaimedLow = bar.close > lo && prev.close > prevLo;
    const piercedHigh = prev2.close > prev2Up || prev.close > prevUp;
    const reclaimedHigh = bar.close < up && prev.close < prevUp;
    if (piercedLow && reclaimedLow && r <= o.rsiBuyMax) side = "BUY";
    else if (piercedHigh && reclaimedHigh && r >= o.rsiSellMin) side = "SELL";
  } else {
    if (prev.close < prevLo && bar.close > lo && r <= o.rsiBuyMax) side = "BUY";
    else if (prev.close > prevUp && bar.close < up && r >= o.rsiSellMin) side = "SELL";
  }
  if (!side) return null;
  if (o.tradeSides === "LONG" && side !== "BUY") return null;
  if (o.tradeSides === "SHORT" && side !== "SELL") return null;

  if (o.requireHtfAlign) {
    if (side === "BUY" && !P.h1Up[i]) return null;
    if (side === "SELL" && !P.h1Down[i]) return null;
  }

  const reclaimStrength =
    side === "BUY" ? (bar.close - lo) / atrv : (up - bar.close) / atrv;
  if (reclaimStrength < o.minReclaimAtr) return null;

  if (o.requireConfirmCandle) {
    const ok = side === "BUY" ? bar.close > bar.open : bar.close < bar.open;
    if (!ok) return null;
  }

  const entry = bar.close;
  let slPrice;
  if (o.slMode === "entry_atr") {
    slPrice = side === "BUY" ? entry - atrv * o.atrSlMult : entry + atrv * o.atrSlMult;
  } else {
    const pierce = side === "BUY" ? Math.min(bar.low, prev.low) : Math.max(bar.high, prev.high);
    slPrice = side === "BUY" ? pierce - atrv * o.atrSlMult : pierce + atrv * o.atrSlMult;
  }
  const brackets = buildBrackets(side, entry, slPrice, mid, o);
  if (!brackets) return null;

  return {
    action: side,
    reason: `scalp_mr_${side === "BUY" ? "long" : "short"}`,
    rsi: r,
    adx: adxv,
    atrPct,
    volRatio: P.vols[i] / vAvg,
    brackets,
  };
}

export function buildScalpMrSeries(candles, opts = {}) {
  const o = { ...SCALP_MR_DEFAULTS, ...opts };
  const P = precompute(candles, o);
  const n = candles.length;
  const series = new Array(n).fill(null);

  for (let i = SCALP_MR_WARMUP; i < n; i++) {
    if (!o.killzoneEnabled || inSmcKillzone(candles[i].ts, { intradaySmcKillzoneMode: o.killzoneMode })) {
      const sig = evaluateBar(candles, i, P, o);
      if (sig) series[i] = sig;
    }
  }
  return { series, pre: P };
}

export function buildScalpMrBacktestAdapter(candles, cfg = {}, _tf = "5m") {
  const opts = optsFromScalpMrCfg(cfg);
  const { series } = buildScalpMrSeries(candles, opts);

  let lastSignalIdx = -Infinity;
  let tradesToday = 0;
  let curDay = null;
  const dayLocal = { lastSignalIdx: -Infinity, tradesToday: 0, curDay: null };

  return function scalpMrAdapter(bar, idx, ctx) {
    if (idx < SCALP_MR_WARMUP) return null;

    const dDay = dayStore(ctx, dayLocal);
    const day = utcDayId(bar.ts);
    if (day !== (ctx?.persisted ? dDay.curDay : curDay)) {
      if (ctx?.persisted) {
        dDay.curDay = day;
        dDay.tradesToday = 0;
      } else {
        curDay = day;
        tradesToday = 0;
      }
    }

    const sig = series[idx];
    if (!sig) return null;

    const tradesCount = ctx?.persisted ? dDay.tradesToday : tradesToday;
    if (tradesCount >= opts.maxTradesPerDay) return null;
    const lastIdx = ctx?.persisted ? dDay.lastSignalIdx : lastSignalIdx;
    if (idx - lastIdx < opts.minBarGap) return null;

    if (ctx?.persisted) {
      dDay.lastSignalIdx = idx;
      dDay.tradesToday = tradesCount + 1;
    } else {
      lastSignalIdx = idx;
      tradesToday += 1;
    }

    return {
      action: sig.action,
      reason: sig.reason,
      liqBrackets: sig.brackets,
      rsi: sig.rsi,
      adx: sig.adx,
    };
  };
}

export function signal({ candles, cfg } = {}) {
  if (!candles?.length) return { action: "HOLD", reason: "no_candles" };
  const opts = optsFromScalpMrCfg(cfg || {});
  const { series } = buildScalpMrSeries(candles, opts);
  const idx = candles.length - 1;
  const sig = series[idx];
  if (!sig) return { action: "HOLD", reason: "scalp_mr_no_setup" };
  return {
    action: sig.action,
    reason: sig.reason,
    liqBrackets: sig.brackets,
    rsi: sig.rsi,
    adx: sig.adx,
  };
}

export const SCALP_MR_ACTIVATION_PATCH = {
  manualStrategy: "SCALP_MR",
  strategyMode: "MANUAL",
  timeframe: "5m",
  scalpMrBbPeriod: 20,
  scalpMrBbMult: 2,
  scalpMrRsiBuyMax: 42,
  scalpMrRsiSellMin: 58,
  scalpMrMaxAdx: 22,
  scalpMrMinAtrPct: 0.08,
  scalpMrMaxAtrPct: 0.55,
  scalpMrMinVolVsAvg: 1.0,
  scalpMrRangeRR: 1.5,
  scalpMrAtrSlMult: 0.85,
  scalpMrSlMode: "entry_atr",
  scalpMrMinRr: 1.5,
  scalpMrMinTpPct: 0.2,
  scalpMrMaxTradesPerDay: 5,
  scalpMrMinBarGap: 5,
  scalpMrKillzoneMode: "LONDON_NY",
  intradaySmcKillzoneEnabled: true,
  intradaySmcKillzoneMode: "LONDON_NY",
  intradayLiqPartialTp: false,
  intradayLiqTp1Enabled: false,
  intradayLiqTp2Enabled: true,
  intradayLiqBreakevenAfterPartial: false,
  intradayLiqEntryAtSignalClose: true,
  scalpMrUsePartialTp: false,
  trailingStopLossAuto: false,
  futuresTrailingStopMode: "OFF",
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 1,
  riskPerTradeUnit: "PCT",
  futuresLeverage: 10,
  maxDailyLoss: 2,
  maxDailyLossUnit: "PCT",
  riskConsecutiveLossLimit: 3,
};

export const SCALP_MR = {
  name: "Scalp MR — 5m Bollinger/RSI mean reversion + ATR/volume filters",
  signal,
};
