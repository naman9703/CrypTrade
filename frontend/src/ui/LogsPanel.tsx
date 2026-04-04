import { useAppStore } from "../ws/store";

export function LogsPanel() {
  const logs = useAppStore((s) => s.logs);

  return (
    <div className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">Activity</div>
          <div className="text-xs text-slate-400">Realtime decisions + execution logs</div>
        </div>
      </div>

      <div className="max-h-[260px] overflow-auto rounded-lg border border-slate-800 bg-slate-950/40 p-2">
        {logs.length === 0 ? (
          <div className="px-2 py-3 text-xs text-slate-500">No logs yet</div>
        ) : (
          <div className="space-y-1 font-mono text-[11px]">
            {logs.map((l, idx) => {
              const raw = (l as { detail?: unknown; error?: unknown }).detail ?? (l as { error?: unknown }).error;
              const extra =
                raw != null && typeof raw === "object"
                  ? JSON.stringify(raw)
                  : raw != null
                    ? String(raw)
                    : null;
              return (
                <div key={idx} className="flex gap-2">
                  <span className="shrink-0 text-slate-600">{l.ts.slice(11, 19)}</span>
                  <span
                    className={
                      l.level === "error" ? "text-rose-400" : l.level === "warn" ? "text-amber-300" : "text-slate-300"
                    }
                  >
                    {l.level.toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-slate-200 break-words">{l.msg}</div>
                    {extra && extra !== l.msg ? (
                      <div className="mt-0.5 break-all text-slate-500">{extra}</div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

