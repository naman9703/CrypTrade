/**
 * Assemble full LIQ feature vector for persistence and research.
 */
import { buildLiqMarketContext } from "./marketState.js";
import { computeSweepQuality } from "./sweepQuality.js";
import { computeDisplacementV2 } from "./displacementV2.js";
import { evaluateContinuationRoom } from "./continuationRoom.js";
import { computeEntryScoreV2 } from "./entryScoreV2.js";

/**
 * @returns {object|null} feature bundle attached to setup / liqContext
 */
export function buildLiqFeatureVector({
  candles,
  cycle,
  side,
  pre,
  opts,
  entryBarIdx,
  reclaimBar,
  entryPx,
  slPrice,
  opposingLevel,
  entryScore,
  entryBreakdown,
  levelMeta,
}) {
  if (!cycle || !candles?.length) return null;

  const marketState = buildLiqMarketContext(candles, entryBarIdx, pre, opts);
  const sweep = computeSweepQuality(candles, cycle, side, pre, opts);
  const displacement = computeDisplacementV2(
    candles,
    cycle.sweepStartIdx,
    entryBarIdx,
    side,
    pre,
    opts,
  );
  const continuation = evaluateContinuationRoom(
    candles,
    entryBarIdx,
    side,
    entryPx,
    slPrice,
    opposingLevel,
    pre,
    opts,
  );

  const scoreV2 =
    entryScore != null && entryBreakdown
      ? { total: entryScore, components: entryBreakdown }
      : computeEntryScoreV2({
          candles,
          cycle,
          side,
          pre,
          opts,
          entryBarIdx,
          reclaimBar,
          sweepQuality: sweep,
          displacementV2: displacement,
          continuationRoom: continuation,
          marketContext: marketState,
        });

  return {
    marketState,
    sessionNarrative: marketState.sessionNarrative,
    level: {
      type: cycle.levelType,
      importance: levelMeta?.importance ?? null,
      source: levelMeta?.source ?? null,
      touches: levelMeta?.touches ?? null,
      level: cycle.level,
    },
    sweep,
    displacement,
    continuation,
    scoreV2: {
      total: scoreV2.score ?? scoreV2.total,
      components: scoreV2.breakdown ?? scoreV2.components,
      penalties: scoreV2.penalties ?? null,
    },
    reclaimIdx: cycle.reclaimIdx,
    sweepStartIdx: cycle.sweepStartIdx,
    entryBarIdx,
  };
}
