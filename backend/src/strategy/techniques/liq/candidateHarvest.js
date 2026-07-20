/**
 * Harvest every LIQ sweep→reclaim candidate with features + forward labels.
 * Removes day-picker selection bias for research.
 */
import { listSessionLiquiditySetups } from "../liquidity.js";
import { computeForwardLabels, computeReach1RBeforeSl, estimateOutcomeDistribution } from "./forwardLabels.js";
import { flattenLiqFeatures } from "./flattenFeatures.js";
import { observableFeaturesAt } from "../../../backtest/data/observableFeatures.js";

const WARMUP = 96;

function utcDayId(ts) {
  return Math.floor(ts / 86_400_000);
}

function candidateKey(setup, entryIdx, candles) {
  const ts = candles[entryIdx]?.ts ?? 0;
  return `${ts}|${setup.side}|${setup.levelType}|${setup.level}|${setup.reclaimIdx}`;
}

/**
 * @param {object[]} candles
 * @param {object} pre — precomputeIntraday output
 * @param {object} opts — must include _liqPre; harvest preset flags
 * @returns {object[]}
 */
export function harvestLiqCandidates(candles, pre, opts = {}) {
  if (!candles?.length) return [];
  const harvestOpts = {
    ...opts,
    _liqPre: pre,
    intradayLiqHarvestMode: true,
  };

  const seen = new Set();
  const raw = [];

  for (let i = WARMUP; i < candles.length; i++) {
    for (const side of ["BUY", "SELL"]) {
      const setups = listSessionLiquiditySetups(candles, i, side, pre, harvestOpts);
      for (const setup of setups) {
        const holdBars = Number(harvestOpts.intradayLiqReclaimHoldBars ?? 1);
        const entryIdx = holdBars > 0 ? i : setup.reclaimIdx ?? i;
        if (entryIdx >= candles.length) continue;

        const key = candidateKey(setup, entryIdx, candles);
        if (seen.has(key)) continue;
        seen.add(key);

        const entryPx = Number(setup.entry ?? candles[entryIdx]?.close);
        const slPrice = Number(setup.slPrice);
        if (!(entryPx > 0) || !(slPrice > 0)) continue;

        const forward = computeForwardLabels(candles, entryIdx, side, entryPx, slPrice, pre, {
          ...harvestOpts,
          opposingLevel: setup.opposingLevel,
        });
        const reach1R = computeReach1RBeforeSl(candles, entryIdx, side, entryPx, slPrice);
        const outcomeDist = estimateOutcomeDistribution({ ...forward, probReach1R: reach1R });
        if (!forward) continue;

        raw.push({
          candidateKey: key,
          symbol: harvestOpts.symbol ?? "",
          entryTs: candles[entryIdx].ts,
          entryYear: new Date(candles[entryIdx].ts).getUTCFullYear(),
          entryBarIdx: entryIdx,
          dayId: utcDayId(candles[entryIdx].ts),
          side,
          levelType: setup.levelType,
          level: setup.level,
          entryPx,
          slPrice,
          rr: setup.rr ?? null,
          liqQuality: setup.liqQuality ?? null,
          weightedQuality: setup.weightedQuality ?? setup.liqQuality ?? null,
          entryContextScore: setup.entryContextScore ?? null,
          levelImportance: setup.levelImportance ?? null,
          ...(harvestOpts.observableSeries
            ? observableFeaturesAt(harvestOpts.observableSeries, candles[entryIdx].ts)
            : {}),
          ...flattenLiqFeatures(setup.liqFeatures),
          ...forward,
          ...outcomeDist,
          probReach1R: reach1R,
          candidateTier: harvestOpts.intradayLiqMinimalCandidate ? "minimal" : "filtered",
          wouldPassScore:
            (setup.entryContextScore ?? setup.liqQuality ?? 0) >=
            Number(harvestOpts.intradayLiqMinEntryScore ?? 0)
              ? 1
              : 0,
        });
      }
    }
  }

  return markDayPickerSelection(raw, harvestOpts);
}

/**
 * Simulate production day picker — flag which candidate would have been traded.
 */
export function markDayPickerSelection(candidates, opts = {}) {
  const byDaySide = new Map();
  for (const c of candidates) {
    const k = `${c.dayId}|${c.side}`;
    if (!byDaySide.has(k)) byDaySide.set(k, []);
    byDaySide.get(k).push(c);
  }

  const pickedKeys = new Set();
  for (const list of byDaySide.values()) {
    list.sort(
      (a, b) =>
        Number(b.weightedQuality ?? b.liqQuality ?? 0) - Number(a.weightedQuality ?? a.liqQuality ?? 0),
    );
    const cap = Number(opts.intradayLiqMaxTradesPerSidePerDay ?? 1);
    for (let i = 0; i < Math.min(cap, list.length); i++) {
      pickedKeys.add(list[i].candidateKey);
    }
  }

  return candidates.map((c) => ({
    ...c,
    selectedByDayPicker: pickedKeys.has(c.candidateKey) ? 1 : 0,
    selectionBias: pickedKeys.has(c.candidateKey) ? "picked" : "rejected",
  }));
}

export function candidateToCsvRow(c) {
  return { ...c, recordType: "candidate" };
}
