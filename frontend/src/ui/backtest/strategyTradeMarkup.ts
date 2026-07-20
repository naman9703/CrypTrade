/**
 * Strategy-specific trade chart markup router.
 * SMC/ICT first; other strategies can plug in here without touching the chart component.
 */
import type { BacktestRunSummary, BacktestTrade } from "../../types/backtest";
import { profileChartMarkup } from "../../lib/strategyConfigProfile.ts";
import {
  hasSmcTradeContext,
  isFibRun,
  isLiquidityRun,
  isSmcIctRun,
  manualStrategyFromRun,
  type BacktestLiqContext,
} from "./backtestChartOverlays";
import {
  buildLiquidityChartMarkup,
  buildSmcChartMarkup,
  smcMarkupToChartLayers,
  type SmcChartLayers,
  type SmcChartMarkup,
} from "./smcChartMarkup";
import type { OhlcCandle, TradeChartTiming } from "./backtestChartTime";

export type StrategyMarkupKind = "smc_ict" | "liquidity" | "fib" | "none";

export function resolveStrategyMarkupKind(
  run: BacktestRunSummary | null,
  trade: BacktestTrade | null,
): StrategyMarkupKind {
  if (!trade) return "none";
  if (hasSmcTradeContext(run, trade)) return "smc_ict";
  const manual = manualStrategyFromRun(run);
  const markup = profileChartMarkup(manual);
  if (markup === "liquidity" && isLiquidityRun(run) && trade.liqContext) return "liquidity";
  if (markup === "fib" && isFibRun(run)) return "fib";
  if (markup === "smc_ict" && isSmcIctRun(run)) return "smc_ict";
  return "none";
}

export function buildStrategyTradeMarkup(
  candles: OhlcCandle[],
  trade: BacktestTrade,
  run: BacktestRunSummary | null,
  botOpts: Record<string, unknown> = {},
  chartTf?: string,
): SmcChartMarkup | null {
  const kind = resolveStrategyMarkupKind(run, trade);
  const timing: TradeChartTiming | undefined =
    chartTf && run?.timeframe
      ? { chartTf, runTimeframe: run.timeframe, engineType: run.engineType }
      : undefined;
  if (kind === "smc_ict" || (kind === "liquidity" && (trade.liqContext as BacktestLiqContext)?.smcMeta)) {
    return buildSmcChartMarkup(candles, trade, botOpts, timing);
  }
  if (kind === "liquidity") {
    return buildLiquidityChartMarkup(candles, trade, botOpts, timing);
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
