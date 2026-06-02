/** Shapes returned by /api/backtest/* endpoints. */

export type BacktestRunStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export type BacktestGateMode = "off" | "approx";

export type BacktestRunSummary = {
  id: string;
  strategyVersionId: string | null;
  botInstanceId: string | null;
  label: string | null;
  symbol: string;
  timeframe: string;
  startDate: string;
  endDate: string;
  initialCapital: number;
  finalCapital: number | null;
  engineType: string | null;
  status: BacktestRunStatus;
  progressPct: number;
  totalTrades: number | null;
  winRatePct: number | null;
  totalPnlUsdt: number | null;
  maxDrawdownPct: number | null;
  sharpeRatio: number | null;
  profitFactor: number | null;
  gateMode: BacktestGateMode;
  error: string | null;
  coveragePct: number | null;
  metrics: BacktestMetrics | null;
  costModel: Record<string, unknown> | null;
  configSnapshot: Record<string, unknown> | null;
  instanceOperationalSnapshot: Record<string, unknown> | null;
  configSource: "strategy_only" | "instance_merged" | string;
  createdAt: string;
  /** When the worker marked the run as running (best clock for ETA). */
  startedAt: string | null;
  finishedAt: string | null;
};

export type BacktestMetrics = {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  grossProfit: number;
  grossLoss: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  avgHoldMs: number;
  expectancy: number;
  totalNetPnl: number;
  totalGrossPnl: number;
  totalFees: number;
  totalFunding: number;
  totalSlippage: number;
  maxDrawdownPct: number;
  maxDrawdownDurationMs: number;
  sharpe: number;
  sortino: number;
  finalEquity: number;
  totalReturnPct: number;
  romd: number | null;
  monthlyReturns: Record<string, number>;
  gateReplay?: {
    mode: BacktestGateMode | string;
    evaluated: number;
    pass: number;
    vetoed: number;
    sizeScaled: number;
    noGate: number;
    avgIntelScore: number | null;
  };
  walkForward?: {
    trainPct: number;
    splitTs: number;
    train: BacktestMetrics;
    test: BacktestMetrics;
  };
};

export type BacktestTrade = {
  tradeNumber: number;
  direction: "BUY" | "SELL" | string;
  entryTs: string;
  exitTs: string;
  entryPrice: number;
  exitPrice: number | null;
  qty: number;
  slPrice: number | null;
  tpPrice: number | null;
  exitReason: string | null;
  grossPnl: number;
  fees: number;
  fundingPaid: number;
  slippageCost: number;
  netPnl: number;
  barsHeld: number;
  maePct: number | null;
  mfePct: number | null;
  intelScoreAtEntry: number | null;
  gateAction: string | null;
  trailTierLabel: string | null;
  trailStep: number;
  /** Wallet equity used to size this trade (compounding: grows/shrinks with PnL). */
  equityAtEntry: number | null;
  /** Initial margin at entry (notional ÷ leverage on futures). */
  marginUsdt: number | null;
  /** TREND_HTF_ST structural chop assessment at entry (when recorded). */
  entryQuality?: TrendHtfStEntryQuality | null;
  /** Post-close loss/win pattern label (e.g. WHIPSAW_GAVE_BACK, INSTANT_SL). */
  lossPattern?: string | null;
  /** Signal reason at entry (e.g. smc_ict, ipro_liq_sweep). */
  entryReason?: string | null;
  /** Liquidity / SMC context persisted from the simulator. */
  liqContext?: Record<string, unknown> | null;
};

export type TrendHtfStEntryQuality = {
  score: number;
  riskLevel: "low" | "medium" | "high";
  macroMode?: "CHOP_SEASON" | "TREND_SEASON" | string;
  structuralRisk: "CHOP_ZONE" | "TREND_OK" | "MIXED";
  flags: string[];
  wouldBlock: boolean;
  allowEntry?: boolean;
  blockReasons?: string[];
  htfSepPct: number;
  htfSepSlope: number;
  adx15m: number;
  regime15m: string;
  stFlipCount16: number;
  htfCrossRecent: boolean;
  counterSignalBar: boolean;
  entryRangeAtr: number;
};

export type BacktestEquityPoint = {
  ts: number;
  equity: number;
  drawdownPct: number;
};

export type BacktestCoverage = {
  have: number;
  expected: number | null;
  coveragePct: number | null;
  minTs: number | null;
  maxTs: number | null;
};

export type BacktestMonthlyCoverage = {
  month: string;
  have: number;
  expected: number;
  coveragePct: number;
};

export type BacktestOptimizationSummary = {
  id: string;
  symbol: string;
  timeframe: string;
  status: string;
  paramGrid: Record<string, number[]>;
  walkForward: { trainPct?: number } | null;
  nRuns: number;
  nCompleted: number;
  bestRunId: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type BacktestOptimizationRun = {
  id: string;
  label: string | null;
  status: BacktestRunStatus;
  progressPct: number;
  configSnapshot: Record<string, unknown> | null;
  totalTrades: number;
  winRatePct: number | null;
  totalPnlUsdt: number | null;
  maxDrawdownPct: number | null;
  sharpeRatio: number | null;
  profitFactor: number | null;
  metrics: BacktestMetrics | null;
};
