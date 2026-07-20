/**
 * Continuation room — path from entry to opposing liquidity / structure blockers.
 */
import { dayStartIndex, intradayDayRangePct } from "../liquidity.js";
import { swingHighLow } from "../fibonacci.js";
import { atrPercentileAt } from "../smcRegime.js";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @returns {{ distanceToOpposingR: number, distanceToOpposingAtr: number, dailyRangeUsedPct: number, remainingDailyAtr: number, nearestBlockingSwing: number|null, expansionState: string, trendMaturityBars: number, passed: boolean, score: number }}
 */
export function evaluateContinuationRoom(candles, entryBarIdx, side, entryPx, slPrice, opposingLevel, pre, opts = {}) {
  const entry = num(entryPx);
  const sl = num(slPrice);
  const opposing = num(opposingLevel);
  const bar = candles?.[entryBarIdx];
  const atr = num(pre?.atrSeries?.[entryBarIdx] ?? pre?.atr?.[entryBarIdx]);
  const dayStart = dayStartIndex(candles, entryBarIdx);

  const risk = entry != null && sl != null ? Math.abs(entry - sl) : 0;
  let distanceToOpposingR = 0;
  let distanceToOpposingAtr = 0;
  if (entry != null && opposing != null && risk > 0) {
    const dist = side === "BUY" ? opposing - entry : entry - opposing;
    distanceToOpposingR = dist / risk;
    distanceToOpposingAtr = atr > 0 ? dist / atr : 0;
  }

  let dayHi = -Infinity;
  let dayLo = Infinity;
  for (let j = dayStart; j <= entryBarIdx; j++) {
    const b = candles[j];
    if (!b) continue;
    dayHi = Math.max(dayHi, Number(b.high));
    dayLo = Math.min(dayLo, Number(b.low));
  }
  const dayRange = dayHi > dayLo ? dayHi - dayLo : 0;
  const dayMid = (dayHi + dayLo) / 2;
  const dailyRangeUsedPct =
    dayRange > 0 && entry != null ? Math.min(1, Math.abs(entry - dayLo) / dayRange) : 0;
  const remainingDailyAtr = atr > 0 && dayRange > 0 ? Math.max(0, dayRange - Math.abs(entry - dayMid) * 2) / atr : 0;

  let nearestBlockingSwing = null;
  const swing = swingHighLow(candles, entryBarIdx, 48);
  if (swing && entry != null) {
    if (side === "BUY" && swing.high > entry && swing.high < opposing) nearestBlockingSwing = swing.high;
    if (side === "SELL" && swing.low < entry && swing.low > opposing) nearestBlockingSwing = swing.low;
  }

  const atrPctile = atrPercentileAt(candles, entryBarIdx, Number(opts.intradayLiqAtrPctileLookback ?? 2880));
  const atrPrev = num(pre?.atrSeries?.[Math.max(0, entryBarIdx - 3)]);
  let expansionState = "neutral";
  if (atr != null && atrPrev != null) {
    if (atr > atrPrev * 1.05) expansionState = "expanding";
    else if (atr < atrPrev * 0.95) expansionState = "contracting";
  }
  if (atrPctile != null && atrPctile > 70) expansionState = "expanding";

  let trendMaturityBars = 0;
  for (let j = entryBarIdx; j >= Math.max(0, entryBarIdx - 64); j--) {
    const up = pre?.htfUp?.[j];
    const down = pre?.htfDown?.[j];
    if (side === "BUY" && up) trendMaturityBars++;
    else if (side === "SELL" && down) trendMaturityBars++;
    else break;
  }

  const minR = Number(opts.intradayLiqMinContinuationR ?? 0);
  const maxDayUsed = Number(opts.intradayLiqMaxDailyRangeUsedPct ?? 0);
  let passed = true;
  if (minR > 0 && distanceToOpposingR + 1e-9 < minR) passed = false;
  if (maxDayUsed > 0 && dailyRangeUsedPct > maxDayUsed) passed = false;
  if (nearestBlockingSwing != null && risk > 0) {
    const blockDist = Math.abs(nearestBlockingSwing - entry) / risk;
    if (blockDist < minR * 0.5) passed = false;
  }

  let score = 0;
  if (minR > 0) score += Math.min(12, Math.max(0, (distanceToOpposingR / minR) * 8));
  else score += Math.min(12, Math.max(0, distanceToOpposingR * 4));
  if (maxDayUsed > 0) score += Math.max(0, 8 * (1 - dailyRangeUsedPct / maxDayUsed));
  else score += Math.max(0, 8 * (1 - dailyRangeUsedPct));
  if (nearestBlockingSwing == null) score += 4;
  if (expansionState === "expanding") score += 2;
  score = Math.max(0, Math.min(20, Math.round(score)));

  return {
    distanceToOpposingR: Number(distanceToOpposingR.toFixed(4)),
    distanceToOpposingAtr: Number(distanceToOpposingAtr.toFixed(4)),
    dailyRangeUsedPct: Number(dailyRangeUsedPct.toFixed(4)),
    remainingDailyAtr: Number(remainingDailyAtr.toFixed(4)),
    nearestBlockingSwing,
    expansionState,
    trendMaturityBars,
    passed,
    score,
  };
}

export function passesContinuationRoomGate(candles, entryBarIdx, side, entryPx, slPrice, opposingLevel, pre, opts = {}) {
  if (opts.intradayLiqContinuationGate !== true) return true;
  return evaluateContinuationRoom(candles, entryBarIdx, side, entryPx, slPrice, opposingLevel, pre, opts).passed;
}
