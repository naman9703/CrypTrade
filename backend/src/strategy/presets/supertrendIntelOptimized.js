/**
 * Supertrend + Intelligence gate — production preset (strict gate, trailing, move-quality).
 * Backtest with: node scripts/backtest-st-intel-sweep.mjs --symbol BNBUSDT
 */
export const SUPERTREND_INTEL_OPTIMIZED_PRESET = {
  strategyMode: "MANUAL",
  manualStrategy: "SUPERTREND",
  supertrendFuturesAuto: true,
  supertrendWilderAtr: true,
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  intelligenceGateEnabled: true,
  intelligenceGateStrict: false,
  supertrendMoveQualityGate: false,
  supertrendBreakoutConfirm: false,
  supertrendBreakoutMaxBars: 3,
  /** Hold through ST flips — exit on SL/trail/TP only (cuts whipsaw losses). */
  supertrendFuturesExitOnFlip: false,
  supertrendFuturesFixedSlPct: 0.006,
  supertrendFuturesFixedTpPct: 0,
  trailingStopLossAuto: true,
  futuresTrailingStopMode: "SUPERTREND",
  futuresTrailingStFeeBreakeven: true,
  futuresTrailingStAdvanced: true,
  trailBufferMode: "ATR",
  trailBufferAtrMult: 1.5,
  trailPostT02SpacingFrac: 0.003,
  trailPostT02ActivationBufferRate: 0.003,
  trailMinSlDistFrac: 0.002,
  futuresLeverage: 10,
  riskPerTrade: 5,
  riskPerTradeUnit: "PCT",
  signalStrengthGatesTrades: false,
  marketDecision: { enabled: false },
};
