/**
 * Market regime + signal-quality decision engine (pure, deterministic).
 * Use {@link evaluateMarketDecision} at signal time; attach snapshot to signals (frozen).
 */

export type {
  DecisionVerdict,
  MarketDecisionEngineConfig,
  MarketDecisionInput,
  MarketDecisionPassThresholds,
  MarketDecisionSnapshot,
  PipelineStageId,
  RegimeSlice,
  RegimeType,
  ScoreBreakdownRow,
} from "./types";
export { MARKET_DECISION_SCHEMA_VERSION } from "./types";

export { DEFAULT_MARKET_DECISION_CONFIG, mergeMarketDecisionConfig } from "./configDefaults";
export { deepFreezeSnapshot } from "./freeze";
export { computeRegimeSliceFromBar } from "./regime";
export { computeRegimeStability, detectRegimeTransition } from "./stability";
export { evaluateChop, countRegimeFlips } from "./chop";
export { computeSignalQualityScore } from "./score";
export { evaluateFeeGate, computeRequiredMovePct } from "./feeGate";
export { evaluateEntryTiming } from "./entryTiming";
export { evaluateMarketDecision } from "./pipeline";
export { displayMarketDecisionVerdict, mdEngineIsBypass, mdEnforcementOff } from "./display";
export { buildRegimeHistoryLtf } from "./helpers";
