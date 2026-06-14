/**
 * TREND_HTF_ST — BNBUSDT 15m presets.
 * Signal: 1h EMA21/50 trend + 15m Supertrend flip (wall-clock hourly agg).
 * Regime gate is opt-in (`trendHtfStRegimeGate: true`); default OFF for trade count.
 *
 * Validated Jun 2026 (BNB 15m, RISK_AT_SL, trail off, realistic fees):
 *   SURGICAL 3% + BE@1% → ~+20% Jan–May 2026, ~35% WR
 *   MAX 10% risk → negative (over-bets ~35% WR)
 */

export const TREND_HTF_ST_FLIP_PRESET = {
  strategyMode: "MANUAL",
  manualStrategy: "TREND_HTF_ST",
  marketMode: "FUTURES",
  symbol: "BNBUSDT",
  timeframe: "15m",
  futuresLeverage: 10,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 3,
  riskPerTradeUnit: "PCT_EQUITY",
  supertrendPeriod: 10,
  supertrendMultiplier: 2.5,
  supertrendWilderAtr: true,
  supertrendFuturesFixedSlPct: 0.012,
  supertrendFuturesFixedTpPct: 0.03,
  trailingStopLossAuto: false,
  trendHtfStMaxEntryRangeAtr: 2,
  trendHtfStQualityFilter: false,
  trendHtfStRegimeGate: false,
  trendHtfStSurgicalLossFilter: false,
  trendHtfStFlipExitBeforeSl: false,
  slippagePct: 0.0005,
  tradeHistoryTakerOpenFeeRate: 0.0005,
  tradeHistoryTakerCloseFeeRate: 0.0005,
};

/** Recommended — surgical filter + modest risk + whipsaw BE */
export const TREND_HTF_ST_BNB_BALANCED_PRESET = {
  ...TREND_HTF_ST_FLIP_PRESET,
  trendHtfStSurgicalLossFilter: true,
  backtestBreakevenAtMfePct: 0.01,
  riskPerTrade: 3,
  futuresLeverage: 10,
};

/** Higher trade count, no surgical filter — use ≤3% risk only */
export const TREND_HTF_ST_BNB_MAX_PRESET = {
  ...TREND_HTF_ST_FLIP_PRESET,
};

/** Block loss-correlated entries in H2 chop (keeps most Jan trend trades) */
export const TREND_HTF_ST_BNB_SURGICAL_PRESET = {
  ...TREND_HTF_ST_BNB_MAX_PRESET,
  trendHtfStSurgicalLossFilter: true,
};

/** Full regime gate — opt-in only; cuts trade count heavily */
export const TREND_HTF_ST_BNB_CHOP_SAFE_PRESET = {
  ...TREND_HTF_ST_BNB_MAX_PRESET,
  trendHtfStRegimeGate: true,
  trendHtfStRegimeTpTrend: 0.03,
  trendHtfStRegimeTpMixed: 0.035,
  trendHtfStRegimeTpChop: 0.04,
};

export const TREND_HTF_ST_BNB_WHIPSAW_GUARD_PRESET = {
  ...TREND_HTF_ST_BNB_MAX_PRESET,
  backtestBreakevenAtMfePct: 0.01,
};

/** Research only — 10% risk turns Jan edge negative at ~35% WR */
export const TREND_HTF_ST_BNB_AGGRESSIVE_PRESET = {
  ...TREND_HTF_ST_BNB_MAX_PRESET,
  riskPerTrade: 10,
  futuresLeverage: 30,
};

export const TREND_HTF_ST_TRAIL_PRESET = TREND_HTF_ST_FLIP_PRESET;
export const TREND_HTF_ST_RECOMMENDED_TIMEFRAME = "15m";
export const TREND_HTF_ST_RECOMMENDED_SYMBOL = "BNBUSDT";

export const TREND_HTF_ST_OPTIMAL_BNB_PRESET = {
  ...TREND_HTF_ST_BNB_BALANCED_PRESET,
  supertrendFuturesAuto: false,
  supertrendSpotAuto: false,
  intelligenceGateEnabled: false,
  intelligenceGateStrict: false,
};

export const TREND_HTF_ST_OPTIMAL_BTC_PRESET = {
  ...TREND_HTF_ST_BNB_SURGICAL_PRESET,
  supertrendFuturesAuto: false,
  supertrendSpotAuto: false,
  intelligenceGateEnabled: false,
  symbol: "BTCUSDT",
  timeframe: "15m",
  futuresLeverage: 20,
  riskPerTrade: 3,
};

export const TREND_HTF_ST_BNB_HIGH_WR_PRESET = {
  ...TREND_HTF_ST_BNB_BALANCED_PRESET,
  backtestBreakevenAtMfePct: 0.015,
};
