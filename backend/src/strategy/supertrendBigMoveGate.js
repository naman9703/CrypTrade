/**
 * Supertrend Big-Move Entry Gate (indicator section — NOT intelligence gate).
 *
 * Couples with Supertrend flips to allow only entries where the signal bar shows
 * enough momentum + expected range to reach at least T1 (default 1.5× SL distance)
 * before chop/trail stops the trade out.
 *
 * Uses the same primitives as the Trading tab "Signal strength" + "Move quality" engines,
 * unified into one pass/fail for backtest + live.
 */

import { evaluateSignalStrength } from "./signalStrength.js";
import { evaluateSupertrendMoveQuality } from "./supertrendMoveQuality.js";
import { computeIndicators } from "./indicators.js";

export const BIG_MOVE_DEFAULTS = {
  minStrength: 65,
  minMoveToSlRatio: 1.5,
  minAdx: 22,
  minScore: 0.55,
  maxCandlesSinceFlip: 2,
  minVolumeVsAvg: 1.1,
  expectedMoveAtrMult: 1.8,
};

/**
 * @param {Record<string, unknown>} cfg
 * @returns {null | typeof BIG_MOVE_DEFAULTS}
 */
export function readBigMoveGateCfg(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  if (c.supertrendBigMoveGateEnabled !== true) return null;
  return {
    minStrength: Number(c.supertrendBigMoveMinStrength ?? BIG_MOVE_DEFAULTS.minStrength),
    minMoveToSlRatio: Number(c.supertrendBigMoveMinMoveSlRatio ?? BIG_MOVE_DEFAULTS.minMoveToSlRatio),
    minAdx: Number(c.supertrendBigMoveMinAdx ?? BIG_MOVE_DEFAULTS.minAdx),
    minScore: Number(c.supertrendBigMoveMinScore ?? BIG_MOVE_DEFAULTS.minScore),
    maxCandlesSinceFlip: Number(c.supertrendBigMoveMaxCandlesSinceFlip ?? BIG_MOVE_DEFAULTS.maxCandlesSinceFlip),
    minVolumeVsAvg: Number(c.supertrendBigMoveMinVolumeVsAvg ?? BIG_MOVE_DEFAULTS.minVolumeVsAvg),
    expectedMoveAtrMult: Number(c.supertrendBigMoveExpectedMoveAtrMult ?? BIG_MOVE_DEFAULTS.expectedMoveAtrMult),
  };
}

/**
 * @param {object} p
 * @param {Array} p.candles
 * @param {number} p.idx signal bar index
 * @param {{ action: 'BUY'|'SELL' }} p.barSignal
 * @param {Array<{ upper?: number, lower?: number, line?: number }>|null} p.stSeries
 * @param {number} p.lastFlipIdx index of previous ST flip
 * @param {number} p.slDistancePct fixed SL fraction (e.g. 0.012)
 * @param {typeof BIG_MOVE_DEFAULTS} p.opts
 */
export function evaluateSupertrendBigMoveGate({
  candles,
  idx,
  barSignal,
  stSeries,
  lastFlipIdx,
  slDistancePct,
  opts,
}) {
  const o = opts || BIG_MOVE_DEFAULTS;
  const bar = candles[idx];
  if (!bar || !barSignal?.action) return { pass: false, reason: "no_bar", strength: 0, moveToSlRatio: 0 };

  const stBar = stSeries?.[idx];
  const upper = Number(stBar?.upper ?? stBar?.line ?? bar.close);
  const lower = Number(stBar?.lower ?? stBar?.line ?? bar.close);
  const slice = candles.slice(Math.max(0, idx - 120 + 1), idx + 1);
  const latest = computeIndicators(slice)?.latest;
  const atrPct = Number(latest?.atr_pct ?? 0);
  const volRatio = Number(latest?.volume_ratio ?? 1);

  const candlesSinceFlip =
    lastFlipIdx == null || lastFlipIdx < 0 ? 0 : Math.max(0, idx - lastFlipIdx);
  if (candlesSinceFlip > o.maxCandlesSinceFlip) {
    return { pass: false, reason: "stale_flip", strength: 0, moveToSlRatio: 0 };
  }

  const ss = evaluateSignalStrength(
    {
      price: bar.close,
      upperBand: upper,
      lowerBand: lower,
      atr: (atrPct / 100) * bar.close || bar.close * 0.01,
      atrMultiplier: 3,
      rsi: Number(latest?.rsi_14 ?? 50),
      volumeRatio: volRatio,
      candlesSinceFlip,
      ema50: Number(latest?.ema_50 ?? bar.close),
    },
    o.minStrength,
  );

  if (!ss || ss.strength < o.minStrength) {
    return {
      pass: false,
      reason: "low_signal_strength",
      strength: ss?.strength ?? 0,
      moveToSlRatio: 0,
      detail: ss,
    };
  }

  const slPct = Number(slDistancePct) > 0 ? Number(slDistancePct) : 0.012;
  const mq = evaluateSupertrendMoveQuality({
    candles: slice,
    latest,
    openingSide: barSignal.action,
    slDistancePct: slPct,
    options: {
      minScore: o.minScore,
      minAdx: o.minAdx,
      minMoveToSlRatio: o.minMoveToSlRatio,
      expectedMoveAtrMult: o.expectedMoveAtrMult,
      minVolumeVsAvgRatio: o.minVolumeVsAvg,
    },
  });

  const moveToSlRatio = Number(mq?.detail?.moveToSlRatio ?? 0);
  const t1Pct = slPct * 1.5;

  if (!mq.pass) {
    return {
      pass: false,
      reason: mq.hardFails?.[0] || "move_quality_fail",
      strength: ss.strength,
      moveToSlRatio,
      expectedMovePct: Number(mq?.detail?.expectedMovePct ?? 0),
      t1Pct,
      detail: mq,
    };
  }

  if (moveToSlRatio < o.minMoveToSlRatio) {
    return {
      pass: false,
      reason: "expected_move_below_t1",
      strength: ss.strength,
      moveToSlRatio,
      expectedMovePct: Number(mq?.detail?.expectedMovePct ?? 0),
      t1Pct,
    };
  }

  return {
    pass: true,
    reason: "pass",
    strength: ss.strength,
    moveToSlRatio,
    expectedMovePct: Number(mq?.detail?.expectedMovePct ?? 0),
    t1Pct,
    moveEstimatePct: ss.moveEstimatePct,
    action: ss.action,
  };
}
