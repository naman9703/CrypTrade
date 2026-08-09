import { useMemo } from "react";
import { normalizeSym } from "../lib/symbolPriceSanity";
import { tradingModeToApiModeSlug } from "../lib/tradingModeSlug";
import {
  activeInstanceIdForMode,
  findInstanceInState,
  resolveStrategyVersionForInstance,
} from "../lib/instanceConfigView";
import { effectiveInstanceSymbol } from "../lib/backtestInstanceConfig";
import { useAppStore, type LogPayload } from "../ws/store";
import { logInstanceId, logSharedAcrossInstances } from "./instances/InstanceSessionSummary";

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

function logTouchesSymbol(l: LogPayload, symU: string): boolean {
  if (!symU) return false;
  const top = (l as Record<string, unknown>).symbol;
  if (typeof top === "string" && normalizeSym(top) === symU) return true;
  const d = l.detail;
  if (d && typeof d === "object" && !Array.isArray(d)) {
    const ds = (d as Record<string, unknown>).symbol;
    if (typeof ds === "string" && normalizeSym(ds) === symU) return true;
  }
  return false;
}

function logIsModeLifecycle(l: LogPayload): boolean {
  const cat = String(l.category ?? "").toLowerCase();
  if (cat === "bot_lifecycle" || cat === "session") return true;
  const msg = String(l.msg ?? "").toLowerCase();
  return msg.includes("bot ") && (msg.includes("start") || msg.includes("stop"));
}

export function LogsPanel() {
  const logs = useAppStore((s) => s.logs);
  const mainView = useAppStore((s) => s.mainView);
  const mode = useAppStore((s) => s.mode);
  const modeSlug = tradingModeToApiModeSlug(mode);
  const chartDisplaySymbol = useAppStore((s) => s.chartDisplaySymbol);
  const botSymbol = useAppStore((s) => s.bot?.symbol as string | undefined);
  const instancesByMode = useAppStore((s) => s.instancesByMode);
  const strategiesByMode = useAppStore((s) => s.strategiesByMode);
  const versionsByStrategyId = useAppStore((s) => s.versionsByStrategyId);

  const activeInstanceByMode = useAppStore((s) => s.activeInstanceByMode);
  const selectedInstanceId = useAppStore((s) => s.selectedInstanceId);
  const instanceConfigLoadingId = useAppStore((s) => s.instanceConfigLoadingId);

  const instanceFilter = useMemo(() => {
    if (mainView !== "instance") return null;
    const instanceId = activeInstanceIdForMode(
      { activeInstanceByMode, selectedInstanceId, instanceConfigLoadingId, mainView },
      modeSlug,
    );
    if (!instanceId) return null;
    const instance = findInstanceInState(
      { instancesByMode, strategiesByMode, versionsByStrategyId, activeInstanceByMode },
      modeSlug,
      instanceId,
    );
    if (!instance) return null;
    const version = resolveStrategyVersionForInstance(
      { instancesByMode, strategiesByMode, versionsByStrategyId, activeInstanceByMode },
      modeSlug,
      instance,
    );
    const symbol = normalizeSym(effectiveInstanceSymbol(instance, version) || String(instance.operational?.symbol ?? ""));
    const isActiveForMode = String(activeInstanceByMode?.[modeSlug] ?? "") === instanceId;
    return { instanceId, symbol, label: instance.label || instanceId.slice(0, 8), isActiveForMode };
  }, [
    mainView,
    modeSlug,
    activeInstanceByMode,
    selectedInstanceId,
    instanceConfigLoadingId,
    instancesByMode,
    strategiesByMode,
    versionsByStrategyId,
  ]);

  const sortedLogs = useMemo(() => {
    if (instanceFilter?.instanceId) {
      const { instanceId, isActiveForMode } = instanceFilter;
      return logs.filter((row) => {
        // Main bot on/off is mode-wide — show on every instance.
        if (logSharedAcrossInstances(row)) return true;
        const iid = logInstanceId(row);
        if (iid) return iid === instanceId;
        // Untagged legacy rows: never show other instances' signal/execution noise.
        // Only allow mode lifecycle lines while this instance is the active binding
        // (those events historically applied to the active instance).
        if (logIsModeLifecycle(row)) return isActiveForMode;
        return false;
      });
    }

    const pri = normalizeSym(chartDisplaySymbol ?? "") || normalizeSym(botSymbol ?? "");
    if (!pri) return logs;
    const a: LogPayload[] = [];
    const b: LogPayload[] = [];
    for (const row of logs) {
      if (logTouchesSymbol(row, pri)) a.push(row);
      else b.push(row);
    }
    return [...a, ...b];
  }, [logs, chartDisplaySymbol, botSymbol, instanceFilter]);

  return (
    <div className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">Activity</div>
          <div className="text-xs text-slate-600 dark:text-slate-400">
            {instanceFilter
              ? `Instance-only · ${instanceFilter.label} · ${instanceFilter.symbol || "—"}`
              : "Realtime decisions + execution logs"}
          </div>
        </div>
      </div>

      <div className="max-h-[520px] overflow-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40 p-2">
        {sortedLogs.length === 0 ? (
          <div className="px-2 py-3 text-xs text-slate-600 dark:text-slate-500">
            {instanceFilter ? "No activity for this instance yet" : "No logs yet"}
          </div>
        ) : (
          <div className="space-y-1 font-mono text-[11px]">
            {sortedLogs.map((l, idx) => {
              const lid = (l as Record<string, unknown>)._lid;
              const rowKey = typeof lid === "number" ? String(lid) : `${String(l.ts)}:${idx}`;
              const skip = new Set(["ts", "level", "msg", "_lid"]);
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
                  key={rowKey}
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
