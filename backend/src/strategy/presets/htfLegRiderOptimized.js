/**
 * HTF_LEG_RIDER — BNBUSDT 15m (Jan–May 2026), realistic engine.
 * Wide SL + large TP / flip exit; do not use tight SUPERTREND trail (chops winners).
 */

export const HTF_LEG_RIDER_PRESET = {
  strategyMode: "MANUAL",
  manualStrategy: "HTF_LEG_RIDER",
  marketMode: "FUTURES",
  futuresLeverage: 25,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 5,
  riskPerTradeUnit: "PCT_EQUITY",
  htfLegRiderLookback: 32,
  supertrendPeriod: 10,
  supertrendMultiplier: 3.5,
  supertrendWilderAtr: true,
  supertrendFuturesFixedSlPct: 0.015,
  supertrendFuturesFixedTpPct: 0.05,
  trailingStopLossAuto: false,
  supertrendMoveQualityGate: false,
  signalStrengthGatesTrades: false,
  slippagePct: 0.0005,
  tradeHistoryTakerOpenFeeRate: 0.0004,
  tradeHistoryTakerCloseFeeRate: 0.0004,
};

export const HTF_LEG_RIDER_RECOMMENDED_TIMEFRAME = "15m";
export const HTF_LEG_RIDER_RECOMMENDED_SYMBOL = "BNBUSDT";
