import { useMemo, useState } from "react";
import { clsx } from "clsx";
import type { PerformanceCompareRow } from "../../types/performance";
import type { BotInstance } from "../../types/instance";
import {
  toneClass,
  toneMaxDrawdown,
  toneProfitFactor,
  toneWinRate,
} from "../../lib/performanceMetricsUi";

export type SortKey =
  | "strategy"
  | "wl"
  | "pnl"
  | "pf"
  | "dd"
  | "sharpe"
  | "trades";

type Props = {
  rows: PerformanceCompareRow[];
  activeVersionId: string | null;
  onSelectRow: (strategyId: string, versionId: string) => void;
  /** When provided, rows with a matching instance show an Enter button. */
  instances?: BotInstance[];
  onEnterInstance?: (instanceId: string) => void;
};

function fmtWl(m: PerformanceCompareRow["metrics"]): string {
  if (!m || m.totalTrades <= 0) return "—";
  return `${m.winRatePct.toFixed(0)}% (${m.winningTrades}/${m.totalTrades})`;
}

function fmtPnl(m: PerformanceCompareRow["metrics"]): string {
  if (!m || m.totalTrades <= 0) return "—";
  const n = m.totalPnlUsdt;
  const abs = Math.abs(n);
  const s = abs >= 100 ? abs.toFixed(0) : abs.toFixed(2);
  return n >= 0 ? `+$${s}` : `−$${s}`;
}

function fmtPf(m: PerformanceCompareRow["metrics"]): string {
  if (!m || m.totalTrades <= 0) return "—";
  if (m.profitFactor == null || !Number.isFinite(m.profitFactor)) return "—";
  return m.profitFactor.toFixed(2);
}

function fmtDd(m: PerformanceCompareRow["metrics"]): string {
  if (!m || m.totalTrades <= 0) return "—";
  if (m.maxDrawdownPct == null || !Number.isFinite(m.maxDrawdownPct)) return "—";
  return `${m.maxDrawdownPct.toFixed(1)}%`;
}

function fmtSharpe(m: PerformanceCompareRow["metrics"]): string {
  if (!m || m.totalTrades <= 0) return "—";
  if (m.sharpeRatio == null || !Number.isFinite(m.sharpeRatio)) return "—";
  return m.sharpeRatio.toFixed(2);
}

export function StrategyComparisonTable({ rows, activeVersionId, onSelectRow, instances, onEnterInstance }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("pnl");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const sorted = useMemo(() => {
    const mult = sortDir === "asc" ? 1 : -1;
    const list = rows.slice();
    list.sort((a, b) => {
      const ma = a.metrics;
      const mb = b.metrics;
      const numTrades = (m: typeof ma) => (m && m.totalTrades > 0 ? m.totalTrades : 0);
      switch (sortKey) {
        case "strategy": {
          const sa = `${a.strategyName} v${a.versionNumber}`;
          const sb = `${b.strategyName} v${b.versionNumber}`;
          return mult * sa.localeCompare(sb);
        }
        case "wl":
          return mult * ((ma?.winRatePct ?? -1) - (mb?.winRatePct ?? -1));
        case "pnl":
          return mult * ((ma?.totalPnlUsdt ?? 0) - (mb?.totalPnlUsdt ?? 0));
        case "pf":
          return mult * ((ma?.profitFactor ?? -1) - (mb?.profitFactor ?? -1));
        case "dd":
          return mult * ((ma?.maxDrawdownPct ?? 999) - (mb?.maxDrawdownPct ?? 999));
        case "sharpe":
          return mult * ((ma?.sharpeRatio ?? -999) - (mb?.sharpeRatio ?? -999));
        case "trades":
          return mult * (numTrades(ma) - numTrades(mb));
        default:
          return 0;
      }
    });
    return list;
  }, [rows, sortKey, sortDir]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir(k === "strategy" ? "asc" : "desc");
    }
  }

  function th(k: SortKey, label: string) {
    return (
      <th className="cursor-pointer select-none px-2 py-2 text-left font-medium hover:bg-slate-100 dark:hover:bg-slate-800/80">
        <button type="button" className="w-full text-left" onClick={() => toggleSort(k)}>
          {label}
          {sortKey === k ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
        </button>
      </th>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
      <table className="w-full min-w-[640px] border-collapse text-left text-xs">
        <thead className="border-b border-slate-200 bg-slate-50 text-[10px] uppercase text-slate-500 dark:border-slate-700 dark:bg-slate-900/50">
          <tr>
            {th("strategy", "Strategy")}
            {th("wl", "W / L")}
            {th("pnl", "PnL")}
            {th("pf", "PF")}
            {th("dd", "Max DD")}
            {th("sharpe", "Sharpe")}
            {th("trades", "Trades")}
            {onEnterInstance ? <th className="px-2 py-2" /> : null}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const m = row.metrics;
            const active = activeVersionId === row.versionId;
            const wTone = toneWinRate(m?.winRatePct);
            const pTone = toneProfitFactor(m?.profitFactor);
            const dTone = toneMaxDrawdown(m?.maxDrawdownPct);
            const matchedInstance = instances?.find((i) => i.strategyVersionId === row.versionId) ?? null;
            return (
              <tr
                key={`${row.strategyId}-${row.versionId}`}
                className={clsx(
                  "cursor-pointer border-b border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900/40",
                  active && "bg-sky-50 dark:bg-sky-950/30",
                )}
                onClick={() => onSelectRow(row.strategyId, row.versionId)}
              >
                <td className="px-2 py-2 font-medium text-slate-800 dark:text-slate-100">
                  {row.strategyName} v{row.versionNumber}
                  {active ? <span className="ml-1 text-amber-500">★</span> : null}
                  {row.label ? (
                    <span className="block text-[10px] font-normal text-slate-500">{row.label}</span>
                  ) : null}
                </td>
                <td className={clsx("px-2 py-2 font-mono tabular-nums", toneClass(wTone))}>{fmtWl(m)}</td>
                <td
                  className={clsx(
                    "px-2 py-2 font-mono tabular-nums",
                    m && m.totalTrades > 0
                      ? m.totalPnlUsdt >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-rose-600 dark:text-rose-400"
                      : "text-slate-500",
                  )}
                >
                  {fmtPnl(m)}
                </td>
                <td className={clsx("px-2 py-2 font-mono tabular-nums", toneClass(pTone))}>{fmtPf(m)}</td>
                <td className={clsx("px-2 py-2 font-mono tabular-nums", toneClass(dTone))}>{fmtDd(m)}</td>
                <td className="px-2 py-2 font-mono tabular-nums text-slate-700 dark:text-slate-300">{fmtSharpe(m)}</td>
                <td className="px-2 py-2 font-mono tabular-nums text-slate-600 dark:text-slate-400">
                  {m && m.totalTrades > 0 ? m.totalTrades : "—"}
                </td>
                {onEnterInstance ? (
                  <td className="px-2 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                    {matchedInstance ? (
                      <button
                        type="button"
                        className="rounded border border-sky-500/60 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700 hover:bg-sky-500/20 dark:text-sky-300"
                        title={`Enter instance: ${matchedInstance.label || matchedInstance.id}`}
                        onClick={() => onEnterInstance(matchedInstance.id)}
                      >
                        Enter ▶
                      </button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 ? (
        <p className="p-3 text-xs text-slate-500">No strategies for this mode — create one in the sidebar.</p>
      ) : null}
    </div>
  );
}
