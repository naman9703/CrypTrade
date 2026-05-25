/** BNB 15m Trend+HTF_ST presets — keep in sync with backend/src/strategy/presets/trendHtfStOptimized.js */

export const TREND_HTF_ST_BASE = {
  strategyMode: "MANUAL" as const,
  manualStrategy: "TREND_HTF_ST",
  marketMode: "FUTURES" as const,
  symbol: "BNBUSDT",
  timeframe: "15m",
  trailingStopLossAuto: false,
  futuresLeverage: 30,
  riskPerTrade: 10,
  riskPerTradeUnit: "PCT" as const,
  supertrendPeriod: 10,
  supertrendMultiplier: 2.5,
  supertrendFuturesFixedSlPct: 0.012,
  supertrendFuturesFixedTpPct: 0.03,
  trendHtfStMaxEntryRangeAtr: 2,
  trendHtfStQualityFilter: false,
  trendHtfStFlipExitBeforeSl: false,
};

export const TREND_HTF_ST_BNB_MAX_RETURN = {
  ...TREND_HTF_ST_BASE,
  trendHtfStRegimeGate: false,
  trendHtfStSurgicalLossFilter: false,
};

export const TREND_HTF_ST_BNB_SURGICAL = {
  ...TREND_HTF_ST_BASE,
  trendHtfStRegimeGate: false,
  trendHtfStSurgicalLossFilter: true,
};

export const TREND_HTF_ST_BNB_CHOP_SAFE = {
  ...TREND_HTF_ST_BASE,
  trendHtfStRegimeGate: true,
  trendHtfStSurgicalLossFilter: false,
  trendHtfStRegimeTpChop: 0.04,
};

/** ★ Best tested BNB — Jan ~61% WR, ~840% ret. Intel gate OFF. */
export const TREND_HTF_ST_OPTIMAL_BNB = {
  ...TREND_HTF_ST_BNB_MAX_RETURN,
  supertrendFuturesAuto: false,
  supertrendSpotAuto: false,
  intelligenceGateEnabled: false,
};

/** Best tested BTC — Jan ~42% WR. Prefer BNB for this strategy. */
export const TREND_HTF_ST_OPTIMAL_BTC = {
  ...TREND_HTF_ST_BASE,
  symbol: "BTCUSDT",
  supertrendFuturesAuto: false,
  supertrendSpotAuto: false,
  intelligenceGateEnabled: false,
  trendHtfStSurgicalLossFilter: true,
  futuresLeverage: 20,
  riskPerTrade: 10,
};

/** ~50% WR Jan, fewer chop losses (surgical + breakeven@1.5% MFE). */
export const TREND_HTF_ST_BNB_HIGH_WR = {
  ...TREND_HTF_ST_BNB_SURGICAL,
  supertrendFuturesAuto: false,
  backtestBreakevenAtMfePct: 0.015,
  intelligenceGateEnabled: false,
};
