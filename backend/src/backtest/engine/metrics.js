/**
 * Metrics aggregator for completed backtest runs. Inputs: trade list and equity curve;
 * outputs: KPIs displayed in the result panel (return %, win rate, PF, Sharpe, max DD,
 * monthly returns matrix, MAE/MFE per trade etc).
 *
 * No look-ahead: all metrics are computed from inputs that already enforce the
 * "signal on closed bar / fill on next bar" contract.
 */

import { tfToMs } from "../data/timeframe.js";

/** @param {Array<{ts:number, equity:number, drawdown_pct:number}>} curve */
export function maxDrawdown(curve) {
  let peak = curve.length ? curve[0].equity : 0;
  let mdd = 0;
  let mddDur = 0;
  let durStartTs = curve.length ? curve[0].ts : 0;
  for (let i = 0; i < curve.length; i++) {
    const v = curve[i].equity;
    if (v > peak) {
      peak = v;
      durStartTs = curve[i].ts;
    }
    const dd = peak > 0 ? (peak - v) / Math.abs(peak) : 0;
    if (dd > mdd) {
      mdd = dd;
      mddDur = curve[i].ts - durStartTs;
    }
  }
  return { maxDrawdownPct: mdd * 100, maxDrawdownDurationMs: mddDur };
}

/** Sharpe and Sortino computed over per-bar simple returns (annualised by tf). */
export function sharpeAndSortino(curve, tf) {
  if (!curve.length) return { sharpe: 0, sortino: 0 };
  const stepMs = tfToMs(tf);
  const barsPerYear = (365 * 24 * 60 * 60 * 1000) / stepMs;
  const returns = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].equity;
    if (prev <= 0) continue;
    returns.push((curve[i].equity - prev) / prev);
  }
  if (!returns.length) return { sharpe: 0, sortino: 0 };
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, returns.length - 1);
  const std = Math.sqrt(variance);
  const downside = Math.sqrt(
    returns.filter((r) => r < 0).reduce((a, b) => a + b * b, 0) / Math.max(1, returns.length),
  );
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(barsPerYear) : 0;
  const sortino = downside > 0 ? (mean / downside) * Math.sqrt(barsPerYear) : 0;
  return { sharpe, sortino };
}

/** PnL-based KPIs for the trades list. */
export function tradeStats(trades) {
  if (!trades.length) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      profitFactor: 0,
      grossProfit: 0,
      grossLoss: 0,
      avgWin: 0,
      avgLoss: 0,
      largestWin: 0,
      largestLoss: 0,
      avgHoldMs: 0,
      expectancy: 0,
      totalNetPnl: 0,
      totalGrossPnl: 0,
      totalFees: 0,
      totalFunding: 0,
      totalSlippage: 0,
    };
  }
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLossAbs = 0;
  let avgWin = 0;
  let avgLoss = 0;
  let largestWin = 0;
  let largestLoss = 0;
  let totalHoldMs = 0;
  let totalNet = 0;
  let totalGross = 0;
  let totalFees = 0;
  let totalFunding = 0;
  let totalSlippage = 0;
  for (const t of trades) {
    const net = Number(t.netPnl ?? 0);
    totalNet += net;
    totalGross += Number(t.grossPnl ?? 0);
    totalFees += Number(t.fees ?? 0);
    totalFunding += Number(t.fundingPaid ?? 0);
    totalSlippage += Number(t.slippageCost ?? 0);
    totalHoldMs += Math.max(0, Number(t.exitTs ?? 0) - Number(t.entryTs ?? 0));
    if (net > 0) {
      wins++;
      grossProfit += net;
      largestWin = Math.max(largestWin, net);
    } else if (net < 0) {
      losses++;
      grossLossAbs += Math.abs(net);
      largestLoss = Math.min(largestLoss, net);
    }
  }
  avgWin = wins ? grossProfit / wins : 0;
  avgLoss = losses ? -grossLossAbs / losses : 0;
  const profitFactor = grossLossAbs > 0 ? grossProfit / grossLossAbs : grossProfit > 0 ? 999 : 0;
  const winRate = trades.length ? wins / trades.length : 0;
  const expectancy = trades.length ? totalNet / trades.length : 0;
  return {
    totalTrades: trades.length,
    wins,
    losses,
    winRate,
    profitFactor,
    grossProfit,
    grossLoss: -grossLossAbs,
    avgWin,
    avgLoss,
    largestWin,
    largestLoss,
    avgHoldMs: totalHoldMs / trades.length,
    expectancy,
    totalNetPnl: totalNet,
    totalGrossPnl: totalGross,
    totalFees,
    totalFunding,
    totalSlippage,
  };
}

/** Monthly returns matrix `{ "YYYY-MM": pnl }` derived from trades. */
export function monthlyReturns(trades) {
  const map = {};
  for (const t of trades) {
    const exit = Number(t.exitTs);
    if (!Number.isFinite(exit)) continue;
    const d = new Date(exit);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    map[key] = (map[key] || 0) + Number(t.netPnl ?? 0);
  }
  return map;
}

export function computeAllMetrics({ trades, equityCurve, tf, startingEquity }) {
  const ts = tradeStats(trades);
  const mdd = maxDrawdown(equityCurve);
  const sr = sharpeAndSortino(equityCurve, tf);
  const finalEquity = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : startingEquity;
  const totalReturnPct = startingEquity > 0 ? ((finalEquity - startingEquity) / startingEquity) * 100 : 0;
  const romd = mdd.maxDrawdownPct > 0 ? totalReturnPct / mdd.maxDrawdownPct : null;
  return {
    ...ts,
    ...mdd,
    ...sr,
    finalEquity,
    totalReturnPct,
    romd,
    monthlyReturns: monthlyReturns(trades),
  };
}
