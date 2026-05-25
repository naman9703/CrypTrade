/**
 * In-panel activity feed: only rows tagged `category: "backtest"` from the global WS log stream.
 */
import { useMemo } from "react";
import { useAppStore, type LogPayload } from "../../ws/store";

function clock(iso: unknown): string {
  if (typeof iso !== "string" || iso.length < 10) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function BacktestActivityPanel() {
  const logs = useAppStore((s) => s.logs);
  const rows = useMemo(() => {
    const out: Array<{ ts: string } & LogPayload> = [];
    for (const l of logs) {
      if (String((l as LogPayload).category ?? "").toLowerCase() === "backtest") out.push(l as { ts: string } & LogPayload);
    }
    return out.slice(0, 25);
  }, [logs]);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-2 shadow-sm dark:border-slate-800 dark:bg-slate-950/60">
      <div className="px-2 pb-1.5 text-sm font-semibold">Backtest activity</div>
      <div className="text-[10px] text-slate-500 dark:text-slate-400 px-2 pb-2">
        Queued runs, completions, and failures (mirrors the main Activity feed with the backtest tag).
      </div>
      <div className="max-h-[220px] overflow-y-auto rounded-lg border border-slate-100 bg-slate-50/80 p-1.5 dark:border-slate-800 dark:bg-slate-900/30">
        {rows.length === 0 ? (
          <div className="px-2 py-3 text-xs text-slate-500">No backtest events yet — start a run while connected.</div>
        ) : (
          <div className="space-y-1 font-mono text-[10px]">
            {rows.map((l, idx) => {
              const lid = (l as Record<string, unknown>)._lid;
              const key = typeof lid === "number" ? `bt-${lid}` : `bt-${String(l.ts)}-${idx}`;
              return (
                <div key={key} className="flex gap-1.5 rounded px-1 py-0.5 text-slate-800 dark:text-slate-200">
                  <span className="shrink-0 text-slate-500">{clock(l.ts)}</span>
                  <span className={l.level === "error" ? "text-rose-600 dark:text-rose-400" : ""}>{l.msg}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
