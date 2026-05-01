import type { StrategyPerformance } from "../types/performance";

export type MetricTone = "good" | "mid" | "bad" | "neutral";

export function toneWinRate(pct: number | null | undefined): MetricTone {
  if (pct == null || !Number.isFinite(pct)) return "neutral";
  if (pct >= 60) return "good";
  if (pct >= 50) return "mid";
  return "bad";
}

export function toneProfitFactor(pf: number | null | undefined): MetricTone {
  if (pf == null || !Number.isFinite(pf)) return "neutral";
  if (pf >= 1.5) return "good";
  if (pf >= 1) return "mid";
  return "bad";
}

/** Lower drawdown % is better. */
export function toneMaxDrawdown(pct: number | null | undefined): MetricTone {
  if (pct == null || !Number.isFinite(pct)) return "neutral";
  if (pct <= 5) return "good";
  if (pct <= 15) return "mid";
  return "bad";
}

export function toneClass(t: MetricTone): string {
  switch (t) {
    case "good":
      return "text-emerald-600 dark:text-emerald-400";
    case "mid":
      return "text-amber-600 dark:text-amber-400";
    case "bad":
      return "text-rose-600 dark:text-rose-400";
    default:
      return "text-slate-600 dark:text-slate-400";
  }
}

function fmtUsdSigned(n: number): string {
  const abs = Math.abs(n);
  const s = abs >= 100 ? abs.toFixed(0) : abs.toFixed(2);
  return n >= 0 ? `+$${s}` : `−$${s}`;
}

/** One-line summary for strategy drawer (ratios show — when no trades). */
export function formatPerfSummaryLine(m: StrategyPerformance | null | undefined): string {
  if (!m || m.totalTrades <= 0) return "No closed trades yet";
  const w = `${m.winRatePct.toFixed(0)}%`;
  const pnl = fmtUsdSigned(m.totalPnlUsdt);
  const pf =
    m.profitFactor != null && Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(1) : "—";
  const dd =
    m.maxDrawdownPct != null && Number.isFinite(m.maxDrawdownPct) ? `${m.maxDrawdownPct.toFixed(1)}%` : "—";
  return `W:${w} · PnL:${pnl} · PF:${pf} · DD:${dd}`;
}

export function formatHold(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}
