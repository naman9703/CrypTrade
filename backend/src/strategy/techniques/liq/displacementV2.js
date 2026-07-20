/**
 * Displacement v2 — sequence metrics over sweep→entry window.
 */
import { maxSweepCycleImpulseAtr } from "../liquidity.js";

function barOverlap(b0, b1) {
  if (!b0 || !b1) return 0;
  const hi = Math.min(b0.high, b1.high);
  const lo = Math.max(b0.low, b1.low);
  const overlap = Math.max(0, hi - lo);
  const r0 = Math.max(1e-9, b0.high - b0.low);
  const r1 = Math.max(1e-9, b1.high - b1.low);
  return overlap / Math.min(r0, r1);
}

/**
 * @returns {{ consecutiveImbalanceBars: number, bodyEfficiency: number, overlapRatio: number, momentumPersistence: number, atrExpansion: number, impulseAtr: number }}
 */
export function computeDisplacementV2(candles, sweepStartIdx, entryBarIdx, side, pre, opts = {}) {
  const start = Math.max(0, Number(sweepStartIdx));
  const end = Math.max(start, Number(entryBarIdx));
  const bodyMult = Number(opts.intradayLiqDispBodyAtrMult ?? 0.85);

  let consecutiveImbalanceBars = 0;
  let maxRun = 0;
  let bodyEffSum = 0;
  let bodyEffN = 0;
  let overlapSum = 0;
  let overlapN = 0;
  let momentumBars = 0;
  let totalBars = 0;

  for (let j = start; j <= end; j++) {
    const b = candles[j];
    if (!b) continue;
    totalBars++;
    const atr = Number(pre?.atrSeries?.[j] ?? 0);
    const range = Math.max(1e-9, b.high - b.low);
    const body = Math.abs(b.close - b.open);
    const eff = body / range;
    bodyEffSum += eff;
    bodyEffN++;

    const bullish = b.close > b.open;
    const bearish = b.close < b.open;
    const aligned = side === "BUY" ? bullish : bearish;
    if (aligned) momentumBars++;
    if (atr > 0 && body >= atr * bodyMult && aligned) {
      consecutiveImbalanceBars++;
      maxRun = Math.max(maxRun, consecutiveImbalanceBars);
    } else {
      consecutiveImbalanceBars = 0;
    }

    if (j > start) {
      overlapSum += barOverlap(candles[j - 1], b);
      overlapN++;
    }
  }

  const atrStart = Number(pre?.atrSeries?.[start] ?? 0);
  const atrEnd = Number(pre?.atrSeries?.[end] ?? 0);
  const atrExpansion = atrStart > 0 ? atrEnd / atrStart : 1;
  const impulseAtr = maxSweepCycleImpulseAtr(candles, start, end, pre);

  return {
    consecutiveImbalanceBars: maxRun,
    bodyEfficiency: bodyEffN > 0 ? Number((bodyEffSum / bodyEffN).toFixed(4)) : 0,
    overlapRatio: overlapN > 0 ? Number((overlapSum / overlapN).toFixed(4)) : 0,
    momentumPersistence: totalBars > 0 ? Number((momentumBars / totalBars).toFixed(4)) : 0,
    atrExpansion: Number(atrExpansion.toFixed(4)),
    impulseAtr: Number(impulseAtr.toFixed(4)),
  };
}

export function scoreDisplacementV2(metrics, opts = {}) {
  let pts = 0;
  const imp = Number(metrics.impulseAtr ?? 0);
  if (imp >= 2.5) pts += 8;
  else if (imp >= 1.5) pts += 5;
  else if (imp >= 1.0) pts += 2;

  if (Number(metrics.consecutiveImbalanceBars) >= 2) pts += 5;
  if (Number(metrics.bodyEfficiency) >= 0.45) pts += 4;
  if (Number(metrics.overlapRatio) <= 0.35) pts += 4;
  if (Number(metrics.momentumPersistence) >= 0.55) pts += 4;
  if (Number(metrics.atrExpansion) >= 1.05) pts += 3;

  if (opts.intradayLiqRequireDisplacementV2 === true) {
    const minImp = Number(opts.intradayLiqSweepDisplacementMinAtrMult ?? 1.2);
    if (imp + 1e-9 < minImp) return 0;
  }

  return Math.max(0, Math.min(25, pts));
}

export function passesDisplacementV2Gate(candles, sweepStartIdx, entryBarIdx, side, pre, opts = {}) {
  if (opts.intradayLiqRequireDisplacementV2 !== true) return true;
  const m = computeDisplacementV2(candles, sweepStartIdx, entryBarIdx, side, pre, opts);
  const minImp = Number(opts.intradayLiqSweepDisplacementMinAtrMult ?? 1.2);
  return Number(m.impulseAtr) + 1e-9 >= minImp && Number(m.momentumPersistence) >= 0.35;
}
