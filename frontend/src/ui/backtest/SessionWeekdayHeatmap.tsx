import type { BacktestTrade } from "../../types/backtest";
import { ICT_BACKTEST_SESSIONS } from "../../lib/ictSessions";
import {
  breakdownSessionWeekdayHeatmap,
  weekdayLabel,
} from "../../lib/backtestSessionStats";

type Props = {
  trades: BacktestTrade[];
  /** Portfolio runs: optional coin filter label in title. */
  title?: string;
};

function cellBg(winPct: number, total: number): string {
  if (total === 0) return "bg-slate-50 dark:bg-slate-900/40";
  if (winPct >= 60) return "bg-emerald-100 dark:bg-emerald-950/50";
  if (winPct >= 45) return "bg-amber-50 dark:bg-amber-950/40";
  return "bg-rose-50 dark:bg-rose-950/40";
}

export function SessionWeekdayHeatmap({ trades, title }: Props) {
  const cells = breakdownSessionWeekdayHeatmap(trades);
  if (!trades.length) return null;

  const cellMap = new Map<string, (typeof cells)[0]>();
  for (const c of cells) cellMap.set(`${c.sessionId}:${c.weekday}`, c);

  return (
    <div className="space-y-1">
      {title ? <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">{title}</div> : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-[10px]">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="px-1 py-1">Session</th>
              {[0, 1, 2, 3, 4, 5, 6].map((wd) => (
                <th key={wd} className="px-1 py-1 text-center font-normal">
                  {weekdayLabel(wd)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ICT_BACKTEST_SESSIONS.map((session) => (
              <tr key={session.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-1 py-1 font-medium text-slate-700 dark:text-slate-300">{session.label}</td>
                {[0, 1, 2, 3, 4, 5, 6].map((wd) => {
                  const c = cellMap.get(`${session.id}:${wd}`);
                  const total = c?.total ?? 0;
                  const winPct = c?.winPct ?? 0;
                  return (
                    <td
                      key={wd}
                      className={`px-1 py-1 text-center align-middle ${cellBg(winPct, total)}`}
                      title={
                        total > 0
                          ? `${total} trades · ${winPct.toFixed(0)}% WR · ${(c?.netPnlUsdt ?? 0).toFixed(2)} USDT`
                          : "No trades"
                      }
                    >
                      {total > 0 ? (
                        <span className="font-mono">
                          {winPct.toFixed(0)}%
                          <span className="block text-[9px] text-slate-500">n={total}</span>
                        </span>
                      ) : (
                        <span className="text-slate-300 dark:text-slate-600">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
