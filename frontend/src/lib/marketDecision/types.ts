/**
 * Market regime + signal-quality decision engine (pure, deterministic).
 * Schema version bumps when snapshot shape changes incompatibly.
 */

export const MARKET_DECISION_SCHEMA_VERSION = 6 as const;

export type RegimeType = "UPTREND" | "DOWNTREND" | "SIDEWAYS" | "VOLATILE" | "UNCLEAR";

/** BYPASS = legacy / warm-up placeholder; when master switch is off, snapshots use ALLOW/BLOCK/WAIT + {@link MarketDecisionSnapshot.engineDisabled}. */
export type DecisionVerdict = "ALLOW" | "BLOCK" | "WAIT" | "BYPASS";

/** Per-row verdict for the signal accordion (market decision parameters). */
export type StageCheckVerdict = "ALLOW" | "BLOCK" | "WAIT" | "N_A";

export interface MarketDecisionStageCheck {
  id: string;
  label: string;
  verdict: StageCheckVerdict;
  detail: string;
}

export type PipelineStageId =
  | "engine_disabled"
  | "regime_confidence"
  | "transition"
  | "chop"
  | "direction_alignment"
  | "btc_filter"
  | "signal_score"
  | "entry_timing"
  | "fee_gate"
  | "final";

export interface RegimeSlice {
  type: RegimeType;
  /** 0–100 composite trend strength */
  strength: number;
  /** 0–100 — used for gates (not cosmetic) */
  confidence: number;
  raw: {
    adx: number;
    atrRatio: number;
    emaSlope: number;
    price: number;
    ema: number;
  };
}

export interface MarketDecisionEngineConfig {
  /** Master: when false, engine is a no-op (legacy behavior). */
  enabled: boolean;
  /** Regime + stability */
  regimeFilterEnabled: boolean;
  adxStrong: number;
  adxWeak: number;
  emaLength: number;
  atrVolThreshold: number;
  stabilityLookback: number;
  stabilityMinAgree: number;
  transitionBlockEnabled: boolean;
  transitionLookback: number;
  /** Confidence: if below min, apply penalty or block */
  minRegimeConfidence: number;
  confidenceMode: "BLOCK" | "PENALTY";
  confidencePenalty: number;
  /** Chop */
  chopEnabled: boolean;
  chopAdxEnabled: boolean;
  chopRangeEnabled: boolean;
  chopFlipEnabled: boolean;
  chopRangeThreshold: number;
  chopMaxFlips: number;
  /** When true, chop detection hard-blocks; when false, only score penalty applies. */
  chopHardBlock: boolean;
  /** Direction vs regime */
  directionMismatchMode: "BLOCK" | "PENALTY";
  directionMismatchPenalty: number;
  allowSidewaysWithSignal: boolean;
  /** HTF */
  htfEnabled: boolean;
  htfTimeframe: string;
  /** BTC global */
  btcFilterEnabled: boolean;
  btcSymbol: string;
  btcMinAdx: number;
  btcBlockMode: "BLOCK" | "PENALTY";
  /** Subtracted from signal score when BTC filter trips in PENALTY mode */
  btcFilterPenalty: number;
  /** Signal scoring */
  signalQualityEnabled: boolean;
  scoreThreshold: number;
  /** RSI must be ≥ this for BUY (and neutral-side legacy long bias) to earn RSI score weight. */
  scoreRsiLongMin: number;
  /** RSI must be ≤ this for SELL to earn RSI score weight. */
  scoreRsiShortMax: number;
  weightSupertrend: number;
  weightEmaAlign: number;
  weightRsi: number;
  weightHtfMatch: number;
  penaltyChop: number;
  penaltyWeakTrend: number;
  penaltyOverextension: number;
  /** Entry timing */
  entryMode: "INSTANT" | "PULLBACK" | "BREAKOUT";
  pullbackAtrMult: number;
  /** Fee gate */
  feeGateEnabled: boolean;
  /**
   * How “required move %” is computed for the fee gate.
   * - FEE_BUFFER_SLIP: roundTrip×100 + feeBufferPct + slippage bps (legacy).
   * - T02_ACTIVATION: price % from entry to tiered T02 activation (padded fee + activation slip + trail buffer), aligned with Supertrend trailing gates.
   */
  feeGateRequiredMoveBasis: "FEE_BUFFER_SLIP" | "T02_ACTIVATION";
  /**
   * When basis is T02_ACTIVATION: copy fee-BE multiplier, activation slip, and trail buffer from bot trailing settings on each open check (server).
   * If false, use feeGateT02* fields below.
   */
  feeGateT02SyncFromBotTrailing: boolean;
  /** T02 fee-BE multiplier (1 = exact round-trip to lock); used when sync is off or on frontend-only preview. */
  feeGateT02FeeBeMultiplier: number;
  /** Additive on padded fee for T02 activation threshold only (fraction, e.g. 0.0002). */
  feeGateT02ActivationSlippageFrac: number;
  /** Trail activation buffer fraction (T01/T02 gates), same as SUPERTREND_TRAIL_BUFFER_RATE. */
  feeGateT02TrailBufferRate: number;
  feeSlippageBps: number;
  feeBufferPct: number;
  /** Round-trip fee rate (fraction, e.g. 0.0008 for 0.08% leg) — caller supplies from venue */
  defaultRoundTripFeeRate: number;
}

export interface ScoreBreakdownRow {
  id: string;
  label: string;
  value: number;
  weight: number;
  contribution: number;
  note?: string;
}

/** Human-readable pass criteria derived from engine config (for UI brackets). */
export interface MarketDecisionPassThresholds {
  minRegimeConfidence: number;
  /** Pass chop range rule if Range₁₀ ≥ this (fraction of price). */
  chopRangeMin: number | null;
  /** Pass chop ADX rule if ADX ≥ this (when chop ADX enabled). */
  chopAdxMin: number | null;
  /** Pass flip rule if flips ≤ this (when chop flips enabled). */
  chopFlipsMax: number | null;
  signalScoreMin: number | null;
  /** Pullback: ENTER if |price−EMA|/price ≤ this; Breakout: different rule — see entryTimingPassHint. */
  entryDistBand: number | null;
  /** One-line rule for entry timing vs current mode. */
  entryTimingPassHint: string | null;
  feeMinExpectedMovePct: number | null;
  /** Classifier: price ATR ratio above this → VOLATILE. */
  atrVolThreshold: number;
  /** Short note for direction vs regime gate. */
  directionPassHint: string | null;
  /** Snapshot-time RSI score bands (from engine config). */
  scoreRsiLongMin: number | null;
  scoreRsiShortMax: number | null;
}

export interface MarketDecisionSnapshot {
  version: typeof MARKET_DECISION_SCHEMA_VERSION;
  evaluatedAt: string;
  symbol: string;
  timeframe: string;
  signalSide: "BUY" | "SELL" | null;
  verdict: DecisionVerdict;
  /** When true, master switch is off: {@link verdict} is still the hypothetical outcome if enabled; trading is not filtered. */
  engineDisabled?: boolean;
  failedStage: PipelineStageId | null;
  reasons: string[];
  metrics: Record<string, unknown>;
  /** Present when verdict is BLOCK/WAIT with a primary stage: severity + secondary issues for debugging. */
  pipelineDiagnostics?: {
    primaryStage: PipelineStageId | null;
    primarySeverity: "high" | "medium" | "low";
    secondary: Array<{ stage: string; severity: "high" | "medium" | "low"; detail: string }>;
  };
  /** Pass criteria from config at snapshot time (brackets in UI). */
  passThresholds?: MarketDecisionPassThresholds;
  /** Per-parameter ALLOW/BLOCK/WAIT/N_A for chart signal accordion (schema ≥6). */
  stageChecks?: MarketDecisionStageCheck[];
  regime: {
    ltf: RegimeSlice;
    htf: RegimeSlice | null;
    btc: RegimeSlice | null;
    stability: { stable: boolean; label: string; lookback: number; agree: number };
    transition: { detected: boolean; detail?: string };
  };
  chop: { isChoppy: boolean; reasons: string[]; metrics: Record<string, number> };
  alignment: {
    directionVsRegime: "OK" | "MISMATCH" | "N_A";
    blockedOrPenalized: boolean;
  };
  confidenceGate: {
    regimeConfidence: number;
    minRequired: number;
    passed: boolean;
    mode: "BLOCK" | "PENALTY";
  };
  score?: {
    total: number;
    max: number;
    threshold: number;
    passed: boolean;
    breakdown: ScoreBreakdownRow[];
    /** When failed: HTF alignment required but missing vs numeric total below threshold. */
    failKind?: "htf_match" | "below_threshold";
  };
  entryTiming: {
    mode: "INSTANT" | "PULLBACK" | "BREAKOUT";
    recommendation: "ENTER" | "WAIT";
    metrics: Record<string, number>;
    reasons: string[];
  };
  feeGate: {
    enabled: boolean;
    requiredMovePct: number | null;
    expectedMovePct: number | null;
    passed: boolean;
    reasons: string[];
    /** Basis used to compute requiredMovePct for this snapshot. */
    requiredMoveBasis?: "FEE_BUFFER_SLIP" | "T02_ACTIVATION";
  };
}

/** Inputs are pre-computed at signal time so the engine stays O(k) in history length. */
export interface MarketDecisionInput {
  config: MarketDecisionEngineConfig;
  symbol: string;
  timeframe: string;
  evaluatedAtIso: string;
  signalSide: "BUY" | "SELL" | null;
  /** LTF regime slices, oldest-first, length >= 1, last = current bar */
  regimeHistoryLtf: RegimeSlice[];
  regimeHtf: RegimeSlice | null;
  regimeBtc: RegimeSlice | null;
  chop: {
    adx: number;
    /** (max(high)-min(low))/price over short window — caller computes */
    rangeCompression: number;
  };
  scoring: {
    supertrendConfirmed: boolean;
    priceAboveEma: boolean;
    rsi: number;
    htfTrendMatch: boolean;
    overextended: boolean;
    isWeakTrend: boolean;
  };
  entryTiming: {
    price: number;
    ema: number;
    atr: number;
  };
  feeGate: {
    expectedMovePct: number;
    leverage: number;
    roundTripFeeRate: number;
  };
  /**
   * Bar-close metrics for stage-check rows (ATR % vs volatile threshold, chop sub-metrics).
   * Optional for unit tests; server snapshots should populate.
   */
  classifierMetrics?: {
    atrPct: number;
    atrVolThreshold: number;
    adx: number;
    adxStrong: number;
    adxWeak: number;
    rangeCompression: number;
  };
}
