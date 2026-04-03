/**
 * Structured reminders for ongoing strategy validation (no performance guarantees).
 */
export function getTradingEvaluationChecklist({ mode, bot } = {}) {
  return {
    ok: true,
    disclaimer:
      "Backtest / demo metrics do not guarantee live profitability. Validate with small size, fees, and slippage.",
    mode: mode || null,
    suggestedWorkflow: [
      {
        step: 1,
        title: "Reproduce in demo first",
        detail: "Run BINANCE_DEMO_API + futures demo; confirm fills, income, and daily limits behave as expected.",
      },
      {
        step: 2,
        title: "Walk-forward or rolling validation",
        detail: "Retrain / score on older data, validate on a future window; watch for drift (AI health compatible + calibration).",
      },
      {
        step: 3,
        title: "Track by venue",
        detail: "For hybrid spot+futures, use per-venue daily PnL in Portfolio; stop if either leg breaches max daily loss.",
      },
      {
        step: 4,
        title: "Costs and execution",
        detail: "Compare net PnL after fees; futures bracket orders should match exchange margin and liquidation rules.",
      },
      {
        step: 5,
        title: "Scale slowly",
        detail: "Increase notional only after stable weeks of demo; keep MAX_CONCURRENT_POSITIONS and hourly limits conservative.",
      },
    ],
    references: [
      { label: "Binance Spot Demo API", url: "https://developers.binance.com/docs/binance-spot-api-docs/demo-mode/general-info" },
      { label: "Futures demo REST base", url: "https://demo-fapi.binance.com" },
      { label: "Binance derivatives docs", url: "https://developers.binance.com/docs/derivatives/" },
    ],
    botGuards: bot?.riskGuards || null,
  };
}
