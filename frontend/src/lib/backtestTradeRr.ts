import type { BacktestTrade } from "../types/backtest";

const MIN_REL_RISK = 1e-5;

/**
 * Price RR: reward distance (entry → exit) ÷ risk distance (entry → initial/default SL).
 * Uses `initialSlPrice` when present (entry-time stop); falls back to `slPrice` only if
 * it is a meaningful distance from entry (not a trailed breakeven stop).
 */
export function computeTradePriceRr(t: BacktestTrade): number | null {
  const entry = Number(t.entryPrice);
  const exit = Number(t.exitPrice);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(exit)) return null;

  const isLong = String(t.direction || "BUY").toUpperCase() === "BUY";
  const stop = resolveInitialStopPrice(t, entry);
  if (stop == null) return null;

  const riskDist = isLong ? entry - stop : stop - entry;
  if (!Number.isFinite(riskDist) || riskDist <= entry * MIN_REL_RISK) return null;

  const rewardDist = isLong ? exit - entry : entry - exit;
  if (!Number.isFinite(rewardDist)) return null;

  return rewardDist / riskDist;
}

function resolveInitialStopPrice(t: BacktestTrade, entry: number): number | null {
  const initial = Number(t.initialSlPrice);
  if (Number.isFinite(initial) && initial > 0) return initial;

  const sl = Number(t.slPrice);
  if (Number.isFinite(sl) && sl > 0 && Math.abs(entry - sl) / entry > MIN_REL_RISK) return sl;

  return null;
}

export function formatTradeRr(rr: number | null | undefined): string {
  if (rr == null || !Number.isFinite(rr)) return "—";
  const sign = rr > 0 ? "+" : "";
  return `${sign}${rr.toFixed(2)}`;
}

export function avgTradePriceRr(trades: BacktestTrade[]): number | null {
  if (!trades.length) return null;
  let sum = 0;
  let n = 0;
  for (const t of trades) {
    const rr = computeTradePriceRr(t);
    if (rr != null && Number.isFinite(rr)) {
      sum += rr;
      n += 1;
    }
  }
  return n > 0 ? sum / n : null;
}
