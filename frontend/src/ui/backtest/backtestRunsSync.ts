import type { BacktestRunSummary } from "../../types/backtest";
import { useAppStore } from "../../ws/store";

type ProgressEntry = { progressPct: number; status?: string; error?: string };

/** Apply REST run rows into the WS progress map only when values change (avoids poll loops). */
export function syncBacktestProgressFromRunList(list: BacktestRunSummary[]): void {
  const setBacktestProgress = useAppStore.getState().setBacktestProgress;
  const liveMap = useAppStore.getState().backtestProgress;
  for (const r of list) {
    let next: ProgressEntry;
    if (r.status === "done") {
      next = { status: "done", progressPct: 100 };
    } else if (r.status === "failed") {
      next = {
        status: "failed",
        progressPct: Number(r.progressPct ?? 0),
        error: r.error ?? undefined,
      };
    } else if (r.status === "cancelled") {
      next = { status: "cancelled", progressPct: Number(r.progressPct ?? 0) };
    } else if (r.status === "queued" || r.status === "running") {
      const live = liveMap[r.id];
      const dbPct = Number(r.progressPct ?? 0);
      const livePct = Number(live?.progressPct ?? 0);
      next = { status: r.status, progressPct: Math.max(dbPct, livePct) };
    } else {
      continue;
    }
    const prev = liveMap[r.id];
    if (
      prev &&
      prev.progressPct === next.progressPct &&
      prev.status === next.status &&
      (prev.error ?? "") === (next.error ?? "")
    ) {
      continue;
    }
    setBacktestProgress(r.id, next);
  }
}

/** Signature of terminal WS progress entries — refresh list once when this set changes. */
export function terminalBacktestProgressSignature(
  progressMap: Record<string, { progressPct: number; status?: string; error?: string }>,
): string {
  return Object.entries(progressMap)
    .filter(([, v]) => v?.status === "done" || v?.status === "failed")
    .map(([id, v]) => `${id}:${v.status}`)
    .sort()
    .join("|");
}
