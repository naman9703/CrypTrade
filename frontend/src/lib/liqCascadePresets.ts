/**
 * LIQ_CASCADE presets for UI / backtest.
 */
/** Turn off Supertrend / intel / VP overlays — preset merge is shallow over live bot. */
export const LIQ_CASCADE_ST_OFF = {
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

export const LIQ_CASCADE_1M_BASE = {
  ...LIQ_CASCADE_ST_OFF,
  timeframe: "1m",
  manualStrategy: "LIQ_CASCADE",
  strategyMode: "MANUAL",
  marketMode: "FUTURES",
  futuresLeverage: 10,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 1,
  riskPerTradeUnit: "PCT",
  liqCascadeInterval: "5min",
  liqCascadeZScoreMin: 2.0,
  liqCascadeLookbackBars: 48,
  liqCascadeWindowBars: 3,
  liqCascadeMinDispAtr: 1.0,
  liqCascadeStrongDispAtr: 2.0,
  liqCascadeMinOiDropPct: 0.12,
  liqCascadeOiGateMode: "window",
  liqCascadeOiWindowBars: 3,
  liqCascadeConfirmMode: "ladder",
  liqCascadeConfirmLiqBars: 2,
  liqCascadeExhaustionDecay: 0.55,
  liqCascadeDirectionMode: "fade",
  liqCascadeLiqSource: "force_orders",
  liqCascadeMaxTradesPerDay: 8,
  liqCascadeMinBarGap: 2,
  liqCascadeMaxHoldBars: 24,
  liqCascadeLiveTickEnabled: false,
  intradayLiqPartialTp: false,
  intradayLiqTp1Enabled: false,
  intradayLiqTp2Enabled: true,
  intradayLiqBreakevenAfterPartial: false,
  intradayLiqEntryAtSignalClose: true,
};

export const LIQ_CASCADE_BTC_1M = {
  ...LIQ_CASCADE_1M_BASE,
  symbol: "BTCUSDT",
};

export const LIQ_CASCADE_ETH_1M = {
  ...LIQ_CASCADE_1M_BASE,
  symbol: "ETHUSDT",
};

export const LIQ_CASCADE_BNB_1M = {
  ...LIQ_CASCADE_1M_BASE,
  symbol: "BNBUSDT",
  liqCascadeZScoreMin: 1.8,
  liqCascadeMinLiqUsdBar: 30_000,
};

/** Multi-coin — equal budget split across BTC / ETH / BNB (shared cascade params). */
export const LIQ_CASCADE_PORTFOLIO_1M = {
  ...LIQ_CASCADE_BTC_1M,
  symbol: "BTCUSDT",
  universeCustomSymbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
  universeCoinBase: "CUSTOM",
  universeCoinSelectMode: "MULTIPLE",
  multiBudgetSplitMode: "EQUAL",
  multiCoinCapitalSizingActive: true,
  backtestApplyLiveMultiCoinSplit: true,
};

/** Portfolio + live tick executor — paper/testnet unless LIQ_CASCADE_LIVE_ALLOW=1. */
export const LIQ_CASCADE_PORTFOLIO_1M_LIVE_TICK = {
  ...LIQ_CASCADE_PORTFOLIO_1M,
  liqCascadeLiveTickEnabled: true,
};

/** Live tick executor enabled — paper/testnet only by default. */
export const LIQ_CASCADE_BTC_1M_LIVE_TICK = {
  ...LIQ_CASCADE_BTC_1M,
  liqCascadeLiveTickEnabled: true,
};

/**
 * Paper smoke-test — liq $ + dom + z only (OI/disp/confirm gates off).
 * Use in PAPER mode to verify Activity + order placement; not for live capital.
 */
export const LIQ_CASCADE_SMOKE_TEST_PATCH = {
  liqCascadeOiGateMode: "off",
  liqCascadeMinOiDropPct: 0,
  liqCascadeMinDispAtr: 0,
  liqCascadeStrongDispAtr: 0,
  liqCascadeConfirmMode: "ladder",
  liqCascadeConfirmLiqBars: 1,
  liqCascadeMinAtrPct: 0.001,
  liqCascadeMinRr: 0.5,
  liqCascadeZScoreMin: 1.5,
  liqCascadeMinLiqUsdBar: 25_000,
  liqCascadeMinBarGap: 1,
  liqCascadeMaxTradesPerDay: 12,
  liqCascadeLiveTickEnabled: false,
};

export const LIQ_CASCADE_BTC_1M_SMOKE_TEST = {
  ...LIQ_CASCADE_BTC_1M,
  ...LIQ_CASCADE_SMOKE_TEST_PATCH,
  symbol: "BTCUSDT",
};

export const LIQ_CASCADE_ETH_1M_SMOKE_TEST = {
  ...LIQ_CASCADE_ETH_1M,
  ...LIQ_CASCADE_SMOKE_TEST_PATCH,
  symbol: "ETHUSDT",
};

export const LIQ_CASCADE_PORTFOLIO_1M_SMOKE_TEST = {
  ...LIQ_CASCADE_PORTFOLIO_1M,
  ...LIQ_CASCADE_SMOKE_TEST_PATCH,
  symbol: "BTCUSDT",
};
