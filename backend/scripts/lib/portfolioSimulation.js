/**
 * Portfolio simulation — signal → position size → correlation → exposure → costs.
 */
import { mean, num } from "./liqResearchStats.js";

const DEFAULT_HOLD_BARS = 20;

/**
 * Portfolio sim with correlation penalty, exposure limits, and transaction costs.
 */
export function simulatePortfolio(selectedCandidates, opts = {}) {
  const startCapital = Number(opts.startCapital ?? 10000);
  const riskPerTrade = Number(opts.riskPerTrade ?? 0.01);
  const maxConcurrent = Number(opts.maxConcurrent ?? 3);
  const maxSymbolExposure = Number(opts.maxSymbolExposure ?? 2);
  const feeBps = Number(opts.feeBps ?? 4);
  const slippageBps = Number(opts.slippageBps ?? 2);
  const holdBars = Number(opts.holdBars ?? DEFAULT_HOLD_BARS);
  const barMs = Number(opts.barMs ?? 15 * 60 * 1000);
  const correlationPenalty = Number(opts.correlationPenalty ?? 0.15);

  const sorted = [...selectedCandidates]
    .filter((c) => num(c.fwd_closeR_20 ?? c.actualR) != null)
    .sort((a, b) => Number(a.entryTs ?? 0) - Number(b.entryTs ?? 0));

  let equity = startCapital;
  const curve = [{ ts: sorted[0]?.entryTs ?? 0, equity }];
  const open = [];
  const symbolExposure = new Map();
  let correlationSkips = 0;
  let exposureSkips = 0;

  const roundTripCostR = ((feeBps + slippageBps) * 2) / 10000;

  for (const c of sorted) {
    const ts = Number(c.entryTs);
    const symbol = c.symbol ?? "UNKNOWN";
    const r = (num(c.fwd_closeR_20 ?? c.actualR) ?? 0) - roundTripCostR;

    const symCount = symbolExposure.get(symbol) ?? 0;
    if (symCount >= maxSymbolExposure) {
      exposureSkips++;
      continue;
    }

    const concurrentSymbols = new Set(open.map((o) => o.symbol));
    if (concurrentSymbols.has(symbol) && open.length >= 1) {
      correlationSkips++;
    }

    const corrAdj = concurrentSymbols.has(symbol) ? 1 - correlationPenalty : 1;
    const effectiveRisk = equity * riskPerTrade * corrAdj;

    open.push({ ts, r, riskUsd: effectiveRisk, symbol, holdBars });
    symbolExposure.set(symbol, symCount + 1);

    const exitTs = ts + holdBars * barMs;
    while (open.length && (open.length > maxConcurrent || open[0].ts + open[0].holdBars * barMs <= ts)) {
      const closed = open.shift();
      equity += closed.riskUsd * closed.r;
      const sc = symbolExposure.get(closed.symbol) ?? 1;
      symbolExposure.set(closed.symbol, Math.max(0, sc - 1));
      curve.push({ ts: closed.ts + closed.holdBars * barMs, equity });
    }
  }

  for (const closed of open) {
    equity += closed.riskUsd * closed.r;
    curve.push({ ts: closed.ts + closed.holdBars * closed.barMs, equity });
  }

  const returns = sorted.map((c) => (num(c.fwd_closeR_20 ?? c.actualR) ?? 0) - roundTripCostR);
  const winRate = returns.filter((r) => r > 0).length / Math.max(1, returns.length);

  const symbolReturns = {};
  for (const c of sorted) {
    const sym = c.symbol ?? "UNKNOWN";
    if (!symbolReturns[sym]) symbolReturns[sym] = [];
    symbolReturns[sym].push(num(c.fwd_closeR_20 ?? c.actualR) ?? 0);
  }
  const correlationMatrix = buildCorrelationMatrix(symbolReturns);

  return {
    startCapital,
    endCapital: equity,
    netReturnPct: ((equity - startCapital) / startCapital) * 100,
    trades: sorted.length - exposureSkips,
    skippedExposure: exposureSkips,
    skippedCorrelation: correlationSkips,
    winRate: winRate * 100,
    avgR: returns.length ? mean(returns) : 0,
    maxConcurrent,
    maxSymbolExposure,
    feeBps,
    slippageBps,
    roundTripCostR,
    correlationMatrix,
  };
}

function buildCorrelationMatrix(symbolReturns) {
  const symbols = Object.keys(symbolReturns);
  const matrix = {};
  for (const a of symbols) {
    matrix[a] = {};
    for (const b of symbols) {
      if (a === b) {
        matrix[a][b] = 1;
        continue;
      }
      matrix[a][b] = pearsonCorr(symbolReturns[a], symbolReturns[b]);
    }
  }
  return matrix;
}

function pearsonCorr(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 5) return null;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let nume = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    nume += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? Number((nume / den).toFixed(3)) : null;
}

/**
 * Compare portfolio value of uncorrelated vs correlated signal sets.
 */
export function portfolioDiversificationValue(candidates, opts = {}) {
  const bySymbol = new Map();
  for (const c of candidates) {
    const sym = c.symbol ?? "UNKNOWN";
    if (!bySymbol.has(sym)) bySymbol.set(sym, []);
    bySymbol.get(sym).push(c);
  }

  const bestPerSymbol = [...bySymbol.values()].map((list) =>
    [...list].sort((a, b) => num(b.fwd_closeR_20 ?? b.actualR) - num(a.fwd_closeR_20 ?? a.actualR))[0],
  );

  const concentrated = simulatePortfolio(candidates.slice(0, Math.min(candidates.length, 200)), opts);
  const diversified = simulatePortfolio(bestPerSymbol, { ...opts, maxSymbolExposure: 1 });

  return {
    concentrated,
    diversified,
    diversificationLift:
      diversified.netReturnPct != null && concentrated.netReturnPct != null
        ? diversified.netReturnPct - concentrated.netReturnPct
        : null,
    insight: "Mediocre uncorrelated signals can outperform concentrated excellent signals",
  };
}
