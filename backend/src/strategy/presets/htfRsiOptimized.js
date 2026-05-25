/**
 * HTF_RSI v3 presets — BNBUSDT 15m (Jan 1 – May 18 2026), realistic engine:
 * RISK_AT_SL, 0.05% slippage, OHLC-clamped fills. Strategy v3: HTF sep ≥ 0.12%.
 *
 * Do NOT use on BTC or 5m. Do NOT use FULL_EQUITY_MARGIN for research.
 */

/** ~125% return, 50% WR, 24 trades — conservative risk */
export const HTF_RSI_BALANCED_PRESET = {
  strategyMode: "MANUAL",
  manualStrategy: "HTF_RSI",
  marketMode: "FUTURES",
  futuresLeverage: 25,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 5,
  riskPerTradeUnit: "PCT_EQUITY",
  supertrendFuturesFixedSlPct: 0.006,
  supertrendFuturesFixedTpPct: 0.018,
  trailingStopLossAuto: false,
  supertrendMoveQualityGate: false,
  signalStrengthGatesTrades: false,
  slippagePct: 0.0005,
  tradeHistoryTakerOpenFeeRate: 0.0004,
  tradeHistoryTakerCloseFeeRate: 0.0004,
};

/** ~157% return, 50% WR, 24 trades — recommended balance of return + WR */
export const HTF_RSI_MAX_RETURN_PRESET = {
  ...HTF_RSI_BALANCED_PRESET,
  riskPerTrade: 6,
};

/** ~191% return, 50% WR, 24 trades — max validated return (BNB 15m only) */
export const HTF_RSI_AGGRESSIVE_PRESET = {
  ...HTF_RSI_BALANCED_PRESET,
  riskPerTrade: 7,
};

/** @deprecated v2 label — use HTF_RSI_MAX_RETURN_PRESET */
export const HTF_RSI_V2_MAX_RETURN_PRESET = {
  ...HTF_RSI_BALANCED_PRESET,
  riskPerTrade: 5,
};

export const HTF_RSI_RECOMMENDED_TIMEFRAME = "15m";
export const HTF_RSI_RECOMMENDED_SYMBOL = "BNBUSDT";
