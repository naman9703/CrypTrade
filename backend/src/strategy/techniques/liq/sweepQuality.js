/**
 * Sweep quality metrics — velocity, attempts, volume spike, absorption.
 */
import { rejectionWickRatio } from "../liquidity.js";

function trailingAvgVolume(candles, idx, lookback) {
  let sum = 0;
  let n = 0;
  for (let j = Math.max(0, idx - lookback); j < idx; j++) {
    const v = Number(candles[j]?.volume);
    if (Number.isFinite(v) && v > 0) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

function sweepExtension(side, level, wick) {
  if (!level || level <= 0) return 0;
  return side === "BUY" ? (level - wick) / level : (wick - level) / level;
}

/**
 * @param {object} cycle — sweep cycle with optional attemptCount
 */
export function computeSweepQuality(candles, cycle, side, pre, opts = {}) {
  const sweepStart = Number(cycle.sweepStartIdx);
  const reclaimIdx = Number(cycle.reclaimIdx);
  const level = Number(cycle.level);
  const wick = Number(cycle.wick);
  const durationBars = Math.max(1, reclaimIdx - sweepStart);
  const extension = cycle.extension ?? sweepExtension(side, level, wick);
  const atr = Number(pre?.atrSeries?.[reclaimIdx] ?? pre?.atr?.[reclaimIdx] ?? 0);
  const atrNorm = atr > 0 && level > 0 ? (extension * level) / atr : extension * 100;

  const sweepVelocity = extension / durationBars;
  const sweepVelocityAtr = atrNorm / durationBars;

  const mid = sweepStart + Math.floor(durationBars / 2);
  let velFirst = 0;
  let velSecond = 0;
  if (mid > sweepStart) {
    const extMid = sweepExtension(side, level, side === "BUY" ? Math.min(...candles.slice(sweepStart, mid + 1).map((b) => b.low)) : Math.max(...candles.slice(sweepStart, mid + 1).map((b) => b.high)));
    velFirst = extMid / Math.max(1, mid - sweepStart);
    velSecond = Math.max(0, extension - extMid) / Math.max(1, reclaimIdx - mid);
  }
  const sweepAcceleration = velSecond - velFirst;

  const sweepPct = Number(opts.sweepPct ?? opts.srIntradaySweepPct ?? 0.0006);
  const tol = level * sweepPct;
  let timeInsideLiquidity = 0;
  for (let j = sweepStart; j <= reclaimIdx; j++) {
    const b = candles[j];
    if (!b) continue;
    const inside =
      side === "BUY"
        ? b.low <= level + tol && b.low >= level - tol * 2
        : b.high >= level - tol && b.high <= level + tol * 2;
    if (inside) timeInsideLiquidity++;
  }

  const attemptCount = Number(cycle.attemptCount ?? 1);
  const volLookback = Math.max(2, Number(opts.intradayLiqSweepVolLookback ?? 20));
  let maxVolRatio = 0;
  for (let j = sweepStart; j <= reclaimIdx; j++) {
    const v = Number(candles[j]?.volume);
    const avg = trailingAvgVolume(candles, j, volLookback);
    if (avg > 0 && v > 0) maxVolRatio = Math.max(maxVolRatio, v / avg);
  }
  const sweepVolSpike = maxVolRatio;

  const progressPerVol = sweepVolSpike > 0 ? extension / sweepVolSpike : extension;
  const absorptionProxy = sweepVolSpike > 1.5 && progressPerVol < 0.001 ? 1 : Math.max(0, 1 - progressPerVol * 200);

  const reclaimBar = candles[reclaimIdx];
  let exhaustionScore = 0;
  if (reclaimBar) {
    const wickR = rejectionWickRatio(reclaimBar, side);
    const range = Math.max(1e-9, reclaimBar.high - reclaimBar.low);
    const body = Math.abs(reclaimBar.close - reclaimBar.open) / range;
    exhaustionScore = Math.min(1, wickR * 0.6 + (1 - body) * 0.4);
  }

  return {
    sweepDurationBars: durationBars,
    sweepVelocity: Number(sweepVelocity.toFixed(6)),
    sweepVelocityAtr: Number(sweepVelocityAtr.toFixed(4)),
    sweepAcceleration: Number(sweepAcceleration.toFixed(6)),
    timeInsideLiquidity,
    attemptCount,
    sweepVolSpike: Number(sweepVolSpike.toFixed(3)),
    absorptionProxy: Number(absorptionProxy.toFixed(3)),
    exhaustionScore: Number(exhaustionScore.toFixed(3)),
  };
}

export function scoreSweepQuality(metrics) {
  let pts = 0;
  const vel = Number(metrics.sweepVelocityAtr ?? 0);
  if (vel >= 0.05 && vel <= 0.35) pts += 10;
  else if (vel > 0 && vel < 0.6) pts += 5;
  if (Number(metrics.sweepVolSpike) >= 1.2) pts += 5;
  if (Number(metrics.exhaustionScore) >= 0.45) pts += 5;
  if (Number(metrics.attemptCount) <= 2) pts += 3;
  else if (Number(metrics.attemptCount) > 4) pts -= 4;
  if (Number(metrics.absorptionProxy) > 0.6) pts -= 5;
  return Math.max(0, Math.min(25, pts));
}

export function passesSweepQualityGate(candles, cycle, side, pre, opts = {}) {
  if (opts.intradayLiqSweepQualityGate !== true) return true;
  const m = computeSweepQuality(candles, cycle, side, pre, opts);
  const maxVel = Number(opts.intradayLiqMaxSweepVelocityAtr ?? 0.8);
  const minVel = Number(opts.intradayLiqMinSweepVelocityAtr ?? 0);
  if (maxVel > 0 && m.sweepVelocityAtr > maxVel) return false;
  if (minVel > 0 && m.sweepVelocityAtr + 1e-9 < minVel) return false;
  const maxAttempts = Number(opts.intradayLiqMaxSweepAttempts ?? 0);
  if (maxAttempts > 0 && m.attemptCount > maxAttempts) return false;
  if (Number(opts.intradayLiqMaxAbsorptionProxy ?? 0) > 0 && m.absorptionProxy > Number(opts.intradayLiqMaxAbsorptionProxy)) {
    return false;
  }
  return true;
}
