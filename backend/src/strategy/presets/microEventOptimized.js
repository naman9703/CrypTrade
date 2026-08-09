/**
 * MICRO_EVENT presets — tick-first microstructure event scalper (continuation default).
 */

/** Applied when selecting MICRO_EVENT — clears ST/intel/VP overlays from prior strategies. */
export const MICRO_EVENT_ACTIVATION_PATCH = {
  /** Continuation SELL (short) requires 2-way futures — default bot is 1-way (close-long only). */
  supertrendFuturesTwoWay: true,
  supertrendSpotAuto: false,
  supertrendFuturesAuto: false,
  trailingStopLossAuto: false,
  supertrendBreakoutConfirm: false,
  intelligenceGateEnabled: false,
  intelligenceGateManualStrategies: false,
  intelligenceGateStrict: false,
  supertrendFuturesAiConfidenceFilter: false,
  signalStrengthGatesTrades: false,
  supertrendMoveQualityGate: false,
  supertrendBigMoveGateEnabled: false,
  supertrendHtf4hEnabled: false,
  supertrendConfirmationGateEnabled: false,
  volumeProfileEnabled: false,
  volumeProfileGatesEnabled: false,
  volumeProfileSoftGates: false,
  intradayVpBrackets: false,
  intradayGateLiquidity: false,
  intradayGateSession: false,
  intradayGateFib: false,
  intradayGateVp: false,
  intradayGateOrderFlow: false,
  intradayGateHtfRegime: false,
  intradayGateInstitutionalSr: false,
  intradayGateSmcIct: false,
  intradaySmcIctMode: false,
  marketDecision: { enabled: false },
};

const MICRO_EVENT_BASE = {
  ...MICRO_EVENT_ACTIVATION_PATCH,
  timeframe: "1m",
  manualStrategy: "MICRO_EVENT",
  strategyMode: "MANUAL",
  marketMode: "FUTURES",
  futuresLeverage: 10,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 1,
  riskPerTradeUnit: "PCT",
  microEventDirectionMode: "continuation",
  microEventTypesEnabled: ["liq", "oi", "book", "cvd", "funding", "macro"],
  microEventMinConfluenceScore: 55,
  microEventMinConfirmLayers: 2,
  microEventLiqWindowSec: 90,
  microEventLiqZMin: 1.5,
  microEventLiqMinUsd: 25_000,
  microEventLiqDomRatio: 1.2,
  microEventLiqRequired: true,
  microEventOiGateEnabled: true,
  microEventOiMinDropPct1m: 0.3,
  microEventOiMinDropPct5m: 0.8,
  microEventBookGateEnabled: true,
  microEventMinImbalance: 0.62,
  microEventMaxOppositeWallUsd: 500_000,
  microEventCvdGateEnabled: true,
  microEventMinAggressiveUsd: 15_000,
  microEventMinCvdSlope: 5000,
  microEventFundingGateEnabled: true,
  microEventMinFundingZ: 1.2,
  microEventCrowdedSideFilter: "any",
  microEventMacroGateEnabled: true,
  microEventMacroScoreBoost: 15,
  microEventSlBufferPct: 0.0015,
  microEventTpRr: 1.2,
  microEventMaxHoldSec: 180,
  microEventMaxTradesPerHour: 12,
  microEventCooldownSec: 45,
  microEventLiveTickEnabled: true,
  microEventTradeSides: "BOTH",
  intradayLiqMaxHoldBars: 3,
  intradayLiqPartialTp: false,
  intradayLiqTp1Enabled: false,
  intradayLiqTp2Enabled: true,
  intradayLiqBreakevenAfterPartial: false,
  intradayLiqEntryAtSignalClose: false,
};

export const MICRO_EVENT_BTC_1M = {
  ...MICRO_EVENT_BASE,
  symbol: "BTCUSDT",
};

export const MICRO_EVENT_ETH_1M = {
  ...MICRO_EVENT_BASE,
  symbol: "ETHUSDT",
};

export const MICRO_EVENT_BNB_1M = {
  ...MICRO_EVENT_BASE,
  symbol: "BNBUSDT",
};

export const MICRO_EVENT_PORTFOLIO_1M = {
  ...MICRO_EVENT_BASE,
  symbol: "BTCUSDT",
  universeCoinSelectMode: "MULTIPLE",
  universeCustomSymbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
  capitalSplitAcrossCoins: true,
};

/**
 * Liq-only research baseline — mega cascades only.
 * Phase0 + full sim (costs): ≥$2M + fresh-onset + signal-bar displacement.
 * Dead-trade exit: if MFE < 0.2R after 2 bars, compress SL to 0.3R (cut bleed).
 */
export const MICRO_EVENT_BTC_1M_LIQ_ONLY = {
  ...MICRO_EVENT_BTC_1M,
  microEventMinConfirmLayers: 0,
  microEventMinConfluenceScore: 10,
  microEventLiqMinUsd: 2_000_000,
  microEventMaxHoldSec: 600,
  microEventCooldownSec: 900,
  microEventCascadeFreshEnabled: true,
  microEventCascadeQuietSec: 900,
  microEventRequireDisplacement: true,
  microEventMinDisplacementPct: 0.05,
  intradayLiqDeadTradeExitBars: 2,
  intradayLiqDeadTradeMinMfeR: 0.2,
  intradayLiqDeadTradeMaxLossR: 0.3,
  microEventOiGateEnabled: false,
  microEventBookGateEnabled: false,
  microEventCvdGateEnabled: false,
  microEventFundingGateEnabled: false,
  microEventMacroGateEnabled: false,
};

/** Liq + CVD confirm (book/OI/funding/macro off). */
export const MICRO_EVENT_BTC_1M_LIQ_CVD = {
  ...MICRO_EVENT_BTC_1M_LIQ_ONLY,
  microEventMinConfirmLayers: 1,
  microEventMinConfluenceScore: 35,
  microEventCvdGateEnabled: true,
  microEventTypesEnabled: ["liq", "cvd"],
};

/** Liq + CVD + OI confirm. */
export const MICRO_EVENT_BTC_1M_LIQ_CVD_OI = {
  ...MICRO_EVENT_BTC_1M_LIQ_CVD,
  microEventMinConfirmLayers: 1,
  microEventMinConfluenceScore: 40,
  microEventOiGateEnabled: true,
  microEventTypesEnabled: ["liq", "cvd", "oi"],
};
