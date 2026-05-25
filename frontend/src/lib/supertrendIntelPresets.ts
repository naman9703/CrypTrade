import type { BotConfigPatch } from "../api/client";

/**
 * Validated ~87% WR / ~+18% return BNB 15m Jan–May 2026 (not 1000%+ — see supertrendIntel80Wr.js).
 * Intel gate + tight TP 0.7% / SL 1.5%, no trail, no flip exit.
 */
export const SUPERTREND_INTEL_80WR: BotConfigPatch = {
  strategyMode: "MANUAL",
  manualStrategy: "SUPERTREND",
  supertrendFuturesAuto: true,
  supertrendSpotAuto: false,
  supertrendWilderAtr: true,
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  intelligenceGateEnabled: true,
  intelligenceGateStrict: false,
  intelligenceGateHighWinRate: false,
  supertrendConfirmationGateEnabled: false,
  supertrendFuturesExitOnFlip: false,
  trailingStopLossAuto: false,
  supertrendFuturesFixedSlPct: 0.015,
  supertrendFuturesFixedTpPct: 0.007,
  futuresLeverage: 10,
  riskPerTrade: 5,
  riskPerTradeUnit: "PCT",
};

/** MANUAL Supertrend + Intelligence gate + Trailing (sync with backend presets/supertrendIntelTrail.js). */
export const SUPERTREND_INTEL_TRAIL: BotConfigPatch = {
  strategyMode: "MANUAL",
  manualStrategy: "SUPERTREND",
  supertrendFuturesAuto: true,
  supertrendSpotAuto: false,
  supertrendWilderAtr: true,
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  intelligenceGateEnabled: true,
  intelligenceGateStrict: false,
  intelligenceGateHighWinRate: true,
  trailingStopLossAuto: true,
  futuresTrailingStopMode: "SUPERTREND",
  futuresTrailingStFeeBreakeven: true,
  futuresTrailingStAdvanced: true,
  trailBufferMode: "ATR",
  trailBufferAtrMult: 1.5,
  supertrendFuturesExitOnFlip: true,
  supertrendFuturesFixedSlPct: 0.008,
  supertrendFuturesFixedTpPct: 0,
  futuresLeverage: 10,
  riskPerTrade: 5,
  riskPerTradeUnit: "PCT",
  supertrendMoveQualityGate: false,
  supertrendBreakoutConfirm: false,
};
