/**
 * HTF_RSI v4 presets — BNBUSDT 15m only.
 * Tuned Jun 2025–Jun 2026: ~+5% full year @ 1% risk, ~+9% OOS Jan–Jun 2026 (37 trades).
 * Use RISK_AT_SL, trail off, modest risk — not FULL_EQUITY or 7%+ risk.
 */

const HTF_RSI_V4_SIGNAL = {
  htfRsiMinSep: 0.0008,
  htfRsiLongMax: 40,
  htfRsiShortMin: 60,
  htfRsiConfirmMode: "recovery_only",
  htfRsiPullbackMode: "ema21_zone",
  htfRsiSideMode: "both",
  htfRsiRequireHtfSlope: true,
};

const HTF_RSI_V4_EXEC = {
  strategyMode: "MANUAL",
  manualStrategy: "HTF_RSI",
  marketMode: "FUTURES",
  futuresLeverage: 5,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 1,
  riskPerTradeUnit: "PCT_EQUITY",
  supertrendFuturesFixedSlPct: 0.008,
  supertrendFuturesFixedTpPct: 0.025,
  trailingStopLossAuto: false,
  supertrendMoveQualityGate: false,
  signalStrengthGatesTrades: false,
  slippagePct: 0.0005,
  tradeHistoryTakerOpenFeeRate: 0.0004,
  tradeHistoryTakerCloseFeeRate: 0.0004,
};

/** Validated default — 1% risk, SL 0.8% / TP 2.5% */
export const HTF_RSI_BALANCED_PRESET = {
  ...HTF_RSI_V4_EXEC,
  ...HTF_RSI_V4_SIGNAL,
};

/** 2% risk — same signal, higher variance */
export const HTF_RSI_MAX_RETURN_PRESET = {
  ...HTF_RSI_BALANCED_PRESET,
  riskPerTrade: 2,
};

/** 3% risk — research only */
export const HTF_RSI_AGGRESSIVE_PRESET = {
  ...HTF_RSI_BALANCED_PRESET,
  riskPerTrade: 3,
};

/** @deprecated */
export const HTF_RSI_V2_MAX_RETURN_PRESET = {
  ...HTF_RSI_BALANCED_PRESET,
};

export const HTF_RSI_RECOMMENDED_TIMEFRAME = "15m";
export const HTF_RSI_RECOMMENDED_SYMBOL = "BNBUSDT";
