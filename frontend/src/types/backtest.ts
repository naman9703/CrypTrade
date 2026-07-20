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
  /** Multi-coin portfolio run: list of symbols traded. */
  symbols?: string[] | null;
  isPortfolio?: boolean;
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
  /** Set when walk-forward was requested at run creation ({ trainPct }). */
  walkForwardSplit?: { trainPct?: number } | null;
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
  /** Mean price RR (entry→exit vs entry→initial SL) across trades with valid stops. */
  avgRr?: number | null;
  rrCount?: number;
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
  portfolio?: {
    symbols: string[];
    mode?: string;
    perCoinStart?: number;
    skippedOverlap?: number;
    perCoin: Record<
      string,
      { trades: number; wins: number; winRate: number; netPnl: number }
    >;
  };
  trailTickAudit?: TrailTickAuditResult;
};

export type TrailTickAuditVerdict = {
  parityPct: number;
  exitReasonMatchPct: number;
  trailTierMatchPct: number;
  medianExitTimeDeltaMs: number | null;
  netPnlDeltaPct: number;
  replayableCount: number;
  comparedCount: number;
  skippedCount: number;
};

export type TrailTickAuditTradeCompare = {
  tradeNumber: number;
  replaySkipped: boolean;
  skipReason?: string;
  match?: boolean | null;
  reasonMatch?: boolean;
  tierMatch?: boolean;
  exitTimeDeltaMs?: number | null;
  exitPriceDeltaPct?: number | null;
  netPnlDelta?: number | null;
  backtest?: {
    exitReason?: string;
    exitTs?: number;
    exitPrice?: number;
    trailStep?: number;
    trailTierLabel?: string | null;
    netPnl?: number;
  };
  replay?: {
    exitReason?: string | null;
    exitTs?: number | null;
    exitPrice?: number | null;
    trailStep?: number;
    trailTierLabel?: string | null;
    netPnl?: number | null;
    noExitInWindow?: boolean;
  };
};

export type TrailTickAuditResult = {
  status: "idle" | "running" | "done" | "failed";
  mode?: string;
  completedAt?: string;
  error?: string;
  tradeCount?: number;
  verdict?: TrailTickAuditVerdict;
  perTrade?: TrailTickAuditTradeCompare[];
};

export type BacktestTrailEvent = {
  /** Event timestamp (ms since epoch). */
  ts: number | null;
  step: number;
  tierLabel: string | null;
  /** Locked stop after this tier armed. */
  slPrice: number | null;
  /** Favorable extreme (HWM) when tier activated. */
  favorablePx: number | null;
  /** Price gate for the next tier (shown as next activation threshold). */
  nextActivationPx: number | null;
};

export type BacktestTrade = {
  tradeNumber: number;
  /** Set on portfolio runs; omitted on legacy single-coin runs. */
  symbol?: string | null;
  direction: "BUY" | "SELL" | string;
  /** Strategy-bar open time (DB `entry_time`). */
  entryTs: string;
  /** Signal bar open — same as `entryTs` on legacy runs. */
  entryBarTs?: string | null;
  /** Wall-clock fill time (bar close for Elite same-bar entry). */
  entryFillTs?: string | null;
  entrySameBar?: boolean | null;
  /** Signal-bar close before slippage (matches 1h/1m OHLC at fill). */
  entryMarkPx?: number | null;
  exitTs: string;
  /** Wall-clock exit fill (1m mark minute when micro trail recorded). */
  exitFillTs?: string | null;
  entryPrice: number;
  exitPrice: number | null;
  qty: number;
  slPrice: number | null;
  tpPrice: number | null;
  /** Entry-time stop used for sizing / RR (not trailed exit SL). */
  initialSlPrice?: number | null;
  initialRiskUsd?: number | null;
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
  /** Per-tier trail activations recorded during simulation (re-run backtest to populate). */
  trailEvents?: BacktestTrailEvent[] | null;
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
  /** Estimated Postgres heap bytes for rows in the selected window. */
  diskBytes?: number | null;
  /** Estimated in-memory bytes when bars are loaded for a backtest run. */
  memBytesEst?: number | null;
  /** Projected disk bytes if the window were 100% filled. */
  diskBytesFull?: number | null;
  /** Projected in-memory bytes if the window were 100% filled. */
  memBytesFull?: number | null;
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

/* ───────────────────────── strategy testing battery ───────────────────────── */

export type StrategyTestStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export type StrategyTestSlimMetrics = {
  totalTrades: number;
  winRate: number;
  profitFactor: number | null;
  expectancy: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  calmar: number | null;
  cagrPct: number;
  totalFees: number;
  totalGrossPnl: number;
  totalNetPnl: number;
  finalEquity: number | null;
};

export type StrategyTestGate = { pass: boolean; value: number; threshold: string };

export type StrategyTestReport = {
  engineVersion?: string;
  seedRunId: string;
  strategyKey: string;
  symbols: string[];
  isPortfolio: boolean;
  timeframe: string;
  window: { from: number; to: number; bars: number; note?: string | null };
  baseline: {
    metrics: StrategyTestSlimMetrics | null;
    reproducibility: {
      seedReturnPct: number | null;
      seedTrades: number;
      batteryReturnPct: number;
      batteryTrades: number;
      sameWindow: boolean;
      note: string;
    };
  };
  walkForward: {
    folds: Array<{
      fold: number;
      train: { trades: number; expectancy: number; returnPct: number };
      test: { trades: number; expectancy: number; returnPct: number; profitFactor: number | null };
    }>;
    avgTrainExpectancy: number;
    avgTestExpectancy: number;
    degradationPct: number;
    oosSumReturnPct: number;
    embargoBars: number;
    scope: string;
    note: string | null;
  };
  monteCarlo: {
    paths: number;
    p5ReturnPct: number;
    p50ReturnPct: number;
    p95ReturnPct: number;
    meanReturnPct: number;
    medianMaxDdPct: number;
    p95MaxDdPct: number;
    riskOfRuinPct: number;
    insufficient?: boolean;
    riskFracPct: number;
    rCount: number;
  };
  sensitivity: {
    params: Array<{
      key: string;
      base: number;
      variants: Array<{
        delta: string;
        value: number;
        returnPct: number | null;
        profitFactor: number | null;
        trades: number;
        maxDrawdownPct: number | null;
        breaks: boolean;
        /** Engine clamped/ignored the perturbed value — variant tested nothing. */
        noEffect?: boolean;
      }>;
    }>;
    variantCount: number;
    breakCount: number;
    breakRatePct: number | null;
    stable: boolean | null;
  };
  costStress: Array<{
    id: string;
    label: string;
    returnPct: number | null;
    deltaVsBasePct: number | null;
    trades: number;
    survived: boolean;
  }>;
  feesOverGrossPct: number | null;
  stress: Array<{
    id: string;
    label: string;
    kind: "synthetic" | "historical";
    window?: string;
    returnPct?: number | null;
    maxDrawdownPct?: number | null;
    trades?: number;
    survived?: boolean;
    skipped?: boolean;
    reason?: string;
  }>;
  stressSurvivedAll: boolean;
  gates: { allPass: boolean; gates: Record<string, StrategyTestGate> };
  fidelity: {
    score: number;
    factors: Array<{ id: string; label: string; score: number; max: number; note: string }>;
  };
  grade: { grade: "A" | "B" | "C" | "F"; reasons: string[] };
};

export type StrategyTestSuggestion = {
  safetyLimits: { maxDrawdownPct: number; mcP5ReturnPct: number; riskOfRuinPct: number };
  candidates: Array<{
    label: string;
    cfgPatch: Record<string, number>;
    totalReturnPct: number;
    maxDrawdownPct: number;
    profitFactor: number | null;
    trades: number;
    sharpe: number;
    mcP5ReturnPct: number;
    riskOfRuinPct: number;
    withinLimits: boolean;
  }>;
  best: {
    label: string;
    cfgPatch: Record<string, number>;
    metrics: {
      totalReturnPct: number;
      maxDrawdownPct: number;
      profitFactor: number | null;
      sharpe: number;
      trades: number;
      mcP5ReturnPct: number;
      riskOfRuinPct: number;
    };
  } | null;
  note: string | null;
  instanceConfig: Record<string, number | string>;
  coinSuitability?: "PASS" | "MARGINAL" | "SKIP";
  recommendedSepMode?: string;
};

export type StrategyTestSummary = {
  id: string;
  seedRunId: string;
  seedLabel: string | null;
  seedSymbol: string | null;
  seedSymbols: string[] | null;
  seedTimeframe: string | null;
  seedEngineType: string | null;
  status: StrategyTestStatus;
  progressPct: number;
  currentPhase: string | null;
  grade: "A" | "B" | "C" | "F" | null;
  liveFidelityScore: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  report?: StrategyTestReport | null;
  suggestion?: StrategyTestSuggestion | null;
};
