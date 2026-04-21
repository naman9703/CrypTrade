import type { MarketDecisionEngineConfig } from "./types";

/** Single source of defaults — merge with persisted user config. */
export const DEFAULT_MARKET_DECISION_CONFIG: MarketDecisionEngineConfig = {
  enabled: false,
  regimeFilterEnabled: true,
  adxStrong: 25,
  adxWeak: 20,
  emaLength: 50,
  atrVolThreshold: 0.015,
  stabilityLookback: 5,
  stabilityMinAgree: 4,
  transitionBlockEnabled: true,
  transitionLookback: 3,
  minRegimeConfidence: 45,
  confidenceMode: "PENALTY",
  confidencePenalty: 25,
  chopEnabled: true,
  chopAdxEnabled: true,
  chopRangeEnabled: true,
  chopFlipEnabled: true,
  chopRangeThreshold: 0.012,
  chopMaxFlips: 3,
  chopHardBlock: true,
  directionMismatchMode: "BLOCK",
  directionMismatchPenalty: 40,
  allowSidewaysWithSignal: false,
  htfEnabled: false,
  htfTimeframe: "15m",
  btcFilterEnabled: false,
  btcSymbol: "BTCUSDT",
  btcMinAdx: 18,
  btcBlockMode: "BLOCK",
  btcFilterPenalty: 20,
  signalQualityEnabled: true,
  scoreThreshold: 5,
  weightSupertrend: 3,
  weightEmaAlign: 2,
  weightRsi: 1,
  weightHtfMatch: 2,
  penaltyChop: 3,
  penaltyWeakTrend: 2,
  penaltyOverextension: 2,
  entryMode: "PULLBACK",
  pullbackAtrMult: 0.35,
  feeGateEnabled: true,
  feeSlippageBps: 3,
  feeBufferPct: 0.15,
  defaultRoundTripFeeRate: 0.0016,
};

export function mergeMarketDecisionConfig(
  partial: Partial<MarketDecisionEngineConfig> | null | undefined,
): MarketDecisionEngineConfig {
  if (!partial || typeof partial !== "object") return { ...DEFAULT_MARKET_DECISION_CONFIG };
  return { ...DEFAULT_MARKET_DECISION_CONFIG, ...partial };
}
