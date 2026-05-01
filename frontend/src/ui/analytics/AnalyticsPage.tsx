import { useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import { useAppStore } from "../../ws/store";
import type { ApiTradingModeSlug } from "../../lib/tradingModeSlug";
import { apiModeSlugToModeLabel } from "../../lib/tradingModeSlug";
import { EquityCurveChart } from "./EquityCurveChart";
import { StrategyComparisonTable } from "./StrategyComparisonTable";
import { formatHold } from "../../lib/performanceMetricsUi";
import type { PerformanceCompareRow } from "../../types/performance";

const MODE_OPTIONS: { slug: ApiTradingModeSlug; label: string }[] = [
  { slug: "paper", label: "Paper" },
  { slug: "demo_api", label: "Demo API" },
  { slug: "testnet", label: "Testnet" },
  { slug: "live", label: "Live" },
];

function useDocDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const el = document.documentElement;
    const sync = () => setDark(el.classList.contains("dark"));
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

export function AnalyticsPage() {
  const dark = useDocDark();
  const setMainView = useAppStore((s) => s.setMainView);
  const rows = useAppStore((s) => s.analyticsCompareRows);
  const loading = useAppStore((s) => s.analyticsCompareLoading);
  const modeSlug = useAppStore((s) => s.analyticsModeSlug);
  const fetchComparisonData = useAppStore((s) => s.fetchComparisonData);
  const activeVid = useAppStore((s) => s.activeStrategyVersionByMode[modeSlug]);
  const selectedStrategyId = useAppStore((s) => s.analyticsSelectedStrategyId);
  const selectedVersionId = useAppStore((s) => s.analyticsSelectedVersionId);
  const selectAnalyticsVersion = useAppStore((s) => s.selectAnalyticsVersion);
  const performanceByVersion = useAppStore((s) => s.performanceByVersion);
  const equityCurveByVersion = useAppStore((s) => s.equityCurveByVersion);

  const patchAnalyticsMode = useAppStore.setState.bind(null);

  function onModeChange(slug: ApiTradingModeSlug) {
    useAppStore.setState({ analyticsModeSlug: slug });
    void fetchComparisonData(slug);
  }

  useEffect(() => {
    if (!rows.length) return;
    if (selectedVersionId && rows.some((r) => r.versionId === selectedVersionId)) return;
    const first = rows[0];
    selectAnalyticsVersion(first.strategyId, first.versionId);
  }, [rows, selectedVersionId, selectAnalyticsVersion]);

  const versionNav = useMemo(() => {
    const empty: PerformanceCompareRow[] = [];
    if (!selectedStrategyId || !selectedVersionId) return { list: empty, idx: -1 };
    const list = rows
      .filter((r) => r.strategyId === selectedStrategyId)
      .slice()
      .sort((a, b) => a.versionNumber - b.versionNumber);
    const idx = list.findIndex((r) => r.versionId === selectedVersionId);
    return { list, idx };
  }, [rows, selectedStrategyId, selectedVersionId]);

  const selectedRow = rows.find((r) => r.versionId === selectedVersionId);
  const metrics = selectedVersionId
    ? performanceByVersion[selectedVersionId] ?? selectedRow?.metrics ?? null
    : null;
  const curve = selectedVersionId ? equityCurveByVersion[selectedVersionId] ?? [] : [];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="border-b border-slate-200 bg-white/90 px-4 py-3 dark:border-slate-800 dark:bg-slate-950/80">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-lg font-semibold">Analytics</h1>
            <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
              Mode
              <select
                className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-medium dark:border-slate-600 dark:bg-slate-900"
                value={modeSlug}
                onChange={(e) => onModeChange(e.target.value as ApiTradingModeSlug)}
              >
                {MODE_OPTIONS.map((o) => (
                  <option key={o.slug} value={o.slug}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-[10px] uppercase text-slate-500">{apiModeSlugToModeLabel(modeSlug)}</span>
          </div>
          <button
            type="button"
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium dark:border-slate-600"
            onClick={() => setMainView("overview")}
          >
            ← Overview
          </button>
        </div>
      </div>

      <div className="mx-auto max-w-[1400px] space-y-6 px-4 py-6">
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Strategy comparison</h2>
          {loading ? <p className="text-xs text-slate-500">Loading…</p> : null}
          <StrategyComparisonTable
            rows={rows}
            activeVersionId={activeVid ?? null}
            onSelectRow={(sid, vid) => selectAnalyticsVersion(sid, vid)}
          />
          <p className="mt-1 text-[10px] text-slate-500">★ = active strategy version for this mode (current session).</p>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950/50">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Selected strategy detail</h2>
            {selectedRow ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded border border-slate-200 px-2 py-1 text-[11px] disabled:opacity-40 dark:border-slate-600"
                  disabled={versionNav.idx <= 0}
                  onClick={() => {
                    const prev = versionNav.list[versionNav.idx - 1];
                    if (prev) selectAnalyticsVersion(prev.strategyId, prev.versionId);
                  }}
                >
                  ← Prev version
                </button>
                <button
                  type="button"
                  className="rounded border border-slate-200 px-2 py-1 text-[11px] disabled:opacity-40 dark:border-slate-600"
                  disabled={versionNav.idx < 0 || versionNav.idx >= versionNav.list.length - 1}
                  onClick={() => {
                    const next = versionNav.list[versionNav.idx + 1];
                    if (next) selectAnalyticsVersion(next.strategyId, next.versionId);
                  }}
                >
                  Next version →
                </button>
              </div>
            ) : null}
          </div>

          {selectedRow ? (
            <p className="mb-4 text-sm font-medium text-slate-800 dark:text-slate-100">
              {selectedRow.strategyName} — v{selectedRow.versionNumber}
              {selectedRow.label ? ` · ${selectedRow.label}` : ""}
            </p>
          ) : (
            <p className="text-xs text-slate-500">Select a row above to view equity curve and metrics.</p>
          )}

          <div className="grid gap-4 lg:grid-cols-[1.4fr_280px]">
            <div className="min-w-0">
              <EquityCurveChart points={curve} dark={dark} />
            </div>
            <div
              className={clsx(
                "rounded-lg border border-slate-200 bg-slate-50/80 p-3 text-xs dark:border-slate-700 dark:bg-slate-900/40",
              )}
            >
              <h3 className="mb-2 text-[10px] font-semibold uppercase text-slate-500">Metrics</h3>
              {!metrics || metrics.totalTrades <= 0 ? (
                <p className="text-slate-500">No closed trades for this version.</p>
              ) : (
                <dl className="space-y-1.5">
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500">Win rate</dt>
                    <dd className="font-mono font-medium">{metrics.winRatePct.toFixed(1)}%</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500">Total PnL</dt>
                    <dd
                      className={clsx(
                        "font-mono font-medium",
                        metrics.totalPnlUsdt >= 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-rose-600 dark:text-rose-400",
                      )}
                    >
                      {metrics.totalPnlUsdt >= 0 ? "+" : ""}$
                      {Math.abs(metrics.totalPnlUsdt).toFixed(2)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500">Trades</dt>
                    <dd className="font-mono">{metrics.totalTrades}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500">Avg win</dt>
                    <dd className="font-mono">
                      {metrics.avgWinUsdt != null ? `+$${metrics.avgWinUsdt.toFixed(2)}` : "—"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500">Avg loss</dt>
                    <dd className="font-mono">
                      {metrics.avgLossUsdt != null ? `$${metrics.avgLossUsdt.toFixed(2)}` : "—"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500">RR ratio</dt>
                    <dd className="font-mono">
                      {metrics.rrRatio != null && Number.isFinite(metrics.rrRatio)
                        ? metrics.rrRatio.toFixed(2)
                        : "—"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500">Profit factor</dt>
                    <dd className="font-mono">
                      {metrics.profitFactor != null && Number.isFinite(metrics.profitFactor)
                        ? metrics.profitFactor.toFixed(2)
                        : "—"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500">Max DD</dt>
                    <dd className="font-mono">
                      {metrics.maxDrawdownPct != null ? `${metrics.maxDrawdownPct.toFixed(2)}%` : "—"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500">Sharpe</dt>
                    <dd className="font-mono">
                      {metrics.sharpeRatio != null && Number.isFinite(metrics.sharpeRatio)
                        ? metrics.sharpeRatio.toFixed(2)
                        : "—"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500">Avg hold</dt>
                    <dd className="font-mono">{formatHold(metrics.avgHoldSec)}</dd>
                  </div>
                </dl>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
