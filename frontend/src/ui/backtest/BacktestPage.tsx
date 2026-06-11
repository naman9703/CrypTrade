/**
 * Backtest workbench (third top-level mainView).
 *
 * Layout: left = runs history + sync card, center = result tabs (KPIs, equity,
 * trade list, monthly heatmap, distributions, with-vs-without-gate),
 * right = data coverage calendar.
 *
 * Live updates flow over the existing `wsHub`: `backtest_progress`,
 * `backtest_complete`, `backtest_failed`. Detail data is fetched lazily over
 * REST when a run is selected or finishes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import type { BacktestRunSummary } from "../../types/backtest";
import { useAppStore } from "../../ws/store";
import { syncBacktestProgressFromRunList, terminalBacktestProgressSignature } from "./backtestRunsSync";
import { NewBacktestForm } from "./NewBacktestForm";
import { BacktestResultPanel } from "./BacktestResultPanel";
import { BacktestRunsHistory } from "./BacktestRunsHistory";
import { DataCoverageCalendar } from "./DataCoverageCalendar";
import { BacktestSessionPieCharts } from "./BacktestSessionPieCharts";
import { OptimizationPanel } from "./OptimizationPanel";
import { StrategyComparisonPanel } from "./StrategyComparisonPanel";
import { StrategyTestPanel } from "./StrategyTestPanel";
import { BacktestActivityPanel } from "./BacktestActivityPanel";

export function BacktestPage() {
  const [runs, setRuns] = useState<BacktestRunSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState<boolean>(true);
  const [topTab, setTopTab] = useState<"results" | "optimization" | "compare" | "testing">("results");
  const [coverageSymbol, setCoverageSymbol] = useState<string>("BTCUSDT");
  const [coverageTf, setCoverageTf] = useState<string>("15m");
  const progressMap = useAppStore((s) => s.backtestProgress);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const terminalRefreshSigRef = useRef("");

  const refreshRuns = useCallback(async () => {
    try {
      const data = await api.listBacktestRuns(100);
      const list = (data?.runs ?? []) as BacktestRunSummary[];
      syncBacktestProgressFromRunList(list);
      setRuns(list);
      if (!selectedIdRef.current && list.length) setSelectedId(list[0].id);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  const hasActiveRuns = useMemo(
    () =>
      runs.some((r) => r.status === "queued" || r.status === "running") ||
      Object.values(progressMap).some((p) => p && (p.status === "queued" || p.status === "running")),
    [runs, progressMap],
  );

  /** Poll DB while jobs are active so progress survives tab focus loss or missed WS frames. */
  useEffect(() => {
    if (!hasActiveRuns) return;
    const t = setInterval(() => {
      void refreshRuns();
    }, 800);
    return () => clearInterval(t);
  }, [hasActiveRuns, refreshRuns]);

  /** One REST refresh when a run newly reaches done/failed (WS); not on every progress tick. */
  useEffect(() => {
    const sig = terminalBacktestProgressSignature(progressMap);
    if (!sig || sig === terminalRefreshSigRef.current) return;
    terminalRefreshSigRef.current = sig;
    void refreshRuns();
  }, [progressMap, refreshRuns]);

  const selected = useMemo(
    () => runs.find((r) => r.id === selectedId) ?? null,
    [runs, selectedId],
  );

  /** Sticky at viewport top on lg+; internal scroll once the column reaches the top of the screen. */
  const colScroll =
    "lg:sticky lg:top-0 lg:max-h-[100dvh] lg:overflow-y-auto lg:overscroll-y-contain lg:self-start";

  return (
    <div className="mx-auto w-full max-w-[1920px] px-4 pb-8 pt-4">
      <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)_18rem] lg:items-start">
        <aside className={`space-y-3 ${colScroll} lg:pr-0.5`}>
          <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-950/60">
            <div className="flex items-center justify-between gap-2 pb-2">
              <div className="text-sm font-semibold">New backtest</div>
              <button
                type="button"
                onClick={() => setShowNew((v) => !v)}
                className="text-xs text-slate-500 hover:underline"
              >
                {showNew ? "Hide" : "Show"}
              </button>
            </div>
            {showNew && (
              <NewBacktestForm
                onCreated={async (runId) => {
                  await refreshRuns();
                  setSelectedId(runId);
                }}
                onSymbolChange={setCoverageSymbol}
                onTfChange={setCoverageTf}
              />
            )}
          </div>

          <BacktestRunsHistory
            runs={runs}
            selectedId={selectedId}
            onSelect={setSelectedId}
            progress={progressMap}
            liveActivity={hasActiveRuns}
            onAfterCancel={refreshRuns}
            onAfterDelete={async (deletedId) => {
              if (deletedId === selectedId) setSelectedId(null);
              await refreshRuns();
            }}
          />

          <BacktestActivityPanel />
        </aside>

        <main className={`min-w-0 space-y-3 ${colScroll} lg:pr-0.5`}>
          <div className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 text-xs dark:border-slate-800 dark:bg-slate-950/60">
            {(["results", "optimization", "compare", "testing"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTopTab(t)}
                className={`rounded px-3 py-1 ${topTab === t ? "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-200" : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800"}`}
              >
                {t === "results"
                  ? "Results"
                  : t === "optimization"
                    ? "Optimization"
                    : t === "compare"
                      ? "Compare"
                      : "Strategy testing"}
              </button>
            ))}
          </div>

          {topTab === "results" ? (
            <BacktestResultPanel run={selected} progress={selected ? progressMap[selected.id] : undefined} onAfterPromote={refreshRuns} />
          ) : topTab === "optimization" ? (
            <OptimizationPanel runs={runs} onSelectRun={setSelectedId} />
          ) : topTab === "compare" ? (
            <StrategyComparisonPanel runs={runs} />
          ) : (
            <StrategyTestPanel runs={runs} />
          )}
        </main>

        <aside className={`space-y-3 ${colScroll} lg:pl-0.5`}>
          <DataCoverageCalendar
            symbol={coverageSymbol}
            timeframe={coverageTf}
            onSymbolChange={setCoverageSymbol}
            onTfChange={setCoverageTf}
          />
          <BacktestSessionPieCharts run={selected?.status === "done" ? selected : null} />
        </aside>
      </div>
    </div>
  );
}
