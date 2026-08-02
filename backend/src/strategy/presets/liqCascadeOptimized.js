/**
 * LIQ_CASCADE presets — event-driven liquidation cascade scalping (1m bar-close).
 */

/** Applied when selecting LIQ_CASCADE — clears ST/intel/VP overlays from prior strategies. */
export const LIQ_CASCADE_ACTIVATION_PATCH = {
  supertrendSpotAuto: false,
  supertrendFuturesAuto: false,
  trailingStopLossAuto: false,
  /** ST breakout-confirm deferral applies to all bar-close paths — must stay off for LIQ_CASCADE. */
  supertrendBreakoutConfirm: false,
  intelligenceGateEnabled: false,
  intelligenceGateManualStrategies: false,
  intelligenceGateStrict: false,
  supertrendFuturesAiConfidenceFilter: false,
  signalStrengthGatesTrades: false,
  supertrendMoveQualityGate: false,
  supertrendBigMoveGateEnabled: false,
  supertrendHtf4hEnabled: false,
  supertrendConfirmationGateEnabled: false,
  volumeProfileEnabled: false,
  volumeProfileGatesEnabled: false,
  volumeProfileSoftGates: false,
  intradayVpBrackets: false,
  intradayGateLiquidity: false,
  intradayGateSession: false,
  intradayGateFib: false,
  intradayGateVp: false,
  intradayGateOrderFlow: false,
  intradayGateHtfRegime: false,
  intradayGateInstitutionalSr: false,
  intradayGateSmcIct: false,
  intradaySmcIctMode: false,
  marketDecision: { enabled: false },
};

export const LIQ_CASCADE_BTC_1M = {
  ...LIQ_CASCADE_ACTIVATION_PATCH,
  symbol: "BTCUSDT",
  timeframe: "1m",
  manualStrategy: "LIQ_CASCADE",
  strategyMode: "MANUAL",
  marketMode: "FUTURES",
  futuresLeverage: 10,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 1,
  riskPerTradeUnit: "PCT",
  liqCascadeInterval: "5min",
  liqCascadeZScoreMin: 2.0,
  liqCascadeLookbackBars: 48,
  liqCascadeWindowBars: 3,
  liqCascadeMinDispAtr: 1.0,
  liqCascadeStrongDispAtr: 2.0,
  liqCascadeMinOiDropPct: 0.12,
  liqCascadeOiGateMode: "window",
  liqCascadeOiSource: "binance",
  liqCascadeOiWindowBars: 3,
  liqCascadeConfirmMode: "ladder",
  liqCascadeConfirmLiqBars: 2,
  liqCascadeExhaustionDecay: 0.55,
  liqCascadeDirectionMode: "fade",
  liqCascadeLiqSource: "force_orders",
  liqCascadeMaxTradesPerDay: 8,
  liqCascadeMinBarGap: 2,
  liqCascadeMaxHoldBars: 24,
  /** One trade per cascade cluster — no flip/re-entry churn on same unwind (12×5m = 1h). */
  liqCascadeEventCooldownLiqBars: 12,
  /** Bracket: no R:R floor; TP = 5× ATR (clears ~0.18% round-trip friction). */
  liqCascadeMinRr: 0,
  liqCascadeTpRr: 0,
  liqCascadeTpAtrMult: 5,
  liqCascadeLiveTickEnabled: false,
  intradayLiqPartialTp: false,
  intradayLiqTp1Enabled: false,
  intradayLiqTp2Enabled: true,
  intradayLiqBreakevenAfterPartial: false,
  intradayLiqEntryAtSignalClose: true,
};

export const LIQ_CASCADE_ETH_1M = {
  ...LIQ_CASCADE_BTC_1M,
  symbol: "ETHUSDT",
};

export const LIQ_CASCADE_BNB_1M = {
  ...LIQ_CASCADE_BTC_1M,
  symbol: "BNBUSDT",
  liqCascadeZScoreMin: 1.8,
  liqCascadeMinLiqUsdBar: 30_000,
};

/** Multi-coin — equal budget split across BTC / ETH / BNB (shared cascade params). */
export const LIQ_CASCADE_PORTFOLIO_1M = {
  ...LIQ_CASCADE_BTC_1M,
  symbol: "BTCUSDT",
  universeCustomSymbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
  universeCoinBase: "CUSTOM",
  universeCoinSelectMode: "MULTIPLE",
  multiBudgetSplitMode: "EQUAL",
  multiCoinCapitalSizingActive: true,
  backtestApplyLiveMultiCoinSplit: true,
};

/** Portfolio + live tick executor — paper/testnet unless LIQ_CASCADE_LIVE_ALLOW=1. */
export const LIQ_CASCADE_PORTFOLIO_1M_LIVE_TICK = {
  ...LIQ_CASCADE_PORTFOLIO_1M,
  liqCascadeLiveTickEnabled: true,
};

/**
 * Paper smoke-test knobs — liq $ + forced-side dom + z-score ONLY.
 * OI off, displacement off, confirm ladder bypassed (Tier A @ 0 ATR = bar-close entry).
 * NOT for live capital — verify signal → Activity → order path in paper mode.
 */
export const LIQ_CASCADE_SMOKE_TEST_PATCH = {
  liqCascadeOiGateMode: "off",
  liqCascadeMinOiDropPct: 0,
  liqCascadeMinDispAtr: 0,
  liqCascadeStrongDispAtr: 0,
  liqCascadeConfirmMode: "ladder",
  liqCascadeConfirmLiqBars: 1,
  liqCascadeMinAtrPct: 0.001,
  /** Paper only — disable R:R gate so wide sweep stops still fire orders. */
  liqCascadeMinRr: 0,
  /** Wider TP — must clear ~0.18% round-trip (0.04% fee + 0.05% slip ×2) on typical ATR; 3× was losing on TP hits. */
  liqCascadeTpAtrMult: 5,
  liqCascadeZScoreMin: 1.5,
  liqCascadeMinLiqUsdBar: 25_000,
  liqCascadeMinBarGap: 1,
  liqCascadeMaxTradesPerDay: 12,
  liqCascadeLiveTickEnabled: false,
};

export const LIQ_CASCADE_BTC_1M_SMOKE_TEST = {
  ...LIQ_CASCADE_BTC_1M,
  ...LIQ_CASCADE_SMOKE_TEST_PATCH,
  symbol: "BTCUSDT",
};

export const LIQ_CASCADE_ETH_1M_SMOKE_TEST = {
  ...LIQ_CASCADE_ETH_1M,
  ...LIQ_CASCADE_SMOKE_TEST_PATCH,
  symbol: "ETHUSDT",
};

/** BTC+ETH+BNB paper smoke — same relaxed gates, multi-coin split. */
export const LIQ_CASCADE_PORTFOLIO_1M_SMOKE_TEST = {
  ...LIQ_CASCADE_PORTFOLIO_1M,
  ...LIQ_CASCADE_SMOKE_TEST_PATCH,
  symbol: "BTCUSDT",
};

/**
 * 1-minute liquidation bars (force_orders ticks aggregated to 1m).
 * Entry chart stays 1m; liq z-score / dom gates fire every 1m bar close (~5× vs 5m liq).
 * Wall-clock windows preserved: 15m cascade, ~5m confirm, 1h z lookback.
 */
export const LIQ_CASCADE_LIQ_1MIN_CORE = {
  liqCascadeInterval: "1min",
  liqCascadeLookbackBars: 60,
  liqCascadeWindowBars: 15,
  liqCascadeConfirmLiqBars: 5,
  liqCascadeOiWindowBars: 15,
  liqCascadeMinLiqUsdBar: 10_000,
  liqCascadeZScoreMin: 1.8,
  liqCascadeMinBarGap: 3,
  liqCascadeMaxTradesPerDay: 20,
  liqCascadeMaxHoldBars: 30,
};

/** Research / higher-frequency path — 1m liq bars, production-style gates (not certified). */
export const LIQ_CASCADE_FREQ_1MIN_PATCH = {
  ...LIQ_CASCADE_LIQ_1MIN_CORE,
  liqCascadeMinDispAtr: 0.8,
  liqCascadeStrongDispAtr: 1.6,
};

export const LIQ_CASCADE_BTC_1M_LIQ_1MIN = {
  ...LIQ_CASCADE_BTC_1M,
  ...LIQ_CASCADE_FREQ_1MIN_PATCH,
  symbol: "BTCUSDT",
};

export const LIQ_CASCADE_ETH_1M_LIQ_1MIN = {
  ...LIQ_CASCADE_ETH_1M,
  ...LIQ_CASCADE_FREQ_1MIN_PATCH,
  symbol: "ETHUSDT",
  liqCascadeMinLiqUsdBar: 8_000,
};

export const LIQ_CASCADE_BNB_1M_LIQ_1MIN = {
  ...LIQ_CASCADE_BNB_1M,
  ...LIQ_CASCADE_FREQ_1MIN_PATCH,
  symbol: "BNBUSDT",
  liqCascadeZScoreMin: 1.6,
  liqCascadeMinLiqUsdBar: 6_000,
};

export const LIQ_CASCADE_PORTFOLIO_1M_LIQ_1MIN = {
  ...LIQ_CASCADE_PORTFOLIO_1M,
  ...LIQ_CASCADE_FREQ_1MIN_PATCH,
  symbol: "BTCUSDT",
};

/** Paper smoke on 1m liq bars — path verify only; ~⅕ per-bar liq $ vs 5m smoke. */
export const LIQ_CASCADE_SMOKE_1MIN_PATCH = {
  ...LIQ_CASCADE_LIQ_1MIN_CORE,
  liqCascadeOiGateMode: "off",
  liqCascadeMinOiDropPct: 0,
  liqCascadeMinDispAtr: 0,
  liqCascadeStrongDispAtr: 0,
  liqCascadeConfirmMode: "ladder",
  liqCascadeConfirmLiqBars: 2,
  liqCascadeMinAtrPct: 0.001,
  liqCascadeMinRr: 0,
  liqCascadeTpAtrMult: 5,
  liqCascadeZScoreMin: 1.2,
  liqCascadeMinLiqUsdBar: 5_000,
  liqCascadeMinBarGap: 2,
  liqCascadeMaxTradesPerDay: 24,
  liqCascadeLiveTickEnabled: false,
};

export const LIQ_CASCADE_BTC_1M_SMOKE_1MIN = {
  ...LIQ_CASCADE_BTC_1M,
  ...LIQ_CASCADE_SMOKE_1MIN_PATCH,
  symbol: "BTCUSDT",
};

export const LIQ_CASCADE_ETH_1M_SMOKE_1MIN = {
  ...LIQ_CASCADE_ETH_1M,
  ...LIQ_CASCADE_SMOKE_1MIN_PATCH,
  symbol: "ETHUSDT",
};

export const LIQ_CASCADE_PORTFOLIO_1M_SMOKE_1MIN = {
  ...LIQ_CASCADE_PORTFOLIO_1M,
  ...LIQ_CASCADE_SMOKE_1MIN_PATCH,
  symbol: "BTCUSDT",
};

/** One-change ablation: smoke 1m + cascade quality (min liq $ + displacement). Research only. */
export const LIQ_CASCADE_SMOKE_1MIN_SELECTIVE_PATCH = {
  ...LIQ_CASCADE_SMOKE_1MIN_PATCH,
  liqCascadeMinDispAtr: 0.8,
  liqCascadeStrongDispAtr: 1.6,
  liqCascadeMinLiqUsdBar: 15_000,
};

export const LIQ_CASCADE_BTC_1M_SMOKE_1MIN_SELECTIVE = {
  ...LIQ_CASCADE_BTC_1M,
  ...LIQ_CASCADE_SMOKE_1MIN_SELECTIVE_PATCH,
  symbol: "BTCUSDT",
};

export const LIQ_CASCADE_ETH_1M_SMOKE_1MIN_SELECTIVE = {
  ...LIQ_CASCADE_ETH_1M,
  ...LIQ_CASCADE_SMOKE_1MIN_SELECTIVE_PATCH,
  symbol: "ETHUSDT",
  liqCascadeMinLiqUsdBar: 12_000,
};

export const LIQ_CASCADE_BNB_1M_SMOKE_1MIN_SELECTIVE = {
  ...LIQ_CASCADE_BNB_1M,
  ...LIQ_CASCADE_SMOKE_1MIN_SELECTIVE_PATCH,
  symbol: "BNBUSDT",
  liqCascadeMinLiqUsdBar: 8_000,
};

export const LIQ_CASCADE_PORTFOLIO_1M_SMOKE_1MIN_SELECTIVE = {
  ...LIQ_CASCADE_PORTFOLIO_1M,
  ...LIQ_CASCADE_SMOKE_1MIN_SELECTIVE_PATCH,
  symbol: "BTCUSDT",
};

/** Selective + z≥1.5 — best max-backdata checkpoint (+1.2% / 51h); still sub-30 trades, not certified. */
export const LIQ_CASCADE_SMOKE_1MIN_SELECTIVE_Z15_PATCH = {
  ...LIQ_CASCADE_SMOKE_1MIN_SELECTIVE_PATCH,
  liqCascadeZScoreMin: 1.5,
};

export const LIQ_CASCADE_PORTFOLIO_1M_SMOKE_1MIN_SELECTIVE_Z15 = {
  ...LIQ_CASCADE_PORTFOLIO_1M,
  ...LIQ_CASCADE_SMOKE_1MIN_SELECTIVE_Z15_PATCH,
  symbol: "BTCUSDT",
};

/**
 * Production 1m liq tuned from max-backdata autopsy (research only — NOT certified).
 * Fixes 0-trade root cause: OI off, confirm 2 bars, minRr 0, tp 5× (bracket gate was blocking all confirms).
 */
export const LIQ_CASCADE_PROD_1M_TUNED_PATCH = {
  liqCascadeOiGateMode: "off",
  liqCascadeMinOiDropPct: 0,
  liqCascadeConfirmLiqBars: 2,
  liqCascadeMinRr: 0,
  liqCascadeTpAtrMult: 5,
};

export const LIQ_CASCADE_PORTFOLIO_1M_PROD_TUNED = {
  ...LIQ_CASCADE_PORTFOLIO_1M_LIQ_1MIN,
  ...LIQ_CASCADE_PROD_1M_TUNED_PATCH,
  symbol: "BTCUSDT",
};
