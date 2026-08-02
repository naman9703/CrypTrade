/**
 * MICRO_EVENT presets for UI / backtest.
 */
export const MICRO_EVENT_ST_OFF = {
  /** Continuation SELL opens shorts — required for live tick executor (not 1-way close-long-only). */
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

export const MICRO_EVENT_1M_BASE = {
  ...MICRO_EVENT_ST_OFF,
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
  ...MICRO_EVENT_1M_BASE,
  symbol: "BTCUSDT",
};

export const MICRO_EVENT_ETH_1M = {
  ...MICRO_EVENT_1M_BASE,
  symbol: "ETHUSDT",
};

export const MICRO_EVENT_BNB_1M = {
  ...MICRO_EVENT_1M_BASE,
  symbol: "BNBUSDT",
};

export const MICRO_EVENT_PORTFOLIO_1M = {
  ...MICRO_EVENT_1M_BASE,
  symbol: "BTCUSDT",
  universeCoinSelectMode: "MULTIPLE",
  universeCustomSymbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
  capitalSplitAcrossCoins: true,
};

export const MICRO_EVENT_BTC_1M_LIQ_ONLY = {
  ...MICRO_EVENT_BTC_1M,
  microEventMinConfirmLayers: 0,
  microEventMinConfluenceScore: 20,
  microEventOiGateEnabled: false,
  microEventBookGateEnabled: false,
  microEventCvdGateEnabled: false,
  microEventFundingGateEnabled: false,
  microEventMacroGateEnabled: false,
};
