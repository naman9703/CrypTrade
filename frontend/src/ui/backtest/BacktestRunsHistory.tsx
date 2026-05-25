/**
 * Paginated runs sidebar. Shows status, symbol/tf, return %, dd, sharpe, # trades.
 * Live progress bar reflects WS messages held in `useAppStore.backtestProgress`.
 */
import { useEffect, useState } from "react";
import type { BacktestRunSummary } from "../../types/backtest";
import { api } from "../../api/client";
import { approxBarCount, computeEtaParts, formatDurationSeconds, MIN_PCT_FOR_EXTRAP } from "./backtestEta";

type Props = {
  runs: BacktestRunSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  progress: Record<string, { progressPct: number; status?: string; error?: string }>;
  /** True while any run is queued/running in REST or live WS map (keeps bar ticking). */
  liveActivity: boolean;
  onAfterCancel?: () => void | Promise<void>;
  onAfterDelete?: (id: string) => void | Promise<void>;
};

export function BacktestRunsHistory({
  runs,
  selectedId,
  onSelect,
  progress,
  liveActivity,
  onAfterCancel,
  onAfterDelete,
}: Props) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!liveActivity) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [liveActivity]);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-2 shadow-sm dark:border-slate-800 dark:bg-slate-950/60">
      <div className="px-2 pb-2 text-sm font-semibold">Runs ({runs.length})</div>
      <div className="max-h-[60vh] space-y-1 overflow-y-auto pr-1">
        {runs.length === 0 && <div className="px-3 py-4 text-xs text-slate-500">No runs yet</div>}
        {runs.map((r) => {
          const live = progress[r.id];
          const isTerminalRest = r.status === "done" || r.status === "failed" || r.status === "cancelled";
          const status = isTerminalRest ? r.status : (live?.status ?? r.status);
          const pctRaw = Number(live?.progressPct ?? r.progressPct ?? 0);
          const pct = Math.min(100, Math.max(0, Number.isFinite(pctRaw) ? pctRaw : 0));
          const failMsg = status === "failed" ? (live?.error ?? r.error ?? "").trim() : "";
          const isSelected = r.id === selectedId;
          const active = !isTerminalRest && (status === "running" || status === "queued");

          return (
            <button
              key={r.id}
              type="button"
              onClick={() => onSelect(r.id)}
              className={`w-full rounded-md border px-2 py-1.5 text-left text-xs transition-colors ${
                isSelected
                  ? "border-sky-400 bg-sky-50 dark:border-sky-700 dark:bg-sky-950/40"
                  : "border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="truncate font-mono text-[11px] text-slate-500">{r.symbol} · {r.timeframe}</div>
                <StatusPill status={status} />
              </div>
              <div className="truncate pt-0.5">
                {r.label || (r.engineType ?? "—")}
              </div>
              <div className="grid grid-cols-3 gap-1 pt-0.5 text-[10px] text-slate-500">
                <Stat label="Trades" value={r.totalTrades != null ? String(r.totalTrades) : "—"} />
                <Stat label="Ret %" value={r.metrics?.totalReturnPct != null ? `${r.metrics.totalReturnPct.toFixed(1)}` : "—"} />
                <Stat label="DD %" value={r.maxDrawdownPct != null ? `${r.maxDrawdownPct.toFixed(1)}` : "—"} />
              </div>
              {active ? (
                <RunProgressRow status={status} pct={pct} run={r} nowMs={nowMs} />
              ) : null}
              {failMsg ? (
                <div className="mt-1 line-clamp-3 rounded bg-rose-50 px-1.5 py-1 text-left text-[10px] text-rose-800 dark:bg-rose-950/40 dark:text-rose-200" title={failMsg}>
                  {failMsg}
                </div>
              ) : null}
              {active && (
                <div className="flex justify-end gap-2 pt-1">
                  {status === "queued" && (
                    <button
                      type="button"
                      onClick={async (e) => {
                        e.stopPropagation();
                        try {
                          await api.requeueBacktestRun(r.id);
                        } catch {
                          /* ignore */
                        }
                        await onAfterCancel?.();
                      }}
                      className="text-[10px] text-sky-600 hover:underline dark:text-sky-400"
                      title="Re-enqueue if stuck after API restart"
                    >
                      Retry queue
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        await api.cancelBacktestRun(r.id);
                      } catch {
                        /* ignore */
                      }
                      await onAfterCancel?.();
                    }}
                    className="text-[10px] text-rose-600 hover:underline dark:text-rose-400"
                  >
                    Cancel
                  </button>
                </div>
              )}
              {(status === "done" || status === "failed" || status === "cancelled") && (
                <div className="flex justify-end pt-1">
                  <button
                    type="button"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (!confirm("Delete this run?")) return;
                      try {
                        await api.deleteBacktestRun(r.id);
                      } catch {
                        /* ignore */
                      }
                      await onAfterDelete?.(r.id);
                    }}
                    className="text-[10px] text-slate-500 hover:underline dark:text-slate-400"
                  >
                    Delete
                  </button>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RunProgressRow({
  status,
  pct,
  run,
  nowMs,
}: {
  status: string;
  pct: number;
  run: BacktestRunSummary;
  nowMs: number;
}) {
  const indeterminate = status === "queued" && pct < 0.5;
  const phaseLabel =
    status === "queued"
      ? "Waiting in queue…"
      : pct < 2
        ? "Loading data & signals…"
        : "Simulating…";
  const barFill = indeterminate ? 100 : Math.min(100, Math.max(0, pct));
  /** Tiny visible sliver when there is progress but &lt; ~1% so the bar still reads as "live". */
  const barW = indeterminate ? 100 : barFill < 0.15 && barFill > 0 ? 0.15 : barFill;

  const pctLabel = indeterminate ? "—" : `${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`;

  const bars = approxBarCount(run.startDate, run.endDate, run.timeframe);
  const anchor = run.startedAt ?? run.createdAt;
  const { remainingSec, roughTotalSec } = computeEtaParts(pct, anchor, nowMs, bars, run.engineType);
  const elapsedSec =
    anchor && Number.isFinite(Date.parse(anchor)) ? Math.max(0, (nowMs - Date.parse(anchor)) / 1000) : 0;
  const totalEstSec = remainingSec != null ? elapsedSec + remainingSec : null;

  let etaLine: string;
  if (status === "queued") {
    etaLine =
      bars > 0
        ? `Typical duration ~${formatDurationSeconds(roughTotalSec)} (rough) · queue wait extra`
        : "Estimating duration…";
  } else if (remainingSec != null && totalEstSec != null) {
    etaLine = `~${formatDurationSeconds(remainingSec)} left · ~${formatDurationSeconds(totalEstSec)} total (est.)`;
  } else {
    etaLine =
      bars > 0
        ? `Typical ~${formatDurationSeconds(roughTotalSec)} (rough) · refined ETA after ~${MIN_PCT_FOR_EXTRAP}%`
        : "Estimating duration…";
  }

  return (
    <div className="mt-1.5 space-y-0.5">
      <div className="flex items-center justify-between gap-2 text-[10px] text-slate-600 dark:text-slate-400">
        <span className="flex min-w-0 items-center gap-1">
          <Spinner className="h-3 w-3 shrink-0 text-sky-600 dark:text-sky-400" />
          <span className="truncate">{phaseLabel}</span>
        </span>
        <span className="shrink-0 font-mono tabular-nums text-slate-700 dark:text-slate-200">
          {pctLabel}
        </span>
      </div>
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        {indeterminate ? (
          <div className="h-full w-full animate-pulse rounded-full bg-sky-400/55 dark:bg-sky-500/45" />
        ) : (
          <div
            className="h-full rounded-full bg-sky-500 ease-out will-change-[width]"
            style={{ width: `${barW}%`, transition: "width 120ms ease-out" }}
          />
        )}
      </div>
      <div className="pt-0.5 text-[9px] leading-snug text-slate-500 dark:text-slate-400" title="Rough guess uses bar count and engine type; refined ETA uses elapsed time and progress %.">
        {etaLine}
      </div>
    </div>
  );
}

function Spinner({ className }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className ?? ""}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "done"
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
      : status === "failed"
        ? "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300"
        : status === "cancelled"
          ? "bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
          : status === "running"
            ? "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
            : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
  return <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${tone}`}>{status}</span>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="leading-tight">
      <div className="text-[9px] uppercase">{label}</div>
      <div className="font-mono text-slate-700 dark:text-slate-200">{value}</div>
    </div>
  );
}
