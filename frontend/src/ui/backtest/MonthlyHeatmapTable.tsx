/**
 * Monthly returns heatmap — rows = year, columns = month. Colour intensity
 * scales with the cell PnL relative to the run's max absolute monthly PnL.
 * Click a month to drill down into a daily heatmap for that month.
 * All calendar bucketing uses UTC (matches backend metrics + trade exit times).
 */
import { useMemo, useState } from "react";
import type { BacktestEquityPoint, BacktestTrade } from "../../types/backtest";
import {
  dailyPnlForMonth,
  dailyReturnPct,
  daysInMonth,
  formatReturnPct,
  monthLabel,
  monthlyReturnPct,
  parseMonthKey,
  resolveMonthlyPnl,
  tradesForDay,
} from "../../lib/backtestPeriodHeatmap";

type Props = {
  monthly: Record<string, number>;
  trades?: BacktestTrade[] | null;
  curve?: BacktestEquityPoint[] | null;
  initialCapital?: number;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function MonthlyHeatmapTable({ monthly, trades, curve, initialCapital = 100 }: Props) {
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const displayMonthly = useMemo(() => resolveMonthlyPnl(monthly, trades), [monthly, trades]);
  const entries = Object.entries(displayMonthly);
  const canDrillDown = Boolean(trades?.length);

  const monthReturnMap = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const [key] of entries) {
      map.set(key, monthlyReturnPct(key, initialCapital, { trades, curve }));
    }
    return map;
  }, [curve, entries, initialCapital, trades]);

  if (!entries.length) {
    return <div className="py-8 text-center text-sm text-slate-500">No monthly data</div>;
  }

  const byYear = new Map<number, Map<number, number>>();
  let maxAbs = 0;
  for (const [k, v] of entries) {
    const parsed = parseMonthKey(k);
    if (!parsed) continue;
    const yMap = byYear.get(parsed.year) ?? new Map<number, number>();
    yMap.set(parsed.monthIndex, Number(v));
    byYear.set(parsed.year, yMap);
    if (Math.abs(Number(v)) > maxAbs) maxAbs = Math.abs(Number(v));
  }
  const years = [...byYear.keys()].sort();

  function toggleMonth(monthKey: string, hasValue: boolean) {
    if (!hasValue || !canDrillDown) return;
    setSelectedMonth((prev) => (prev === monthKey ? null : monthKey));
  }

  return (
    <div className="space-y-4">
      <p className="text-[10px] text-slate-500">
        PnL grouped by trade exit date (UTC). Return % is compounded from equity at each exit.
      </p>
      <div className="overflow-x-auto">
        <table className="text-xs">
          <thead>
            <tr>
              <th className="px-2 py-1 text-left">Year</th>
              {MONTHS.map((m) => (
                <th key={m} className="px-2 py-1 text-center font-mono">
                  {m}
                </th>
              ))}
              <th className="px-2 py-1 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {years.map((y) => {
              const row = byYear.get(y)!;
              let total = 0;
              return (
                <tr key={y}>
                  <td className="px-2 py-1 font-mono">{y}</td>
                  {MONTHS.map((m, i) => {
                    const v = row.get(i);
                    const monthKey = `${y}-${String(i + 1).padStart(2, "0")}`;
                    if (v != null) total += v;
                    const selected = selectedMonth === monthKey;
                    return (
                      <td key={m} className="px-1 py-1 text-center">
                        {v != null ? (
                          <HeatmapCell
                            value={v}
                            returnPct={monthReturnMap.get(monthKey) ?? null}
                            maxAbs={maxAbs}
                            selected={selected}
                            clickable={canDrillDown}
                            onClick={() => toggleMonth(monthKey, true)}
                          />
                        ) : (
                          <span className="text-slate-400">·</span>
                        )}
                      </td>
                    );
                  })}
                  <td className={`px-2 py-1 text-right font-mono ${total >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                    {total.toFixed(2)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {canDrillDown ? (
        <p className="text-[10px] text-slate-500">Click a month cell to show daily PnL below (UTC calendar).</p>
      ) : null}

      {selectedMonth && trades?.length ? (
        <DailyHeatmapTable
          monthKey={selectedMonth}
          monthPnl={displayMonthly[selectedMonth] ?? 0}
          trades={trades}
          curve={curve}
          initialCapital={initialCapital}
          onClose={() => setSelectedMonth(null)}
        />
      ) : null}
    </div>
  );
}

function HeatmapCell({
  value,
  returnPct,
  maxAbs,
  selected,
  clickable,
  onClick,
  title,
}: {
  value: number;
  returnPct: number | null;
  maxAbs: number;
  selected: boolean;
  clickable: boolean;
  onClick: () => void;
  title?: string;
}) {
  const pct = maxAbs > 0 ? Math.min(1, Math.abs(value) / maxAbs) : 0;
  const bg =
    value > 0
      ? `rgba(16, 185, 129, ${0.2 + pct * 0.6})`
      : value < 0
        ? `rgba(244, 63, 94, ${0.2 + pct * 0.6})`
        : "transparent";
  const retLabel = formatReturnPct(returnPct);

  const inner = (
    <>
      <div>{value.toFixed(1)}</div>
      {retLabel ? <div className="text-[9px] leading-tight opacity-90">{retLabel}</div> : null}
    </>
  );

  if (!clickable) {
    return (
      <div className="rounded px-1.5 py-0.5 font-mono" style={{ background: bg }} title={title}>
        {inner}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`w-full rounded px-1.5 py-0.5 font-mono transition ring-offset-1 hover:ring-2 hover:ring-sky-400/60 ${
        selected ? "ring-2 ring-sky-500 dark:ring-sky-400" : ""
      }`}
      style={{ background: bg }}
    >
      {inner}
    </button>
  );
}

function DailyHeatmapTable({
  monthKey,
  monthPnl,
  trades,
  curve,
  initialCapital,
  onClose,
}: {
  monthKey: string;
  monthPnl: number;
  trades: BacktestTrade[];
  curve: BacktestEquityPoint[] | null | undefined;
  initialCapital: number;
  onClose: () => void;
}) {
  const parsed = parseMonthKey(monthKey);
  const dayPnl = useMemo(() => dailyPnlForMonth(trades, monthKey), [trades, monthKey]);

  if (!parsed) return null;

  const { year, monthIndex } = parsed;
  const nDays = daysInMonth(year, monthIndex);
  let maxAbs = 0;
  let dailySum = 0;
  for (const v of dayPnl.values()) {
    dailySum += v;
    if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
  }
  const tradeCount = [...dayPnl.keys()].reduce(
    (n, day) => n + tradesForDay(trades, year, monthIndex, day).length,
    0,
  );

  const firstWeekday = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  const cells: Array<{ day: number | null; pnl: number | null }> = [];
  for (let i = 0; i < firstWeekday; i++) cells.push({ day: null, pnl: null });
  for (let d = 1; d <= nDays; d++) {
    cells.push({ day: d, pnl: dayPnl.has(d) ? dayPnl.get(d)! : null });
  }
  while (cells.length % 7 !== 0) cells.push({ day: null, pnl: null });

  const monthRet = monthlyReturnPct(monthKey, initialCapital, { trades, curve });

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-700 dark:bg-slate-900/40">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">
          Daily heatmap — {monthLabel(monthKey)} (UTC)
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-[10px] text-slate-500 underline hover:text-slate-700 dark:hover:text-slate-300"
        >
          Close
        </button>
      </div>
      <div className="mb-2 text-[10px] text-slate-500">
        {tradeCount} trade{tradeCount === 1 ? "" : "s"} · daily PnL sum {dailySum.toFixed(2)} · month PnL{" "}
        {monthPnl.toFixed(2)}
        {formatReturnPct(monthRet) ? ` · month return ${formatReturnPct(monthRet)}` : ""}
      </div>
      <div className="grid grid-cols-7 gap-1 text-[10px]">
        {WEEKDAYS.map((wd) => (
          <div key={wd} className="px-1 py-0.5 text-center font-medium text-slate-500">
            {wd}
          </div>
        ))}
        {cells.map((cell, idx) => {
          if (cell.day == null) {
            return <div key={`pad-${idx}`} className="min-h-[2.75rem]" />;
          }
          const dayTrades = tradesForDay(trades, year, monthIndex, cell.day);
          const ret = dailyReturnPct(year, monthIndex, cell.day, initialCapital, { trades, curve });
          const tip =
            cell.pnl != null
              ? `${dayTrades.length} trade(s) · exit UTC ${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(cell.day).padStart(2, "0")}`
              : undefined;
          return (
            <div key={cell.day} className="min-h-[2.75rem]">
              {cell.pnl != null ? (
                <div className="flex h-full flex-col">
                  <div className="text-[8px] leading-none text-slate-500">{cell.day}</div>
                  <HeatmapCell
                    value={cell.pnl}
                    returnPct={ret}
                    maxAbs={maxAbs || Math.abs(cell.pnl)}
                    selected={false}
                    clickable={false}
                    onClick={() => {}}
                    title={tip}
                  />
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center rounded border border-dashed border-slate-200 px-1 py-0.5 text-slate-400 dark:border-slate-700">
                  <span className="text-[9px]">{cell.day}</span>
                  <span>·</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
