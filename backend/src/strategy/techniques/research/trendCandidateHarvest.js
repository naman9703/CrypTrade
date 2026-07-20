/**
 * Family C — Trend acceleration harvest (SUPERTREND_ELITE flips at L0–L1).
 * Records every primary-TF supertrend flip with gate features + forward labels.
 */
import { computeSupertrendSeries } from "../../supertrend.js";
import {
  ELITE_ST_DEFAULTS,
  buildEliteStIndicatorContext,
  computeEliteGateFeatures,
  buildEliteStOptsFromCfg,
} from "../../supertrendElite.js";
import { computeForwardLabels, computeReach1RBeforeSl, estimateOutcomeDistribution } from "../liq/forwardLabels.js";
import { markDayPickerSelection, slFromAtr, utcDayId } from "./candidateHarvestShared.js";
import { observableFeaturesAt } from "../../../backtest/data/observableFeatures.js";

const WARMUP = 120;

/**
 * Harvest preset — all gate thresholds recorded as features, not hard filters.
 */
export const TREND_CANDIDATE_HARVEST_OPTS = {
  ...ELITE_ST_DEFAULTS,
  minAdx: 0,
  requireAdxRising: false,
  minVolumeVsAvg: 0,
  requireHtf1hEmaAlign: true,
  requireHtf4hAlign: true,
  requireAtrExpansion: false,
  liqSweepEnabled: false,
};

/**
 * @param {object[]} candles
 * @param {object} pre — precomputeIntraday output
 * @param {object} opts
 */
export function harvestTrendCandidates(candles, pre, opts = {}) {
  if (!candles?.length) return [];

  const eliteOpts = buildEliteStOptsFromCfg({ ...TREND_CANDIDATE_HARVEST_OPTS, ...opts });
  const ctx = buildEliteStIndicatorContext(candles, eliteOpts);
  const stSeries = computeSupertrendSeries(candles, {
    period: eliteOpts.period ?? ELITE_ST_DEFAULTS.period,
    multiplier: eliteOpts.multiplier ?? ELITE_ST_DEFAULTS.multiplier,
    wilderAtr: eliteOpts.wilderAtr !== false,
  });

  const raw = [];
  const seen = new Set();

  for (let i = WARMUP; i < candles.length; i++) {
    const bar = stSeries[i];
    if (!bar?.ready) continue;
    const side = bar.buySignal ? "BUY" : bar.sellSignal ? "SELL" : null;
    if (!side) continue;

    const key = `${candles[i].ts}|${side}|st_flip`;
    if (seen.has(key)) continue;
    seen.add(key);

    const entryPx = Number(candles[i].close);
    const atr = Number(pre?.atrSeries?.[i] ?? 0);
    if (!(entryPx > 0) || !(atr > 0)) continue;

    const slPrice = slFromAtr(entryPx, side, atr);
    const gates = computeEliteGateFeatures(ctx, i, side, candles);
    const forward = computeForwardLabels(candles, i, side, entryPx, slPrice, pre, opts);
    if (!forward) continue;

    const reach1R = computeReach1RBeforeSl(candles, i, side, entryPx, slPrice);
    const outcomeDist = estimateOutcomeDistribution({ ...forward, probReach1R: reach1R });

    raw.push({
      candidateKey: key,
      familyId: "C",
      familyName: "trend_acceleration",
      trigger: "st_flip",
      symbol: opts.symbol ?? "",
      entryTs: candles[i].ts,
      entryYear: new Date(candles[i].ts).getUTCFullYear(),
      entryBarIdx: i,
      dayId: utcDayId(candles[i].ts),
      side,
      entryPx,
      slPrice,
      marketState_adx: pre?.adxSeries?.[i] ?? gates.gate_adx,
      marketState_atrPct: atr > 0 ? atr / entryPx : null,
      marketState_regime: opts._regimeAt?.[i]?.regime ?? "",
      ...gates,
      ...(opts.observableSeries ? observableFeaturesAt(opts.observableSeries, candles[i].ts) : {}),
      ...forward,
      ...outcomeDist,
      probReach1R: reach1R,
      compositeScore: gates.elite_composite_score,
      wouldPassProductionGates: gates.gate_pass_count >= 4 ? 1 : 0,
      candidateTier: "minimal",
    });
  }

  return markDayPickerSelection(raw, {
    dayPickerScoreKey: "compositeScore",
    maxTradesPerSidePerDay: opts.maxTradesPerSidePerDay ?? 1,
  });
}
