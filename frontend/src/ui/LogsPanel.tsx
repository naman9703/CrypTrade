import { useAppStore, type LogPayload } from "../ws/store";

/** Activity timestamps match chart crosshair preference: IST (UTC+5:30). */
const LOG_TZ = "Asia/Kolkata";

function logClock(iso: unknown): string {
  let d: Date | null = null;
  if (typeof iso === "string" && iso.length >= 10) {
    d = new Date(iso);
  } else if (typeof iso === "number" && Number.isFinite(iso)) {
    d = new Date(iso);
  }
  if (!d || Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-IN", {
    timeZone: LOG_TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function LogsPanel() {
  const logs = useAppStore((s) => s.logs);

  return (
    <div className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">Activity</div>
          <div className="text-xs text-slate-600 dark:text-slate-400">Realtime decisions + execution logs</div>
        </div>
      </div>

      <div className="max-h-[520px] overflow-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40 p-2">
        {logs.length === 0 ? (
          <div className="px-2 py-3 text-xs text-slate-600 dark:text-slate-500">No logs yet</div>
        ) : (
          <div className="space-y-1 font-mono text-[11px]">
            {logs.map((l, idx) => {
              const skip = new Set(["ts", "level", "msg"]);
              const rest = Object.fromEntries(
                Object.entries(l as Record<string, unknown>).filter(([k]) => !skip.has(k)),
              );
              const restStr = Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : null;
              const cat = String((l as LogPayload).category ?? "").toLowerCase();
              const reason = String((l as LogPayload).reason ?? "");
              const trailRowStart =
                cat === "trailing" &&
                (reason === "trail_sl_replace_started" || reason === "trailing_activation_engaged");
              const trailRowDone =
                cat === "trailing" &&
                (reason === "trail_sl_replace_success" || reason === "trailing_sl_advance");
              return (
                <div
                  key={idx}
                  className={`flex gap-2 rounded px-0.5 py-0.5 ${
                    trailRowStart
                      ? "border border-amber-500/45 bg-amber-500/10"
                      : trailRowDone
                        ? "border border-emerald-500/40 bg-emerald-500/10"
                        : ""
                  }`}
                >
                  <span className="shrink-0 text-slate-600">{logClock(l.ts)}</span>
                  <span
                    className={
                      l.level === "error" ? "text-rose-400" : l.level === "warn" ? "text-amber-300" : "text-slate-700 dark:text-slate-300"
                    }
                  >
                    {String(l.level ?? "info").toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-slate-800 dark:text-slate-200 break-words">
                      <span>{String(l.msg)}</span>
                      {(l as LogPayload).category ? (
                        <span className="rounded bg-slate-800/80 px-1 text-[10px] font-normal text-slate-600 dark:text-slate-400">
                          {(l as LogPayload).category}
                        </span>
                      ) : null}
                    </div>
                    {restStr && restStr !== String(l.msg) ? (
                      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all text-slate-600 dark:text-slate-500">
                        {restStr}
                      </pre>
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

