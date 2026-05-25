/**
 * BTCUSDT presets — Jan–May 2026 research target (run after DB sync):
 *   npm run backtest:btc
 *
 * Realistic engine: RISK_AT_SL, 0.05% slip, OHLC-clamped bracket fills.
 * HTF_RSI mean-reversion underperforms on BTC; prefer trend consensus / 1h legs.
 *
 * 1000%+ return with 80%+ WR was NOT achieved on realistic BTC backtests in research;
 * these are the best structural candidates until `backtest:btc` confirms on your DB.
 */

/** Trend vote: TREND_HTF_ST + HTF_LEG_RIDER + MOMENTUM (2 of 3) — BTC 1h */
export const BTC_CONSENSUS_1H_PRESET = {
  strategyMode: "MANUAL",
  manualStrategy: "BTC_CONSENSUS",
  marketMode: "FUTURES",
  futuresLeverage: 20,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 5,
  riskPerTradeUnit: "PCT_EQUITY",
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  supertrendWilderAtr: true,
  supertrendFuturesFixedSlPct: 0.01,
  supertrendFuturesFixedTpPct: 0.03,
  trailingStopLossAuto: false,
  supertrendMoveQualityGate: false,
  signalStrengthGatesTrades: false,
  htfLegRiderLookback: 32,
  slippagePct: 0.0005,
  tradeHistoryTakerOpenFeeRate: 0.0004,
  tradeHistoryTakerCloseFeeRate: 0.0004,
};

/** Same consensus, 15m — more trades, tighter brackets */
export const BTC_CONSENSUS_15M_PRESET = {
  ...BTC_CONSENSUS_1H_PRESET,
  supertrendFuturesFixedSlPct: 0.008,
  supertrendFuturesFixedTpPct: 0.024,
};

/** Single-strategy trend leg — wider SL, flip exit (no tight trail) */
export const BTC_TREND_HTF_ST_PRESET = {
  strategyMode: "MANUAL",
  manualStrategy: "TREND_HTF_ST",
  marketMode: "FUTURES",
  futuresLeverage: 20,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 5,
  riskPerTradeUnit: "PCT_EQUITY",
  supertrendPeriod: 10,
  supertrendMultiplier: 3.5,
  supertrendWilderAtr: true,
  supertrendFuturesFixedSlPct: 0.015,
  supertrendFuturesFixedTpPct: 0,
  trailingStopLossAuto: false,
  supertrendMoveQualityGate: false,
  signalStrengthGatesTrades: false,
  slippagePct: 0.0005,
  tradeHistoryTakerOpenFeeRate: 0.0004,
  tradeHistoryTakerCloseFeeRate: 0.0004,
};

/** HTF breakout rider — BTC 1h */
export const BTC_LEG_RIDER_1H_PRESET = {
  strategyMode: "MANUAL",
  manualStrategy: "HTF_LEG_RIDER",
  marketMode: "FUTURES",
  futuresLeverage: 20,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 5,
  riskPerTradeUnit: "PCT_EQUITY",
  htfLegRiderLookback: 40,
  supertrendFuturesFixedSlPct: 0.012,
  supertrendFuturesFixedTpPct: 0.036,
  trailingStopLossAuto: false,
  supertrendMoveQualityGate: false,
  signalStrengthGatesTrades: false,
  slippagePct: 0.0005,
  tradeHistoryTakerOpenFeeRate: 0.0004,
  tradeHistoryTakerCloseFeeRate: 0.0004,
};

export const BTC_RECOMMENDED_TIMEFRAME = "1h";
export const BTC_RECOMMENDED_SYMBOL = "BTCUSDT";
