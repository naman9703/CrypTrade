import type { BacktestEquityPoint, BacktestMetrics, BacktestRunSummary, BacktestTrade } from "../types/backtest";

function parseTs(v: string | number | null | undefined): number {
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : NaN;
}

/** Sharpe from equity curve points (annualized, same idea as backend metrics.js). */
function sharpeFromCurve(curve: BacktestEquityPoint[], barsPerYear = 8760): number {
  if (curve.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].equity;
    if (prev <= 0) continue;
    rets.push((curve[i].equity - prev) / prev);
  }
  if (!rets.length) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const std = Math.sqrt(variance);
  return std > 0 ? (mean / std) * Math.sqrt(barsPerYear) : 0;
}

function barsPerYearForTf(tf: string): number {
  const m = String(tf).match(/^(\d+)(m|h|d)$/i);
  if (!m) return 8760;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  if (u === "m") return (365 * 24 * 60) / n;
  if (u === "h") return (365 * 24) / n;
  return 365 / n;
}

function sliceMetrics(
  trades: BacktestTrade[],
  curve: BacktestEquityPoint[],
  startingEquity: number,
  tf: string,
): BacktestMetrics {
  const wins = trades.filter((t) => Number(t.netPnl) > 0).length;
  const totalNet = trades.reduce((a, t) => a + Number(t.netPnl ?? 0), 0);
  const finalEquity = curve.length ? curve[curve.length - 1].equity : startingEquity;
  const totalReturnPct =
    startingEquity > 0 ? ((finalEquity - startingEquity) / startingEquity) * 100 : 0;
  let peak = curve.length ? curve[0].equity : startingEquity;
  let mdd = 0;
  for (const p of curve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak > 0 ? ((peak - p.equity) / peak) * 100 : 0;
    if (dd > mdd) mdd = dd;
  }
  return {
    totalTrades: trades.length,
    wins,
    losses: trades.length - wins,
    winRate: trades.length ? wins / trades.length : 0,
    profitFactor: 0,
    grossProfit: 0,
    grossLoss: 0,
    avgWin: 0,
    avgLoss: 0,
    largestWin: 0,
    largestLoss: 0,
    avgHoldMs: 0,
    expectancy: trades.length ? totalNet / trades.length : 0,
    totalNetPnl: totalNet,
    totalGrossPnl: 0,
    totalFees: 0,
    totalFunding: 0,
    totalSlippage: 0,
    maxDrawdownPct: mdd,
    maxDrawdownDurationMs: 0,
    sharpe: sharpeFromCurve(curve, barsPerYearForTf(tf)),
    sortino: 0,
    finalEquity,
    totalReturnPct,
    romd: null,
    monthlyReturns: {},
  };
}

/**
 * Client-side walk-forward when metrics.walkForward was not persisted (portfolio bug / old runs).
 */
export function computeWalkForwardClient(
  run: BacktestRunSummary,
  trades: BacktestTrade[] | null,
  curve: BacktestEquityPoint[] | null,
): BacktestMetrics["walkForward"] | null {
  const existing = run.metrics?.walkForward;
  if (existing?.train && existing?.test) return existing;

  const trainPct = run.walkForwardSplit?.trainPct ?? existing?.trainPct;
  if (trainPct == null || !Number.isFinite(Number(trainPct)) || !trades?.length) return null;

  const start = parseTs(run.startDate);
  const end = parseTs(run.endDate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

  const pct = Math.max(0.1, Math.min(0.9, Number(trainPct)));
  const splitTs = start + (end - start) * pct;

  const trainTrades = trades.filter((t) => parseTs(t.exitTs) <= splitTs);
  const testTrades = trades.filter((t) => parseTs(t.exitTs) > splitTs);
  const trainCurve = (curve ?? []).filter((p) => p.ts <= splitTs);
  const testCurve = (curve ?? []).filter((p) => p.ts > splitTs);
  const startingEquity = Number(run.initialCapital) || 100;
  const startingTest = trainCurve.length ? trainCurve[trainCurve.length - 1].equity : startingEquity;

  return {
    trainPct: pct,
    splitTs,
    train: sliceMetrics(trainTrades, trainCurve, startingEquity, run.timeframe),
    test: sliceMetrics(testTrades, testCurve, startingTest, run.timeframe),
  };
}
