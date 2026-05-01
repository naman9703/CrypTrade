/** Phase 4 — aggregated metrics per `strategy_versions.id` (API camelCase). */

export interface StrategyPerformance {
  strategyVersionId: string;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRatePct: number;
  totalPnlUsdt: number;
  avgWinUsdt: number | null;
  avgLossUsdt: number | null;
  profitFactor: number | null;
  maxDrawdownUsdt: number | null;
  maxDrawdownPct: number | null;
  sharpeRatio: number | null;
  avgHoldSec: number | null;
  avgRoiPct: number | null;
  rrRatio: number | null;
  lastCalculatedAt: string | null;
}

export interface EquityCurvePoint {
  closedAt: string;
  netPnl: number;
  runningEquity: number;
  drawdownPct: number;
  exitReason: string | null;
  symbol: string;
  direction: "LONG" | "SHORT";
}

/** Closed-trade window stats from `GET /api/analytics/strategy-edge`. */
export interface StrategyEdgeMetrics {
  scope?: string;
  strategyVersionId?: string;
  windowDays?: number;
  tradeCount: number;
  winRatePct: number | null;
  expectancyUsdt: number | null;
  profitFactor: number | null;
  avgWinUsdt: number | null;
  avgLossUsdt: number | null;
  netPnlUsdt: number;
  buckets?: Record<string, unknown>;
}

export interface PerformanceCompareRow {
  strategyId: string;
  strategyName: string;
  versionId: string;
  versionNumber: number;
  label: string | null;
  metrics: StrategyPerformance | null;
}

export interface VersionPerformanceRow {
  versionId: string;
  versionNumber: number;
  label: string | null;
  metrics: StrategyPerformance | null;
}
