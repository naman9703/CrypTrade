/**
 * Supertrend stretch confirmation — Layer 3.
 *
 * Autopsy on ATR-stop BNB: skipping stretched-WITH-flip trades removed winners.
 * Correct rule for ST continuation — skip weak / counter-stretched flips:
 *   BUY  skip if dist_ema20_pct < -emaStretchPct OR rsi14 < rsiLow
 *   SELL skip if dist_ema20_pct >  emaStretchPct OR rsi14 > rsiHigh
 */
import { ema, rsi } from "./indicators.js";

const DEFAULT_EMA_STRETCH_PCT = 0.15;
const DEFAULT_RSI_HIGH = 55;
const DEFAULT_RSI_LOW = 45;

/**
 * @param {Record<string, unknown>} cfg
 * @returns {null | { emaStretchPct: number, rsiHigh: number, rsiLow: number }}
 */
export function readStretchSkipCfg(cfg) {
  if (cfg?.supertrendStretchSkipEnabled !== true) return null;
  const emaStretchPct = Number(cfg?.supertrendStretchEma20Pct ?? DEFAULT_EMA_STRETCH_PCT);
  const rsiHigh = Number(cfg?.supertrendStretchRsiHigh ?? DEFAULT_RSI_HIGH);
  const rsiLow = Number(cfg?.supertrendStretchRsiLow ?? DEFAULT_RSI_LOW);
  return {
    emaStretchPct: Number.isFinite(emaStretchPct) ? Math.abs(emaStretchPct) : DEFAULT_EMA_STRETCH_PCT,
    rsiHigh: Number.isFinite(rsiHigh) ? rsiHigh : DEFAULT_RSI_HIGH,
    rsiLow: Number.isFinite(rsiLow) ? rsiLow : DEFAULT_RSI_LOW,
  };
}

/** @param {any[]} candles */
export function buildStretchSkipSeries(candles) {
  const closes = candles.map((c) => Number(c.close));
  return {
    ema20: ema(closes, 20),
    rsi14: rsi(closes, 14),
  };
}

/**
 * @param {{
 *   candles: any[],
 *   idx: number,
 *   action: string,
 *   opts: { emaStretchPct: number, rsiHigh: number, rsiLow: number },
 *   series?: { ema20: number[], rsi14: number[] } | null,
 * }} args
 */
export function evaluateStretchSkip({ candles, idx, action, opts, series }) {
  if (!opts) return { pass: true, reason: "stretch_off" };
  const close = Number(candles[idx]?.close);
  const ema20 = series?.ema20?.[idx] != null ? Number(series.ema20[idx]) : null;
  const rsiVal = series?.rsi14?.[idx] != null ? Number(series.rsi14[idx]) : null;

  const distEma20Pct =
    Number.isFinite(close) && Number.isFinite(ema20) && ema20 !== 0
      ? ((close - ema20) / Math.abs(ema20)) * 100
      : null;

  const side = String(action || "").toUpperCase();
  if (side === "BUY") {
    if (Number.isFinite(distEma20Pct) && distEma20Pct < -opts.emaStretchPct) {
      return { pass: false, reason: "weak_ema20_long", distEma20Pct, rsi: rsiVal };
    }
    if (Number.isFinite(rsiVal) && rsiVal < opts.rsiLow) {
      return { pass: false, reason: "weak_rsi_long", distEma20Pct, rsi: rsiVal };
    }
  } else if (side === "SELL") {
    if (Number.isFinite(distEma20Pct) && distEma20Pct > opts.emaStretchPct) {
      return { pass: false, reason: "weak_ema20_short", distEma20Pct, rsi: rsiVal };
    }
    if (Number.isFinite(rsiVal) && rsiVal > opts.rsiHigh) {
      return { pass: false, reason: "weak_rsi_short", distEma20Pct, rsi: rsiVal };
    }
  }
  return { pass: true, reason: "stretch_ok", distEma20Pct, rsi: rsiVal };
}
