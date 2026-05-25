/**
 * MANUAL Supertrend + Intelligence gate + Trailing — user-requested stack.
 * Keep risk modest: 20%+ at 50× on BTC 1yr produced ~-99% (SL compounding).
 */
export const SUPERTREND_INTEL_TRAIL_PRESET = {
  strategyMode: "MANUAL",
  manualStrategy: "SUPERTREND",
  supertrendFuturesAuto: true,
  supertrendSpotAuto: false,
  supertrendWilderAtr: true,
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  intelligenceGateEnabled: true,
  intelligenceGateStrict: false,
  /** Stricter replay bands — best BNB Jan–May 2026 WR (~60% at 5 trades; enable for manual backtests). */
  intelligenceGateHighWinRate: true,
  trailingStopLossAuto: true,
  futuresTrailingStopMode: "SUPERTREND",
  futuresTrailingStFeeBreakeven: true,
  futuresTrailingStAdvanced: true,
  trailBufferMode: "ATR",
  trailBufferAtrMult: 1.5,
  trailPostT02SpacingFrac: 0.003,
  trailPostT02ActivationBufferRate: 0.003,
  /**
   * Exit on opposite ST flip — required for positive WR with trail on BNB 15m (hold-only = 0% WR in replay).
   * Set false only if you accept SL-only exits until trail tiers activate.
   */
  supertrendFuturesExitOnFlip: true,
  /** 0.8% SL + trail — validated best WR on BNB Jan–May 2026 with intel gate (no fixed TP). */
  supertrendFuturesFixedSlPct: 0.008,
  supertrendFuturesFixedTpPct: 0,
  futuresLeverage: 10,
  riskPerTrade: 5,
  riskPerTradeUnit: "PCT",
  backtestPositionSizing: "RISK_AT_SL",
  supertrendMoveQualityGate: false,
  supertrendBreakoutConfirm: false,
  marketDecision: { enabled: false },
  signalStrengthGatesTrades: false,
};
