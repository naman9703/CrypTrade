/**
 * Regime-adaptive intraday strategy.
 *
 * Instead of AND-ing every technique on every bar (the legacy engine, which
 * Phase-1 diagnosis showed barely trades and loses), this strategy asks the
 * unified regimeEngine for ONE label per bar and runs exactly ONE playbook:
 *
 *   TREND_UP / TREND_DOWN  -> trend pullback (buy dips to EMA20/VWAP in trend)
 *   RANGE                  -> mean reversion (fade Bollinger/RSI extremes)
 *   SQUEEZE                -> volatility breakout (Donchian + volume/delta expansion)
 *   VOLATILE_AVOID         -> stand down (HOLD)
 *
 * Each playbook produces a confluence score -> A/B grade; only A/B setups trade.
 * Entries are confirmed on the closed bar (filled next bar by the runner),
 * structure-based SL, TP1 at 1R (partial) + TP2 at the playbook RR. A 2-3
 * trades/day cap, min-bar-gap and London/NY killzone keep frequency (and fees,
 * the #1 leak) under control.
 *
 * Exports follow the intradayPro.js contract:
 *   - buildRegimeAdaptiveBacktestAdapter(candles, cfg, tf) -> (bar, idx) => signal|null
 *   - signal({ candles, timeframe, cfg, state }) -> { action, reason, ... }
 */

import { ema, rsi as rsiFn, atr as atrFn } from "./indicators.js";
import { barDelta } from "./techniques/orderFlow.js";
import { inSmcKillzone } from "./techniques/sessionKillzones.js";
import { buildRegimeSeries, REGIMES, playbookForRegime } from "./regimeEngine.js";

const GRADE_A = "A";
const GRADE_B = "B";

export const DEFAULT_RA_OPTS = Object.freeze({
  enableTrend: true,
  enableRange: true,
  enableBreakout: true,
  minGrade: GRADE_B, // "A" = only top setups, "B" = A or B
  confidenceFloor: 0.3, // skip low-confidence regime labels
  maxTradesPerDay: 3,
  minBarGap: 6,
  killzoneMode: "LONDON_NY", // "ALL" disables the session filter
  // RR (TP2 in R) and structure buffers per playbook.
  trendRR: 2.0,
  rangeRR: 1.5,
  breakoutRR: 2.0,
  atrSlMult: 1.1, // SL buffer beyond structure in ATR
  swingLookback: 10,
  // Scoring thresholds.
  gradeAScore: 70,
  gradeBScore: 55,
  // Optional regime-engine overrides (forwarded).
  regimeOpts: undefined,
});

function utcDayId(ts) {
  return Math.floor(Number(ts) / 86_400_000);
}

function gradeFromScore(score, o) {
  if (score >= o.gradeAScore) return GRADE_A;
  if (score >= o.gradeBScore) return GRADE_B;
  return null;
}

function gradePasses(grade, minGrade) {
  if (!grade) return false;
  if (minGrade === GRADE_A) return grade === GRADE_A;
  return grade === GRADE_A || grade === GRADE_B;
}

function swingLow(candles, i, lookback) {
  let lo = Infinity;
  for (let j = Math.max(0, i - lookback + 1); j <= i; j++) lo = Math.min(lo, candles[j].low);
  return Number.isFinite(lo) ? lo : candles[i].low;
}
function swingHigh(candles, i, lookback) {
  let hi = -Infinity;
  for (let j = Math.max(0, i - lookback + 1); j <= i; j++) hi = Math.max(hi, candles[j].high);
  return Number.isFinite(hi) ? hi : candles[i].high;
}

/** Build per-bar indicator context once. */
function precompute(candles) {
  const closes = candles.map((c) => c.close);
  const vols = candles.map((c) => Number(c.volume) || 0);
  return {
    closes,
    vols,
    ema9: ema(closes, 9),
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    rsi14: rsiFn(closes, 14),
    atr14: atrFn(candles, 14),
    bb: bollinger(closes, 20, 2),
  };
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

/** Assemble the bracket object the runner consumes (structure SL + TP1/TP2). */
function buildBrackets(side, entry, slPrice, rr, atrv, o) {
  const risk = Math.abs(entry - slPrice);
  if (!(risk > 0) || !(entry > 0)) return null;
  const tp1Price = side === "BUY" ? entry + risk : entry - risk; // 1R partial
  const tp2Price = side === "BUY" ? entry + rr * risk : entry - rr * risk;
  return {
    slPct: risk / entry,
    tpPct: Math.abs(tp2Price - entry) / entry,
    tp1Pct: Math.abs(tp1Price - entry) / entry,
    slPrice,
    tpPrice: tp2Price,
    tp2Price,
    tp1Price,
    partialTp: true,
    tp2Enabled: true,
    rr,
  };
}

// ── Playbooks ───────────────────────────────────────────────────────────────

/** TREND_UP/DOWN: pullback to EMA20 reclaim in the trend direction + delta confirm. */
function trendPlaybook(candles, i, P, regime, conf, o) {
  const side = regime === REGIMES.TREND_UP ? "BUY" : "SELL";
  const e20 = P.ema20[i];
  const e50 = P.ema50[i];
  const r = P.rsi14[i];
  const atrv = P.atr14[i];
  if (e20 == null || e50 == null || r == null || atrv == null) return null;
  const bar = candles[i];

  // Pullback: a recent bar tagged EMA20, current bar reclaims it in trend dir.
  const pulledBack =
    side === "BUY"
      ? Math.min(candles[i].low, candles[i - 1]?.low ?? Infinity) <= e20 * 1.0015 && bar.close > e20
      : Math.max(candles[i].high, candles[i - 1]?.high ?? -Infinity) >= e20 * 0.9985 && bar.close < e20;
  if (!pulledBack) return null;

  // Avoid chasing exhausted moves.
  if (side === "BUY" && (r > 72 || r < 38)) return null;
  if (side === "SELL" && (r < 28 || r > 62)) return null;

  const delta = barDelta(bar);
  const deltaOk = side === "BUY" ? delta > 0 : delta < 0;
  const trendStack = side === "BUY" ? e20 > e50 : e20 < e50;

  let score = 35;
  score += conf * 20; // regime confidence
  if (deltaOk) score += 15;
  if (trendStack) score += 10;
  if (side === "BUY" ? r >= 45 && r <= 60 : r >= 40 && r <= 55) score += 10; // healthy pullback RSI
  const bodyClose =
    side === "BUY" ? bar.close > bar.open : bar.close < bar.open; // confirming candle
  if (bodyClose) score += 10;

  const grade = gradeFromScore(score, o);
  if (!gradePasses(grade, o.minGrade)) return null;

  const entry = bar.close;
  const struct = side === "BUY" ? swingLow(candles, i, o.swingLookback) : swingHigh(candles, i, o.swingLookback);
  const slPrice = side === "BUY" ? struct - atrv * o.atrSlMult : struct + atrv * o.atrSlMult;
  const brackets = buildBrackets(side, entry, slPrice, o.trendRR, atrv, o);
  if (!brackets) return null;
  return { action: side, reason: `ra_trend_${grade}`, grade, score, brackets, regime };
}

/** RANGE: fade Bollinger/RSI extreme with a reclaim back inside the band. */
function rangePlaybook(candles, i, P, regime, conf, o) {
  const up = P.bb.upper[i];
  const lo = P.bb.lower[i];
  const mid = P.bb.mid[i];
  const r = P.rsi14[i];
  const atrv = P.atr14[i];
  if (up == null || lo == null || r == null || atrv == null) return null;
  const bar = candles[i];
  const prev = candles[i - 1];
  if (!prev) return null;
  const prevLo = P.bb.lower[i - 1];
  const prevUp = P.bb.upper[i - 1];
  if (prevLo == null || prevUp == null) return null;

  let side = null;
  if (prev.close < prevLo && bar.close > lo && r < 40) side = "BUY";
  else if (prev.close > prevUp && bar.close < up && r > 60) side = "SELL";
  if (!side) return null;

  const delta = barDelta(bar);
  const deltaOk = side === "BUY" ? delta > 0 : delta < 0;

  let score = 38;
  score += conf * 15;
  if (side === "BUY" ? r < 32 : r > 68) score += 14; // deeper extreme
  if (deltaOk) score += 12; // reclaim with supporting flow
  const reclaimStrength =
    side === "BUY" ? (bar.close - lo) / atrv : (up - bar.close) / atrv;
  if (reclaimStrength > 0.3) score += 8;

  const grade = gradeFromScore(score, o);
  if (!gradePasses(grade, o.minGrade)) return null;

  const entry = bar.close;
  // SL beyond the pierce extreme; TP at the mean (mid band), capped by RR.
  const pierce = side === "BUY" ? Math.min(bar.low, prev.low) : Math.max(bar.high, prev.high);
  const slPrice = side === "BUY" ? pierce - atrv * 0.5 : pierce + atrv * 0.5;
  const risk = Math.abs(entry - slPrice);
  if (!(risk > 0)) return null;
  // Target the mean, but never less than 1R or more than rangeRR R.
  let tpPrice = mid;
  const meanR = Math.abs(mid - entry) / risk;
  if (!Number.isFinite(meanR) || meanR < 1) tpPrice = side === "BUY" ? entry + risk : entry - risk;
  else if (meanR > o.rangeRR) tpPrice = side === "BUY" ? entry + o.rangeRR * risk : entry - o.rangeRR * risk;
  const rr = Math.abs(tpPrice - entry) / risk;
  const tp1Price = side === "BUY" ? entry + risk : entry - risk;
  const brackets = {
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
  return { action: side, reason: `ra_range_${grade}`, grade, score, brackets, regime };
}

/** SQUEEZE: breakout of the 20-bar channel on volume + delta expansion. */
function breakoutPlaybook(candles, i, P, regime, conf, o) {
  const atrv = P.atr14[i];
  if (atrv == null || i < 21) return null;
  const bar = candles[i];
  const hh = swingHigh(candles, i - 1, 20);
  const ll = swingLow(candles, i - 1, 20);

  // Volume expansion vs trailing average.
  const start = Math.max(0, i - 20);
  const vWin = P.vols.slice(start, i);
  const vAvg = vWin.reduce((a, b) => a + b, 0) / Math.max(1, vWin.length);
  const volExpand = vAvg > 0 && P.vols[i] >= vAvg * 1.5;

  let side = null;
  if (bar.close > hh) side = "BUY";
  else if (bar.close < ll) side = "SELL";
  if (!side) return null;
  if (!volExpand) return null;

  const delta = barDelta(bar);
  const deltaOk = side === "BUY" ? delta > 0 : delta < 0;
  if (!deltaOk) return null; // breakout must have flow behind it

  let score = 40;
  score += conf * 15;
  if (P.vols[i] >= vAvg * 2.2) score += 12;
  const breakDist = side === "BUY" ? (bar.close - hh) / atrv : (ll - bar.close) / atrv;
  if (breakDist > 0.2) score += 10;
  const bodyClose = side === "BUY" ? bar.close > bar.open : bar.close < bar.open;
  if (bodyClose) score += 8;

  const grade = gradeFromScore(score, o);
  if (!gradePasses(grade, o.minGrade)) return null;

  const entry = bar.close;
  // Stop back inside the channel (other side of the breakout level) with buffer.
  const slPrice = side === "BUY" ? hh - atrv * o.atrSlMult : ll + atrv * o.atrSlMult;
  const brackets = buildBrackets(side, entry, slPrice, o.breakoutRR, atrv, o);
  if (!brackets) return null;
  return { action: side, reason: `ra_breakout_${grade}`, grade, score, brackets, regime };
}

/**
 * Build the per-bar signal series (pre-cap). Each element is either null or a
 * graded setup with brackets, plus the regime label for diagnostics/UI.
 */
export function buildRegimeAdaptiveSeries(candles, opts = {}) {
  const o = { ...DEFAULT_RA_OPTS, ...opts };
  const P = precompute(candles);
  const regimes = buildRegimeSeries(candles, o.regimeOpts || {});
  const n = candles.length;
  const series = new Array(n).fill(null);
  const regimeLabels = new Array(n);

  for (let i = 0; i < n; i++) {
    const rinfo = regimes[i];
    regimeLabels[i] = rinfo?.regime || REGIMES.RANGE;
    if (i < 210 || i >= n - 1) continue;
    const regime = rinfo.regime;
    const conf = rinfo.confidence || 0;
    const playbook = playbookForRegime(regime);
    if (playbook === "stand_down") continue;
    if (conf < o.confidenceFloor) continue;
    if (!inSmcKillzone(candles[i].ts, { intradaySmcKillzoneMode: o.killzoneMode })) continue;

    let sig = null;
    if (playbook === "trend" && o.enableTrend) sig = trendPlaybook(candles, i, P, regime, conf, o);
    else if (playbook === "mean_reversion" && o.enableRange) sig = rangePlaybook(candles, i, P, regime, conf, o);
    else if (playbook === "breakout" && o.enableBreakout) sig = breakoutPlaybook(candles, i, P, regime, conf, o);

    if (sig) series[i] = sig;
  }
  return { series, regimeLabels };
}

/**
 * Backtest adapter — wraps the series with the trades/day cap + min-bar-gap and
 * emits the runner signal contract. Brackets ride on `liqBrackets` so the runner
 * applies structure SL + TP1 partial + TP2 (and we request next-bar fills).
 */
export function buildRegimeAdaptiveBacktestAdapter(candles, cfg = {}, _tf = "15m") {
  const o = optsFromCfg(cfg);
  const { series } = buildRegimeAdaptiveSeries(candles, o);
  const maxPerDay = o.maxTradesPerDay;
  const minGap = o.minBarGap;

  let lastSignalIdx = -Infinity;
  let tradesToday = 0;
  let curDay = null;

  return function regimeAdaptiveAdapter(bar, idx) {
    const day = utcDayId(bar.ts);
    if (day !== curDay) {
      curDay = day;
      tradesToday = 0;
    }
    const sig = series[idx];
    if (!sig) return null;
    if (tradesToday >= maxPerDay) return null;
    if (idx - lastSignalIdx < minGap) return null;

    lastSignalIdx = idx;
    tradesToday += 1;
    return {
      action: sig.action,
      reason: sig.reason,
      liqBrackets: sig.brackets,
      regime: sig.regime,
      grade: sig.grade,
    };
  };
}

/** Map bot cfg keys (raXxx) to internal opts. */
export function optsFromCfg(cfg = {}) {
  const o = { ...DEFAULT_RA_OPTS };
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  if (cfg.regimeAdaptiveEnableTrend != null) o.enableTrend = cfg.regimeAdaptiveEnableTrend !== false;
  if (cfg.regimeAdaptiveEnableRange != null) o.enableRange = cfg.regimeAdaptiveEnableRange !== false;
  if (cfg.regimeAdaptiveEnableBreakout != null) o.enableBreakout = cfg.regimeAdaptiveEnableBreakout !== false;
  if (cfg.regimeAdaptiveMinGrade) o.minGrade = String(cfg.regimeAdaptiveMinGrade).toUpperCase() === "A" ? GRADE_A : GRADE_B;
  o.confidenceFloor = num(cfg.regimeAdaptiveConfidenceFloor, o.confidenceFloor);
  o.maxTradesPerDay = num(cfg.regimeAdaptiveMaxTradesPerDay, o.maxTradesPerDay);
  o.minBarGap = num(cfg.regimeAdaptiveMinBarGap, o.minBarGap);
  if (cfg.regimeAdaptiveKillzoneMode) o.killzoneMode = String(cfg.regimeAdaptiveKillzoneMode).toUpperCase();
  o.trendRR = num(cfg.regimeAdaptiveTrendRR, o.trendRR);
  o.rangeRR = num(cfg.regimeAdaptiveRangeRR, o.rangeRR);
  o.breakoutRR = num(cfg.regimeAdaptiveBreakoutRR, o.breakoutRR);
  o.atrSlMult = num(cfg.regimeAdaptiveAtrSlMult, o.atrSlMult);
  // Regime-engine threshold overrides (optional).
  const ro = {};
  if (cfg.regimeAdaptiveTrendAdx != null) ro.trendAdxEntry = num(cfg.regimeAdaptiveTrendAdx, 25);
  if (cfg.regimeAdaptiveSqueezePctile != null) ro.squeezePctile = num(cfg.regimeAdaptiveSqueezePctile, 0.2);
  if (cfg.regimeAdaptiveVolatileAtrPct != null) ro.volatileAtrPctEntry = num(cfg.regimeAdaptiveVolatileAtrPct, 0.012);
  if (Object.keys(ro).length) o.regimeOpts = ro;
  return o;
}

/** Live signal — returns the setup for the most recent closed bar (or HOLD). */
export function signal({ candles, timeframe, cfg, state } = {}) {
  if (!candles?.length) return { action: "HOLD", reason: "no_candles" };
  const raw = cfg && typeof cfg === "object" ? cfg : state && typeof state === "object" ? state : {};
  const o = optsFromCfg(raw);
  const { series, regimeLabels } = buildRegimeAdaptiveSeries(candles, o);
  const idx = candles.length - 1;
  const sig = series[idx];
  if (!sig) {
    return { action: "HOLD", reason: `ra_no_setup`, regime: regimeLabels[idx] };
  }
  return { action: sig.action, reason: sig.reason, regime: sig.regime, grade: sig.grade, brackets: sig.brackets };
}

export const REGIME_ADAPTIVE = {
  name: "Regime-Adaptive — one playbook per market regime (trend/range/breakout)",
  signal,
};
