import { useCallback, useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import { tradingModeToApiModeSlug } from "../../lib/tradingModeSlug";
import {
  activeInstanceIdForMode,
  findInstanceInState,
  resolveStrategyVersionForInstance,
} from "../../lib/instanceConfigView";
import { effectiveInstanceSymbol } from "../../lib/backtestInstanceConfig";
import { api } from "../../api/client";
import type { InstanceStatusLogEntry } from "../../types/instance";
import { useAppStore, type LogPayload } from "../../ws/store";

const LOG_TZ = "Asia/Kolkata";

function relTime(iso: string | null | undefined) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtClock(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    timeZone: LOG_TZ,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function logInstanceId(l: LogPayload): string {
  const top = (l as Record<string, unknown>).instanceId;
  if (typeof top === "string" && top.trim()) return top.trim();
  const d = l.detail;
  if (d && typeof d === "object" && !Array.isArray(d)) {
    const iid = (d as Record<string, unknown>).instanceId;
    if (typeof iid === "string" && iid.trim()) return iid.trim();
  }
  return "";
}

/** Main bot on/off (and similar mode-wide session events) should appear on every instance. */
function logSharedAcrossInstances(l: LogPayload): boolean {
  const rec = l as Record<string, unknown>;
  if (rec.sharedAcrossInstances === true) return true;
  if (String(rec.scope ?? "").toLowerCase() === "mode") return true;
  const d = l.detail;
  if (d && typeof d === "object" && !Array.isArray(d)) {
    const det = d as Record<string, unknown>;
    if (det.sharedAcrossInstances === true) return true;
  }
  const reason = String(l.reason ?? "").toLowerCase();
  if (reason === "main_switch_on" || reason === "session_disarmed_main") return true;
  const cat = String(l.category ?? "").toLowerCase();
  if (cat === "bot_lifecycle") {
    const msg = String(l.msg ?? "").toLowerCase();
    if (msg.includes("bot started") || msg.includes("bot stopped")) return true;
  }
  return false;
}

/**
 * Per-instance session summary: whether main + instance switches are both ON,
 * why entries may be blocked, and this instance’s status / session log.
 */
export function InstanceSessionSummary() {
  const mainView = useAppStore((s) => s.mainView);
  const mode = useAppStore((s) => s.mode);
  const modeSlug = tradingModeToApiModeSlug(mode);
  const runningByMode = useAppStore((s) => s.runningByMode);
  const instancesByMode = useAppStore((s) => s.instancesByMode);
  const strategiesByMode = useAppStore((s) => s.strategiesByMode);
  const versionsByStrategyId = useAppStore((s) => s.versionsByStrategyId);
  const activeInstanceByMode = useAppStore((s) => s.activeInstanceByMode);
  const selectedInstanceId = useAppStore((s) => s.selectedInstanceId);
  const instanceConfigLoadingId = useAppStore((s) => s.instanceConfigLoadingId);
  const logs = useAppStore((s) => s.logs);
  const botPaused = useAppStore((s) => Boolean((s.bot as { paused?: boolean } | null)?.paused));

  const [statusLog, setStatusLog] = useState<InstanceStatusLogEntry[]>([]);

  const ctx = useMemo(() => {
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
    const symbol = effectiveInstanceSymbol(instance, version) || String(instance.operational?.symbol ?? "—");
    const tm = String(mode || "PAPER").toUpperCase() as keyof typeof runningByMode;
    const mainOn = Boolean(runningByMode?.[tm]);
    const st = String(instance.status || "").toLowerCase();
    const instanceOn = st === "running";
    const sessionArmed = mainOn && instanceOn && !botPaused;
    const activeForMode = String(activeInstanceByMode?.[modeSlug] ?? "") === instanceId;
    return {
      instanceId,
      instance,
      symbol,
      label: instance.label || instanceId.slice(0, 8),
      mainOn,
      instanceOn,
      sessionArmed,
      status: st,
      activeForMode,
      lastStartAt: instance.lastStartAt,
      lastStopAt: instance.lastStopAt,
      lastStopReason: instance.lastStopReason,
    };
  }, [
    mainView,
    mode,
    modeSlug,
    runningByMode,
    instancesByMode,
    strategiesByMode,
    versionsByStrategyId,
    activeInstanceByMode,
    selectedInstanceId,
    instanceConfigLoadingId,
    botPaused,
  ]);

  const loadLog = useCallback(async () => {
    if (!ctx?.instanceId) {
      setStatusLog([]);
      return;
    }
    try {
      const entries = await api.getInstanceStatusLog(ctx.instanceId, 40);
      setStatusLog(entries);
    } catch {
      setStatusLog([]);
    }
  }, [ctx?.instanceId]);

  useEffect(() => {
    void loadLog();
  }, [loadLog, ctx?.status, ctx?.lastStartAt, ctx?.lastStopAt]);

  /** Session activity lines tagged for this instance (signals / skips / session lifecycle). */
  const sessionActivity = useMemo(() => {
    if (!ctx?.instanceId) return [];
    return logs
      .filter((row) => {
        if (logSharedAcrossInstances(row)) {
          const cat = String(row.category ?? "").toLowerCase();
          return cat === "session" || cat === "bot_lifecycle";
        }
        const iid = logInstanceId(row);
        if (iid !== ctx.instanceId) return false;
        const cat = String(row.category ?? "").toLowerCase();
        return (
          cat === "session" ||
          cat === "signal" ||
          cat === "bot_lifecycle" ||
          cat === "risk" ||
          cat === "execution" ||
          cat === "feed"
        );
      })
      .slice(0, 25);
  }, [logs, ctx?.instanceId]);

  if (!ctx) return null;

  const blockReason = !ctx.mainOn
    ? "Main bot switch is OFF — engine not ticking; no signals will fire for this mode."
    : !ctx.instanceOn
      ? ctx.status === "paused"
        ? "Instance switch is OFF (paused) — main engine is on, but new entries are blocked for this instance."
        : `Instance status is “${ctx.status}” — not armed for entries.`
      : botPaused
        ? "Bot is paused in engine state — entries blocked."
        : !ctx.activeForMode
          ? "This instance is not the active engine binding for the mode — another instance owns the live session."
          : null;

  return (
    <div className="p-4">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">Session summary</div>
          <div className="text-xs text-slate-600 dark:text-slate-400">
            {ctx.label} · {ctx.symbol} · diagnose misses (bot off vs signal/execution)
          </div>
        </div>
        <div
          className={clsx(
            "rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide",
            ctx.sessionArmed
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
              : "bg-amber-500/15 text-amber-800 dark:text-amber-200",
          )}
        >
          {ctx.sessionArmed ? "Session armed" : "Not armed"}
        </div>
      </div>

      <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-2.5 dark:border-slate-700 dark:bg-slate-900/40">
          <div className="text-[10px] font-medium uppercase text-slate-500">Main switch</div>
          <div className={clsx("mt-0.5 text-sm font-semibold", ctx.mainOn ? "text-emerald-600" : "text-slate-500")}>
            {ctx.mainOn ? "ON" : "OFF"}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-2.5 dark:border-slate-700 dark:bg-slate-900/40">
          <div className="text-[10px] font-medium uppercase text-slate-500">Instance switch</div>
          <div className={clsx("mt-0.5 text-sm font-semibold", ctx.instanceOn ? "text-emerald-600" : "text-slate-500")}>
            {ctx.instanceOn ? "ON" : "OFF"}
            <span className="ml-1 text-[10px] font-normal uppercase text-slate-500">({ctx.status})</span>
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-2.5 dark:border-slate-700 dark:bg-slate-900/40">
          <div className="text-[10px] font-medium uppercase text-slate-500">Session started</div>
          <div className="mt-0.5 font-mono text-xs text-slate-800 dark:text-slate-200">
            {ctx.sessionArmed || ctx.instanceOn ? fmtClock(ctx.lastStartAt) : "—"}
          </div>
          <div className="text-[10px] text-slate-500">{relTime(ctx.lastStartAt)}</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-2.5 dark:border-slate-700 dark:bg-slate-900/40">
          <div className="text-[10px] font-medium uppercase text-slate-500">Last stop</div>
          <div className="mt-0.5 font-mono text-xs text-slate-800 dark:text-slate-200">
            {ctx.lastStopAt ? fmtClock(ctx.lastStopAt) : "—"}
          </div>
          <div className="truncate text-[10px] text-slate-500" title={ctx.lastStopReason ?? undefined}>
            {ctx.lastStopReason || relTime(ctx.lastStopAt)}
          </div>
        </div>
      </div>

      {blockReason ? (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50/90 px-3 py-2 text-xs text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/35 dark:text-amber-100">
          <span className="font-semibold">Why trades may not place: </span>
          {blockReason}
        </div>
      ) : (
        <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50/90 px-3 py-2 text-xs text-emerald-950 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-100">
          Main + instance switches are ON. If no trade appears after a signal, check instance activity below for skips /
          execution errors (not a switch issue).
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Instance status log
          </h4>
          <ul className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-slate-100/80 p-2 text-xs dark:border-slate-800 dark:bg-slate-950/40">
            {statusLog.length === 0 ? (
              <li className="px-1 py-2 text-slate-500">No status transitions yet</li>
            ) : (
              statusLog.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap gap-2 border-b border-slate-200/80 py-1 last:border-0 dark:border-slate-800"
                >
                  <span
                    className={clsx(
                      "font-medium",
                      row.toStatus === "running" && "text-emerald-600",
                      row.toStatus === "paused" && "text-amber-600",
                      row.toStatus === "stopped" && "text-slate-500",
                      row.toStatus === "error" && "text-rose-600",
                    )}
                  >
                    {row.toStatus}
                  </span>
                  <span className="text-slate-600 dark:text-slate-400">{row.reason ?? "—"}</span>
                  <span className="ml-auto text-slate-400">{relTime(row.createdAt)}</span>
                </li>
              ))
            )}
          </ul>
        </div>
        <div>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Session / signal log (this instance)
          </h4>
          <ul className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-slate-100/80 p-2 font-mono text-[11px] dark:border-slate-800 dark:bg-slate-950/40">
            {sessionActivity.length === 0 ? (
              <li className="px-1 py-2 font-sans text-xs text-slate-500">
                No tagged session/signal lines yet for this instance
              </li>
            ) : (
              sessionActivity.map((l, idx) => {
                const lid = (l as Record<string, unknown>)._lid;
                const key = typeof lid === "number" ? String(lid) : `${String(l.ts)}:${idx}`;
                return (
                  <li key={key} className="border-b border-slate-200/80 py-1 last:border-0 dark:border-slate-800">
                    <span className="text-slate-500">{fmtClock(typeof l.ts === "string" ? l.ts : null)} </span>
                    <span
                      className={
                        l.level === "error"
                          ? "text-rose-500"
                          : l.level === "warn"
                            ? "text-amber-500"
                            : "text-slate-800 dark:text-slate-200"
                      }
                    >
                      {String(l.msg)}
                    </span>
                    {l.category ? (
                      <span className="ml-1 rounded bg-slate-800/70 px-1 text-[9px] text-slate-400">{l.category}</span>
                    ) : null}
                  </li>
                );
              })
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}

export { logInstanceId, logSharedAcrossInstances };
