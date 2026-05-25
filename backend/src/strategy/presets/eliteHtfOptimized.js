/**
 * ELITE_HTF — BNB 15m production preset.
 * HTF RSI pullbacks + macro regime gate + sep-rising filter.
 */

export const ELITE_HTF_BNB_PRESET = {
  strategyMode: "MANUAL",
  manualStrategy: "ELITE_HTF",
  marketMode: "FUTURES",
  symbol: "BNBUSDT",
  timeframe: "15m",
  futuresLeverage: 25,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 7,
  riskPerTradeUnit: "PCT_EQUITY",
  supertrendFuturesFixedSlPct: 0.012,
  supertrendFuturesFixedTpPct: 0.03,
  trendHtfStRegimeGate: true,
  trendHtfStRegimeTpTrend: 0.025,
  trendHtfStRegimeTpMixed: 0.03,
  trendHtfStRegimeTpChop: 0.035,
  eliteTrendOkOnly: false,
  eliteSkipChopSeason: false,
  trailingStopLossAuto: false,
  slippagePct: 0.0005,
  tradeHistoryTakerOpenFeeRate: 0.0004,
  tradeHistoryTakerCloseFeeRate: 0.0004,
};
