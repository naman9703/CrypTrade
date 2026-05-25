/**
 * TREND_HTF_ST — BNB 15m presets (matches user high-return backtest profile).
 *
 * MAX: 10% risk, 30x, TP 3%, regime OFF — full trade count, ~800%+ Jan compounding.
 * SURGICAL: same sizing + loss-only entry filter (blocks cross/sideways-triple, not half the book).
 */

export const TREND_HTF_ST_FLIP_PRESET = {
  strategyMode: "MANUAL",
  manualStrategy: "TREND_HTF_ST",
  marketMode: "FUTURES",
  symbol: "BNBUSDT",
  timeframe: "15m",
  futuresLeverage: 30,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 10,
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

/** User max-return profile — do not enable full regime gate on this. */
export const TREND_HTF_ST_BNB_MAX_PRESET = {
  ...TREND_HTF_ST_FLIP_PRESET,
};

/** Block only loss-correlated entries; keeps ~same trade count as MAX. */
export const TREND_HTF_ST_BNB_SURGICAL_PRESET = {
  ...TREND_HTF_ST_BNB_MAX_PRESET,
  trendHtfStSurgicalLossFilter: true,
};

/** Full regime gate — cuts trades ~50%, lowers Jan return. Use only for H2 protection. */
export const TREND_HTF_ST_BNB_CHOP_SAFE_PRESET = {
  ...TREND_HTF_ST_BNB_MAX_PRESET,
  trendHtfStRegimeGate: true,
  trendHtfStRegimeTpTrend: 0.03,
  trendHtfStRegimeTpMixed: 0.035,
  trendHtfStRegimeTpChop: 0.04,
};

/** Convert whipsaw losses (MFE≥1% then SL) to breakeven — exit-side fix, not entry cut. */
export const TREND_HTF_ST_BNB_WHIPSAW_GUARD_PRESET = {
  ...TREND_HTF_ST_BNB_MAX_PRESET,
  backtestBreakevenAtMfePct: 0.01,
};

export const TREND_HTF_ST_BNB_AGGRESSIVE_PRESET = {
  ...TREND_HTF_ST_BNB_MAX_PRESET,
  riskPerTrade: 20,
};

export const TREND_HTF_ST_TRAIL_PRESET = TREND_HTF_ST_FLIP_PRESET;
export const TREND_HTF_ST_RECOMMENDED_TIMEFRAME = "15m";
export const TREND_HTF_ST_RECOMMENDED_SYMBOL = "BNBUSDT";

/**
 * Research-backed optimal (May 2026 sweep). BNB 15m only for 80%+ WR target — use this preset.
 * Jan 2026: ~61% WR, ~840% return, 28 trades. Full year still weak on H2 chop — pair with surgical for H2.
 * Intelligence gate OFF (gate blocks compounding). supertrendFuturesAuto OFF so engine = TREND_HTF_ST.
 */
export const TREND_HTF_ST_OPTIMAL_BNB_PRESET = {
  ...TREND_HTF_ST_BNB_MAX_PRESET,
  strategyMode: "MANUAL",
  manualStrategy: "TREND_HTF_ST",
  supertrendFuturesAuto: false,
  supertrendSpotAuto: false,
  intelligenceGateEnabled: false,
  intelligenceGateStrict: false,
  symbol: "BNBUSDT",
  timeframe: "15m",
};

/** Best tested on BTCUSDT 15m (lower WR than BNB). Jan 2026: ~42% WR, ~74% return. */
export const TREND_HTF_ST_OPTIMAL_BTC_PRESET = {
  ...TREND_HTF_ST_BNB_MAX_PRESET,
  strategyMode: "MANUAL",
  manualStrategy: "TREND_HTF_ST",
  supertrendFuturesAuto: false,
  supertrendSpotAuto: false,
  intelligenceGateEnabled: false,
  trendHtfStSurgicalLossFilter: true,
  symbol: "BTCUSDT",
  timeframe: "15m",
  futuresLeverage: 20,
  riskPerTrade: 10,
};

/** Higher selectivity: ~50% WR Jan, ~400% return, 26 trades (surgical + BE@1.5% MFE). */
export const TREND_HTF_ST_BNB_HIGH_WR_PRESET = {
  ...TREND_HTF_ST_BNB_SURGICAL_PRESET,
  strategyMode: "MANUAL",
  manualStrategy: "TREND_HTF_ST",
  supertrendFuturesAuto: false,
  backtestBreakevenAtMfePct: 0.015,
  intelligenceGateEnabled: false,
};
