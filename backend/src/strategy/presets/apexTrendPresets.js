/**
 * APEX_TREND v2 presets — ST locked 7/2.5 inside apexTrend.js; strict RSI 40–52 entry zone.
 * Best validated on this stack: HTF_RSI v3 + BNBUSDT 15m (~50% WR, ~125–191% return).
 */

const BASE = {
  strategyMode: "MANUAL",
  manualStrategy: "APEX_TREND",
  marketMode: "FUTURES",
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTradeUnit: "PCT_EQUITY",
  trailingStopLossAuto: false,
  supertrendMoveQualityGate: false,
  signalStrengthGatesTrades: false,
  slippagePct: 0.0005,
  tradeHistoryTakerOpenFeeRate: 0.0004,
  tradeHistoryTakerCloseFeeRate: 0.0004,
  apexAdxMin: 22,
  apexHtf1hSep: 0.0012,
  apexHtf4hSep: 0.0008,
  apexFlipOnly: true,
};

export const APEX_TREND_15M_BALANCED = {
  ...BASE,
  futuresLeverage: 25,
  riskPerTrade: 5,
  supertrendFuturesFixedSlPct: 0.006,
  supertrendFuturesFixedTpPct: 0.018,
};

export const APEX_TREND_15M_MAX = {
  ...BASE,
  futuresLeverage: 25,
  riskPerTrade: 7,
  supertrendFuturesFixedSlPct: 0.006,
  supertrendFuturesFixedTpPct: 0.021,
};

export const APEX_TREND_BTC_15M = {
  ...BASE,
  futuresLeverage: 20,
  riskPerTrade: 5,
  supertrendFuturesFixedSlPct: 0.008,
  supertrendFuturesFixedTpPct: 0.024,
};

export const APEX_TREND_1H = {
  ...BASE,
  futuresLeverage: 15,
  riskPerTrade: 5,
  supertrendFuturesFixedSlPct: 0.012,
  supertrendFuturesFixedTpPct: 0.036,
};

export const APEX_TREND_RECOMMENDED_SYMBOL = "BNBUSDT";
export const APEX_TREND_RECOMMENDED_TIMEFRAME = "15m";
