/**
 * Strategy-specific trade chart markup router.
 * SMC/ICT first; other strategies can plug in here without touching the chart component.
 */
import type { BacktestRunSummary, BacktestTrade } from "../../types/backtest";
import {
  hasSmcTradeContext,
  isFibRun,
  isLiquidityRun,
  isSmcIctRun,
  type BacktestLiqContext,
} from "./backtestChartOverlays";
import { buildSmcChartMarkup, smcMarkupToChartLayers, type SmcChartLayers, type SmcChartMarkup } from "./smcChartMarkup";
import type { OhlcCandle } from "./backtestChartTime";

export type StrategyMarkupKind = "smc_ict" | "liquidity" | "fib" | "none";

export function resolveStrategyMarkupKind(
  run: BacktestRunSummary | null,
  trade: BacktestTrade | null,
): StrategyMarkupKind {
  if (!trade) return "none";
  if (hasSmcTradeContext(run, trade)) return "smc_ict";
  if (isLiquidityRun(run) && trade.liqContext) return "liquidity";
  if (isFibRun(run)) return "fib";
  if (isSmcIctRun(run)) return "smc_ict";
  return "none";
}

export function buildStrategyTradeMarkup(
  candles: OhlcCandle[],
  trade: BacktestTrade,
  run: BacktestRunSummary | null,
  botOpts: Record<string, unknown> = {},
): SmcChartMarkup | null {
  const kind = resolveStrategyMarkupKind(run, trade);
  if (kind === "smc_ict" || (kind === "liquidity" && (trade.liqContext as BacktestLiqContext)?.smcMeta)) {
    return buildSmcChartMarkup(candles, trade, botOpts);
  }
  return null;
}

export function strategyMarkupToLayers(
  markup: SmcChartMarkup | null,
  chartTimesSec: number[],
): SmcChartLayers | null {
  if (!markup) return null;
  return smcMarkupToChartLayers(markup, chartTimesSec);
}
