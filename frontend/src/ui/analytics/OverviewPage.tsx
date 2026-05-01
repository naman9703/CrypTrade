import { useCallback, useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import { api } from "../../api/client";
import { useAppStore } from "../../ws/store";
import { tradingModeToApiModeSlug, type ApiTradingModeSlug } from "../../lib/tradingModeSlug";
import { apiModeSlugToModeLabel } from "../../lib/tradingModeSlug";
import { EMPTY_BOT_INSTANCES, EMPTY_STRATEGIES } from "../../lib/stableEmptyArrays";
import { EquityCurveChart } from "./EquityCurveChart";
import { StrategyComparisonTable } from "./StrategyComparisonTable";
import { formatHold } from "../../lib/performanceMetricsUi";
import { EditInstanceLabelModal } from "../instances/EditInstanceLabelModal";
import { DeleteInstanceModal } from "../instances/DeleteInstanceModal";
import type { BotInstance } from "../../types/instance";
import type { PerformanceCompareRow, StrategyEdgeMetrics } from "../../types/performance";

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

function instanceStatusBadge(status: string) {
  const s = String(status || "").toLowerCase();
  if (s === "running") return <span className="ml-1.5 inline-block h-2 w-2 rounded-full bg-emerald-500 shadow-sm shadow-emerald-400/40" title="Running" />;
  if (s === "error") return <span className="ml-1.5 inline-block h-2 w-2 rounded-full bg-rose-500" title="Error" />;
  return <span className="ml-1.5 inline-block h-2 w-2 rounded-full bg-slate-400/70 dark:bg-slate-600" title={status || "Stopped"} />;
}

export function OverviewPage() {
  const dark = useDocDark();
  const mode = useAppStore((s) => s.mode);
  const modeSlug = useMemo(() => tradingModeToApiModeSlug(mode), [mode]);
  const rows = useAppStore((s) => s.analyticsCompareRows);
  const loading = useAppStore((s) => s.analyticsCompareLoading);
  const fetchComparisonData = useAppStore((s) => s.fetchComparisonData);
  const activeVid = useAppStore((s) => s.activeStrategyVersionByMode[modeSlug]);
  const selectedStrategyId = useAppStore((s) => s.analyticsSelectedStrategyId);
  const selectedVersionId = useAppStore((s) => s.analyticsSelectedVersionId);
  const selectAnalyticsVersion = useAppStore((s) => s.selectAnalyticsVersion);
  const performanceByVersion = useAppStore((s) => s.performanceByVersion);
  const equityCurveByVersion = useAppStore((s) => s.equityCurveByVersion);
  const instances = useAppStore((s) => s.instancesByMode[modeSlug] ?? EMPTY_BOT_INSTANCES);
  const instancesLoading = useAppStore((s) => s.instancesLoading);
  const strategies = useAppStore((s) => s.strategiesByMode[modeSlug] ?? EMPTY_STRATEGIES);
  const fetchInstancesForMode = useAppStore((s) => s.fetchInstancesForMode);
  const fetchStrategiesForMode = useAppStore((s) => s.fetchStrategiesForMode);
  const fetchAccountsForMode = useAppStore((s) => s.fetchAccountsForMode);
  const activeInstanceByMode = useAppStore((s) => s.activeInstanceByMode);
  const activeTradingId = activeInstanceByMode[modeSlug];
  const accountSnapshot = useAppStore((s) => s.account as any);
  const accounts = useAppStore((s) => s.accounts);
  const activeAccountByMode = useAppStore((s) => s.activeAccountByMode);
  const activeAccountId = activeAccountByMode[modeSlug];
  const activeAccount = accounts.find((a) => a.id === activeAccountId) ?? null;

  const [editInstance, setEditInstance] = useState<BotInstance | null>(null);
  const [deleteCtx, setDeleteCtx] = useState<BotInstance | null>(null);
  const [strategyEdge, setStrategyEdge] = useState<StrategyEdgeMetrics | null>(null);
  const [strategyEdgeLoading, setStrategyEdgeLoading] = useState(false);
  const enterInstance = useAppStore((s) => s.enterInstance);

  useEffect(() => {
    useAppStore.setState({ analyticsModeSlug: modeSlug });
    void fetchComparisonData(modeSlug);
    void fetchInstancesForMode(modeSlug);
    void fetchStrategiesForMode(modeSlug);
    void fetchAccountsForMode(modeSlug);
  }, [modeSlug, fetchComparisonData, fetchInstancesForMode, fetchStrategiesForMode, fetchAccountsForMode]);

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

  useEffect(() => {
    if (!selectedVersionId) {
      setStrategyEdge(null);
      return;
    }
    let cancelled = false;
    setStrategyEdgeLoading(true);
    void api
      .getStrategyEdge({ strategyVersionId: selectedVersionId, windowDays: 90 })
      .then((res) => {
        if (cancelled) return;
        setStrategyEdge(res.metrics ?? null);
      })
      .catch(() => {
        if (!cancelled) setStrategyEdge(null);
      })
      .finally(() => {
        if (!cancelled) setStrategyEdgeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedVersionId]);

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

  const onRefreshInstances = useCallback(() => {
    void fetchInstancesForMode(modeSlug);
  }, [fetchInstancesForMode, modeSlug]);

  const onDeleteInstance = useCallback((inst: BotInstance) => {
    const st = String(inst.status).toLowerCase();
    if (st === "running" || st === "paused") {
      useAppStore.getState().pushLog({ level: "warn", msg: "Stop the bot before deleting this instance" });
      return;
    }
    setDeleteCtx(inst);
  }, []);

  return (
    <div>
      {/* Overview sub-header */}
      <div className="border-b border-slate-200 bg-white/90 px-4 py-3 dark:border-slate-800 dark:bg-slate-950/80">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-lg font-semibold">Overview</h1>
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
        </div>
      </div>

      <div className="mx-auto max-w-[1400px] space-y-6 px-4 py-6">
        {/* Account summary (mode/account scoped) */}
        <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950/50">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Active account summary</h2>
          <div className="grid gap-3 md:grid-cols-[1.2fr_1fr_1fr_1fr]">
            <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-700 dark:bg-slate-900/40">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-sky-500/20 text-xs font-semibold text-sky-700 dark:text-sky-300">
                  {String(activeAccount?.label || "AC").slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {activeAccount?.label || "No account selected"}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {activeAccount?.credentials?.isActive ? "API connected" : "API not connected"}
                  </div>
                </div>
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-700 dark:bg-slate-900/40">
              <div className="text-[10px] uppercase text-slate-500">Spot USDT equity</div>
              <div className="mt-1 text-base font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {accountSnapshot?.venues?.spot?.equity != null && Number.isFinite(Number(accountSnapshot?.venues?.spot?.equity))
                  ? `$${Number(accountSnapshot.venues.spot.equity).toFixed(2)}`
                  : "—"}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-700 dark:bg-slate-900/40">
              <div className="text-[10px] uppercase text-slate-500">Futures USDT equity</div>
              <div className="mt-1 text-base font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {accountSnapshot?.venues?.futures?.equity != null && Number.isFinite(Number(accountSnapshot?.venues?.futures?.equity))
                  ? `$${Number(accountSnapshot.venues.futures.equity).toFixed(2)}`
                  : "—"}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-700 dark:bg-slate-900/40">
              <div className="text-[10px] uppercase text-slate-500">Total USDT equity</div>
              <div className="mt-1 text-base font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {accountSnapshot?.equity != null && Number.isFinite(Number(accountSnapshot?.equity))
                  ? `$${Number(accountSnapshot.equity).toFixed(2)}`
                  : "—"}
              </div>
            </div>
          </div>
        </section>

        {/* Instances section */}
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Instances</h2>
          {instancesLoading && instances.length === 0 ? (
            <p className="text-xs text-slate-500">Loading instances…</p>
          ) : instances.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500 dark:border-slate-700">
              No instances yet for this mode. Click <strong>+</strong> in the tab bar above to create one.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
              <table className="w-full min-w-[480px] border-collapse text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-[10px] uppercase text-slate-500 dark:border-slate-700 dark:bg-slate-900/50">
                  <tr>
                    <th className="px-3 py-2 font-medium">Instance</th>
                    <th className="px-3 py-2 font-medium">Strategy</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">PnL</th>
                    <th className="px-3 py-2 font-medium">Trades</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {instances.map((inst) => {
                    const isActive = inst.id === activeTradingId;
                    const pnl = inst.totalPnlUsdt ?? null;
                    const strategy = strategies.find((s) => s.id === inst.strategyId);
                    return (
                      <tr
                        key={inst.id}
                        className={clsx(
                          "border-b border-slate-100 dark:border-slate-800",
                          isActive && "bg-sky-50 dark:bg-sky-950/30",
                        )}
                      >
                        <td className="px-3 py-2 font-medium text-slate-800 dark:text-slate-100">
                          {inst.label || `Instance ${inst.id.slice(0, 6)}`}
                          {isActive ? <span className="ml-1 text-amber-500 text-[10px]">active</span> : null}
                        </td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-400">
                          {strategy?.name ?? inst.strategyId?.slice(0, 8) ?? "—"}
                        </td>
                        <td className="px-3 py-2">
                          <span className="inline-flex items-center gap-1">
                            {instanceStatusBadge(inst.status)}
                            <span className="capitalize text-slate-600 dark:text-slate-400">
                              {inst.status || "stopped"}
                            </span>
                          </span>
                        </td>
                        <td className={clsx(
                          "px-3 py-2 font-mono tabular-nums",
                          pnl == null ? "text-slate-500" : pnl >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
                        )}>
                          {pnl == null ? "—" : `${pnl >= 0 ? "+" : ""}$${Math.abs(pnl).toFixed(2)}`}
                        </td>
                        <td className="px-3 py-2 font-mono tabular-nums text-slate-600 dark:text-slate-400">
                          {inst.totalTrades ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              className="rounded border border-slate-300 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-slate-800"
                              title="Edit label"
                              onClick={() => setEditInstance(inst)}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="rounded border border-rose-300/60 px-2 py-0.5 text-[11px] text-rose-600 hover:bg-rose-50 dark:border-rose-700/60 dark:text-rose-400 dark:hover:bg-rose-950/30"
                              title="Delete instance"
                              onClick={() => onDeleteInstance(inst)}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Strategy comparison analytics */}
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Strategy comparison</h2>
          {loading ? <p className="text-xs text-slate-500">Loading…</p> : null}
          <StrategyComparisonTable
            rows={rows}
            activeVersionId={activeVid ?? null}
            onSelectRow={(sid, vid) => selectAnalyticsVersion(sid, vid)}
            instances={instances}
            onEnterInstance={(instanceId) => void enterInstance(instanceId)}
          />

          <p className="mt-1 text-[10px] text-slate-500">
            ★ = active strategy version for this mode (current session). Rows are every non-archived version for strategies in this mode; — means no closed trades recorded for that version.
          </p>
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
              <div className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-600">
                <h4 className="mb-1 text-[10px] font-semibold uppercase text-slate-500">Strategy edge · 90d</h4>
                {strategyEdgeLoading ? (
                  <p className="text-slate-500">Loading…</p>
                ) : !strategyEdge || strategyEdge.tradeCount <= 0 ? (
                  <p className="text-slate-500">Need closed trades in the window.</p>
                ) : (
                  <dl className="space-y-1.5">
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500">Closed trades</dt>
                      <dd className="font-mono">{strategyEdge.tradeCount}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500">Expectancy</dt>
                      <dd className="font-mono">
                        {strategyEdge.expectancyUsdt != null && Number.isFinite(strategyEdge.expectancyUsdt)
                          ? `${strategyEdge.expectancyUsdt >= 0 ? "+" : ""}$${strategyEdge.expectancyUsdt.toFixed(4)}`
                          : "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500">Win rate</dt>
                      <dd className="font-mono">
                        {strategyEdge.winRatePct != null ? `${strategyEdge.winRatePct.toFixed(1)}%` : "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500">Profit factor</dt>
                      <dd className="font-mono">
                        {strategyEdge.profitFactor != null && Number.isFinite(strategyEdge.profitFactor)
                          ? strategyEdge.profitFactor.toFixed(2)
                          : "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500">Net PnL</dt>
                      <dd
                        className={clsx(
                          "font-mono font-medium",
                          strategyEdge.netPnlUsdt >= 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-rose-600 dark:text-rose-400",
                        )}
                      >
                        {strategyEdge.netPnlUsdt >= 0 ? "+" : ""}$
                        {Math.abs(strategyEdge.netPnlUsdt).toFixed(2)}
                      </dd>
                    </div>
                  </dl>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Modals */}
      {editInstance ? (
        <EditInstanceLabelModal
          instanceId={editInstance.id}
          initialLabel={editInstance.label ?? ""}
          open={Boolean(editInstance)}
          onClose={() => setEditInstance(null)}
          onSaved={() => {
            onRefreshInstances();
            setEditInstance(null);
          }}
        />
      ) : null}
      {deleteCtx ? (
        <DeleteInstanceModal
          instance={deleteCtx}
          open={Boolean(deleteCtx)}
          onClose={() => setDeleteCtx(null)}
          onDeleted={() => {
            onRefreshInstances();
            setDeleteCtx(null);
          }}
        />
      ) : null}
    </div>
  );
}
