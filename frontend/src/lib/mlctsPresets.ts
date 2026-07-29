/**
 * MLCTS presets for UI / backtest (research-only).
 */
export const MLCTS_BTC_15M = {
  ...{
    symbol: "BTCUSDT",
    timeframe: "15m",
    manualStrategy: "MLCTS",
    strategyMode: "MANUAL",
    marketMode: "FUTURES",
    futuresLeverage: 10,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: 1,
    riskPerTradeUnit: "PCT",
    mlctsScoreThreshold: 75,
    mlctsMinLayerScore: 50,
    mlctsTargetRr: 2,
    mlctsMaxTradesPerDay: 6,
    mlctsMinBarGap: 3,
    mlctsMaxHoldBars: 32,
    intradayLiqPartialTp: false,
    intradayLiqTp1Enabled: false,
    intradayLiqTp2Enabled: true,
    intradayLiqBreakevenAfterPartial: false,
    intradayLiqEntryAtSignalClose: true,
  },
};
