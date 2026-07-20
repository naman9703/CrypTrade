/**
 * Entry score v2 — component-transparent 0–100 liquidity entry quality.
 */
import { reclaimHeldThrough } from "../liquidity.js";
import { isExternalLiquidityLevel, scoreSessionNarrative } from "./marketState.js";
import { levelImportanceScore } from "./liquidityLevels.js";
import { scoreSweepQuality } from "./sweepQuality.js";
import { scoreDisplacementV2 } from "./displacementV2.js";

function reclaimHoldScore(candles, cycle, side, entryBarIdx, reclaimBar) {
  let reclaimPts = 0;
  const range = Math.max(1e-9, Number(reclaimBar.high) - Number(reclaimBar.low));
  const bodyRatio = Math.abs(Number(reclaimBar.close) - Number(reclaimBar.open)) / range;
  reclaimPts += Math.min(10, Math.round(bodyRatio * 12));
  if (side === "BUY" && reclaimBar.close <= reclaimBar.open) reclaimPts = Math.max(0, reclaimPts - 4);
  if (side === "SELL" && reclaimBar.close >= reclaimBar.open) reclaimPts = Math.max(0, reclaimPts - 4);

  const held = reclaimHeldThrough(candles, cycle.reclaimIdx, entryBarIdx, side, cycle.level);
  let holdPts = 0;
  if (held && entryBarIdx > cycle.reclaimIdx) holdPts = 8;
  else if (held) holdPts = 5;
  return Math.min(15, reclaimPts + holdPts);
}

function htfLiquidityAlignScore(side, entryBarIdx, pre, levelType) {
  const htfUp = pre?.htfUp?.[entryBarIdx];
  const htfDown = pre?.htfDown?.[entryBarIdx];
  const sep = Number(pre?.htfSep?.[entryBarIdx] ?? 0);
  const external = isExternalLiquidityLevel(levelType);
  let pts = 6;
  if (side === "BUY" && htfUp) pts += 5;
  if (side === "SELL" && htfDown) pts += 5;
  if (sep >= 0.001) pts += 2;
  if (external && side === "BUY" && htfDown) pts = Math.max(0, pts - 6);
  if (external && side === "SELL" && htfUp) pts = Math.max(0, pts - 6);

  const pdh = Number(pre?.prevDayHigh?.[entryBarIdx]);
  const pdl = Number(pre?.prevDayLow?.[entryBarIdx]);
  const entry = Number(pre?.ema9?.[entryBarIdx] ?? 0);
  if (pdh > pdl && entry > 0) {
    const mid = (pdh + pdl) / 2;
    if (side === "BUY" && entry <= mid) pts += 2;
    if (side === "SELL" && entry >= mid) pts += 2;
  }
  return Math.max(0, Math.min(15, pts));
}

/**
 * @returns {{ score: number, breakdown: object, penalties: object }}
 */
export function computeEntryScoreV2({
  candles,
  cycle,
  side,
  pre,
  opts,
  entryBarIdx,
  reclaimBar,
  sweepQuality,
  displacementV2,
  continuationRoom,
  marketContext,
}) {
  const breakdown = {
    sweepQuality: scoreSweepQuality(sweepQuality ?? {}),
    displacement: scoreDisplacementV2(displacementV2 ?? {}, opts),
    reclaimHold: reclaimHoldScore(candles, cycle, side, entryBarIdx, reclaimBar),
    htfLiquidityAlign: htfLiquidityAlignScore(side, entryBarIdx, pre, cycle.levelType),
    continuationRoom: Number(continuationRoom?.score ?? 0),
    levelImportance: levelImportanceScore(cycle.levelType),
    sessionNarrative: scoreSessionNarrative(
      marketContext?.sessionNarrative ?? "off_hours",
      side,
      cycle.levelType,
    ),
  };

  const penalties = {};
  const reclaimBars = entryBarIdx - cycle.sweepStartIdx;
  if (reclaimBars <= 2 && Number(displacementV2?.impulseAtr ?? 0) < 1.2) {
    penalties.fastReclaim = -6;
  }
  if (Number(sweepQuality?.absorptionProxy ?? 0) > 0.65) penalties.absorption = -5;
  if (marketContext?.regime === "VOLATILE_AVOID") penalties.volatile = -8;

  const penaltySum = Object.values(penalties).reduce((a, b) => a + b, 0);
  const raw =
    breakdown.sweepQuality +
    breakdown.displacement +
    breakdown.reclaimHold +
    breakdown.htfLiquidityAlign +
    breakdown.continuationRoom +
    breakdown.levelImportance +
    breakdown.sessionNarrative +
    penaltySum;

  const score = Math.max(0, Math.min(100, Math.round(raw)));
  return { score, breakdown, penalties };
}
