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

/**
 * Price RR: (exit − entry) / (entry − initial SL) for longs (inverted for shorts).
 * @param {object} t
 * @returns {number|null}
 */
export function tradePriceRr(t) {
  const entry = Number(t.entryPrice ?? t.entryFill);
  const exit = Number(t.exitPrice);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(exit)) return null;
  const isLong = String(t.direction || "BUY").toUpperCase() === "BUY";
  const initial = Number(t.initialSlPrice);
  let stop = Number.isFinite(initial) && initial > 0 ? initial : Number(t.slPrice ?? t.stopPrice);
  if (!Number.isFinite(stop) || stop <= 0) return null;
  if (!Number.isFinite(initial) && Math.abs(entry - stop) / entry <= 1e-5) return null;
  const riskDist = isLong ? entry - stop : stop - entry;
  if (!Number.isFinite(riskDist) || riskDist <= entry * 1e-5) return null;
  const rewardDist = isLong ? exit - entry : entry - exit;
  if (!Number.isFinite(rewardDist)) return null;
  return rewardDist / riskDist;
}

/** @param {Array<object>} trades */
export function priceRrStats(trades) {
  const values = [];
  for (const t of trades || []) {
    const rr = tradePriceRr(t);
    if (rr != null && Number.isFinite(rr)) values.push(rr);
  }
  if (!values.length) {
    return { avgRr: null, rrCount: 0, rrWinAvg: null, rrLossAvg: null };
  }
  const wins = values.filter((r) => r > 0);
  const losses = values.filter((r) => r <= 0);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    avgRr: mean,
    rrCount: values.length,
    rrWinAvg: wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : null,
    rrLossAvg: losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : null,
  };
}

/**
 * R-multiple distribution. Each trade's R = netPnl / riskAtEntry, where risk is
 * the dollar amount risked to the stop (entry-to-SL distance × qty). Falls back
 * to `t.riskUsd`/`t.rMultiple` if the runner already recorded them.
 * @param {Array<object>} trades
 */
export function rMultipleStats(trades) {
  const rs = [];
  for (const t of trades) {
    let r = null;
    if (Number.isFinite(Number(t.rMultiple))) {
      r = Number(t.rMultiple);
    } else {
      // Prefer the entry-time dollar risk. The live stop is trailed to breakeven,
      // so `slPrice` on the final leg can equal the entry and blow R up to infinity.
      const entry = Number(t.entryPrice ?? t.entryFill);
      const stop = Number(t.initialSlPrice ?? t.slPrice ?? t.stopPrice);
      const risk =
        Number(t.initialRiskUsd) ||
        Number(t.riskUsd) ||
        (Number.isFinite(entry) && Number.isFinite(stop) && Number(t.qty)
          ? Math.abs(entry - stop) * Math.abs(Number(t.qty))
          : 0);
      if (risk > 0) r = Number(t.netPnl ?? 0) / risk;
    }
    if (r != null && Number.isFinite(r)) rs.push(r);
  }
  if (!rs.length) {
    return { rCount: 0, rMean: 0, rMedian: 0, rStd: 0, rMin: 0, rMax: 0, expectancyR: 0, rValues: [] };
  }
  const sorted = [...rs].sort((a, b) => a - b);
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const variance = rs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rs.length - 1);
  const median =
    sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return {
    rCount: rs.length,
    rMean: mean,
    rMedian: median,
    rStd: Math.sqrt(variance),
    rMin: sorted[0],
    rMax: sorted[sorted.length - 1],
    expectancyR: mean,
    rValues: rs,
  };
}

/**
 * Rolling Sharpe over per-bar equity returns within a window. Returns the array
 * plus the min/last so we can see stability over the run (not just the average).
 */
export function rollingSharpe(curve, tf, windowBars = 480) {
  if (!curve.length) return { series: [], min: 0, last: 0 };
  const stepMs = tfToMs(tf);
  const barsPerYear = (365 * 24 * 60 * 60 * 1000) / stepMs;
  const rets = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].equity;
    rets.push(prev > 0 ? (curve[i].equity - prev) / prev : 0);
  }
  const series = [];
  for (let i = windowBars; i <= rets.length; i++) {
    const win = rets.slice(i - windowBars, i);
    const mean = win.reduce((a, b) => a + b, 0) / win.length;
    const variance = win.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, win.length - 1);
    const std = Math.sqrt(variance);
    series.push(std > 0 ? (mean / std) * Math.sqrt(barsPerYear) : 0);
  }
  let min = 0;
  if (series.length) {
    min = series[0];
    for (let i = 1; i < series.length; i++) if (series[i] < min) min = series[i];
  }
  return {
    series,
    min,
    last: series.length ? series[series.length - 1] : 0,
  };
}

/**
 * Per-regime metric breakdown. `regimeOf(trade)` must return a label string (or
 * null). Aggregates net PnL, win rate, count and expectancy per regime.
 */
export function perRegimeBreakdown(trades, regimeOf) {
  if (typeof regimeOf !== "function") return {};
  const map = {};
  for (const t of trades) {
    const reg = regimeOf(t) || "UNKNOWN";
    if (!map[reg]) map[reg] = { regime: reg, trades: 0, wins: 0, netPnl: 0, grossPnl: 0 };
    const net = Number(t.netPnl ?? 0);
    map[reg].trades += 1;
    map[reg].netPnl += net;
    map[reg].grossPnl += Number(t.grossPnl ?? 0);
    if (net > 0) map[reg].wins += 1;
  }
  for (const reg of Object.keys(map)) {
    const m = map[reg];
    m.winRate = m.trades ? m.wins / m.trades : 0;
    m.expectancy = m.trades ? m.netPnl / m.trades : 0;
  }
  return map;
}

/**
 * @param {object} args
 * @param {(trade:object)=>string|null} [args.regimeOf] optional per-trade regime classifier
 */
export function computeAllMetrics({ trades, equityCurve, tf, startingEquity, regimeOf }) {
  const ts = tradeStats(trades);
  const mdd = maxDrawdown(equityCurve);
  const sr = sharpeAndSortino(equityCurve, tf);
  const rmult = rMultipleStats(trades);
  const rrStats = priceRrStats(trades);
  const finalEquity = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : startingEquity;
  const totalReturnPct = startingEquity > 0 ? ((finalEquity - startingEquity) / startingEquity) * 100 : 0;
  const romd = mdd.maxDrawdownPct > 0 ? totalReturnPct / mdd.maxDrawdownPct : null;

  // CAGR + Calmar from the equity curve timespan.
  const spanMs =
    equityCurve.length > 1 ? equityCurve[equityCurve.length - 1].ts - equityCurve[0].ts : 0;
  const years = spanMs > 0 ? spanMs / (365 * 24 * 60 * 60 * 1000) : 0;
  const growth = startingEquity > 0 ? finalEquity / startingEquity : 1;
  const cagrPct =
    years > 0 && growth > 0 ? (Math.pow(growth, 1 / years) - 1) * 100 : totalReturnPct;
  const calmar = mdd.maxDrawdownPct > 0 ? cagrPct / mdd.maxDrawdownPct : null;
  const rollSharpe = rollingSharpe(equityCurve, tf);

  return {
    ...ts,
    ...mdd,
    ...sr,
    finalEquity,
    totalReturnPct,
    romd,
    cagrPct,
    calmar,
    rMean: rmult.rMean,
    rMedian: rmult.rMedian,
    rStd: rmult.rStd,
    rMin: rmult.rMin,
    rMax: rmult.rMax,
    expectancyR: rmult.expectancyR,
    avgRr: rrStats.avgRr,
    rrCount: rrStats.rrCount,
    rollingSharpeMin: rollSharpe.min,
    rollingSharpeLast: rollSharpe.last,
    monthlyReturns: monthlyReturns(trades),
    ...(typeof regimeOf === "function" ? { perRegime: perRegimeBreakdown(trades, regimeOf) } : {}),
  };
}

/**
 * Attach train/test metrics for UI walk-forward (single split by bar index).
 * Simulator still runs on the full window; this only splits the report.
 *
 * @param {object} metrics base metrics from computeAllMetrics
 * @param {object} args
 * @param {object[]} args.trades
 * @param {object[]} args.equityCurve
 * @param {Array<{ts:number}>} args.timelineCandles bar series used for the split index
 * @param {number|null|undefined} args.trainPct 0.1–0.9
 * @param {string} args.tf
 * @param {number} args.startingEquity
 */
export function attachWalkForwardMetrics(metrics, {
  trades,
  equityCurve,
  timelineCandles,
  trainPct,
  tf,
  startingEquity,
}) {
  if (trainPct == null || !trades?.length || !timelineCandles?.length) return metrics;
  const pct = Math.max(0.1, Math.min(0.9, Number(trainPct)));
  if (!Number.isFinite(pct)) return metrics;
  const splitIdx = Math.floor(timelineCandles.length * pct);
  const splitTs =
    splitIdx > 0 && splitIdx < timelineCandles.length ? Number(timelineCandles[splitIdx].ts) : null;
  if (splitTs == null) return metrics;

  const trainTrades = trades.filter((t) => Number(t.exitTs) <= splitTs);
  const testTrades = trades.filter((t) => Number(t.exitTs) > splitTs);
  const trainCurve = equityCurve.filter((p) => Number(p.ts) <= splitTs);
  const testCurve = equityCurve.filter((p) => Number(p.ts) > splitTs);
  const startingTest = trainCurve.length ? trainCurve[trainCurve.length - 1].equity : startingEquity;

  return {
    ...metrics,
    walkForward: {
      trainPct: pct,
      splitTs,
      train: computeAllMetrics({
        trades: trainTrades,
        equityCurve: trainCurve,
        tf,
        startingEquity,
      }),
      test: computeAllMetrics({
        trades: testTrades,
        equityCurve: testCurve,
        tf,
        startingEquity: startingTest,
      }),
    },
  };
}
