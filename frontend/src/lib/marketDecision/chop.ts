import type { MarketDecisionEngineConfig, RegimeSlice } from "./types";

export function countRegimeFlips(history: RegimeSlice[], lookback: number): number {
  const slice = history.slice(-Math.max(2, lookback));
  if (slice.length < 2) return 0;
  let flips = 0;
  for (let i = 1; i < slice.length; i++) {
    if (slice[i]!.type !== slice[i - 1]!.type) flips += 1;
  }
  return flips;
}

export function evaluateChop(args: {
  config: MarketDecisionEngineConfig;
  history: RegimeSlice[];
  adx: number;
  rangeCompression: number;
}): { isChoppy: boolean; reasons: string[]; metrics: Record<string, number> } {
  const { config, history, adx, rangeCompression } = args;
  const reasons: string[] = [];
  const metrics: Record<string, number> = {
    adx: Number(adx),
    rangeCompression: Number(rangeCompression),
    flips: countRegimeFlips(history, config.stabilityLookback + 2),
  };

  if (!config.chopEnabled) {
    return { isChoppy: false, reasons: [], metrics };
  }

  if (config.chopAdxEnabled && adx < config.adxWeak) {
    reasons.push(`ADX ${adx.toFixed(1)} < weak ${config.adxWeak}`);
  }
  if (config.chopRangeEnabled && rangeCompression < config.chopRangeThreshold) {
    reasons.push(`Range compression ${(rangeCompression * 100).toFixed(3)}% < ${(config.chopRangeThreshold * 100).toFixed(3)}%`);
  }
  if (config.chopFlipEnabled && metrics.flips > config.chopMaxFlips) {
    reasons.push(`Regime flips ${metrics.flips} > ${config.chopMaxFlips}`);
  }

  const isChoppy = reasons.length > 0;
  return { isChoppy, reasons, metrics };
}
