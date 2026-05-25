/**
 * INTRADAY_PRO / SR_INTRADAY — trade-by-trade veto stack + tier-A big-move trail.
 * npm run backtest:intraday-autopsy -- BNBUSDT 15m
 */

export const INTRADAY_PRO_BASE = {
  strategyMode: "MANUAL",
  manualStrategy: "SR_INTRADAY",
  marketMode: "FUTURES",
  supertrendFuturesAuto: false,
  trailingStopLossAuto: false,
  futuresTrailingStopMode: "SUPERTREND",
  supertrendFuturesExitOnFlip: false,
  supertrendHtf4hEnabled: true,
  supertrendHtf4hPeriod: 10,
  supertrendHtf4hMultiplier: 3,
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 2.5,
  riskPerTradeUnit: "PCT",
  slippagePct: 0.0005,
  supertrendFuturesFixedSlPct: 0.0035,
  supertrendFuturesFixedTpPct: 0.01,
  srIntradayMaxTradesPerDay: 5,
  srIntradayMinBarGap: 4,
  srIntradayMinScore: 8,
  srIntradaySessionStartHour: 7,
  srIntradaySessionEndHour: 22,
  intradayMinTechniqueCount: 3,
  intradayRequireSessionReclaim: true,
  intradayRequireFibOrVp: true,
  intradayLearnedRulesEnabled: true,
  intradayBigMoveMinScore: 11,
};

/** Primary: fixed TP scalps with loss vetoes */
export const INTRADAY_PRO_15M = {
  ...INTRADAY_PRO_BASE,
  symbol: "BNBUSDT",
  timeframe: "15m",
};

/** Volume Profile structure gates + HVN/LVN brackets (Way 1–5) */
export const INTRADAY_PRO_VP_15M = {
  ...INTRADAY_PRO_BASE,
  symbol: "BNBUSDT",
  timeframe: "15m",
  volumeProfileEnabled: true,
  volumeProfileSoftGates: true,
  volumeProfileGatesEnabled: false,
  intradayVpBrackets: true,
  intradayLvnSizeMult: 2,
  vpLookbackBars: 672,
  vpMinRR: 1.35,
  vpMinRunPct: 0.003,
  requireVpSetup: false,
  srIntradayMinScore: 9,
};

/** Tier-A only + ST trail for big moves */
export const INTRADAY_PRO_BIGMOVE_15M = {
  ...INTRADAY_PRO_BASE,
  symbol: "BNBUSDT",
  timeframe: "15m",
  intradayTierMode: "A",
  srIntradayMinScore: 10,
  trailingStopLossAuto: true,
  supertrendFuturesExitOnFlip: true,
  supertrendFuturesFixedTpPct: 0,
  supertrendPeriod: 10,
  supertrendMultiplier: 2.5,
  supertrendWilderAtr: true,
  backtestBreakevenAtMfePct: 0.004,
};

export const INTRADAY_PRO_5M = {
  ...INTRADAY_PRO_BASE,
  symbol: "BNBUSDT",
  timeframe: "5m",
  srIntradayMinBarGap: 8,
};

export const SR_INTRADAY_SNIPER_BASE = INTRADAY_PRO_15M;
export const SR_INTRADAY_BNB_15M = INTRADAY_PRO_15M;
export const SR_INTRADAY_BNB_5M = INTRADAY_PRO_5M;
export const SR_INTRADAY_BTC_15M = { ...INTRADAY_PRO_15M, symbol: "BTCUSDT" };
export const SR_INTRADAY_TRAIL_15M = INTRADAY_PRO_BIGMOVE_15M;

export const SR_INTRADAY_RECOMMENDED_TIMEFRAME = "15m";
export const SR_INTRADAY_RECOMMENDED_SYMBOL = "BNBUSDT";
