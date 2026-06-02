import { useCallback, useEffect, useState } from "react";
import { clsx } from "clsx";
import { api } from "../../api/client";
import { useAppStore } from "../../ws/store";
import { apiModeSlugToModeLabel, tradingModeToApiModeSlug } from "../../lib/tradingModeSlug";
import { EMPTY_STRATEGIES } from "../../lib/stableEmptyArrays";
import type { Strategy, StrategyVersion } from "../../types/strategy";
import { CreateStrategyModal } from "./CreateStrategyModal";
import { StrategyDetailDrawer } from "./StrategyDetailDrawer";
import { SwitchStrategyModal } from "./SwitchStrategyModal";

function capitalLine(v: StrategyVersion | null | undefined) {
  if (!v) return "—";
  if (v.cfgCapitalMode === "WALLET_PCT" && v.cfgCapitalPct != null) return `${v.cfgCapitalPct}% wallet`;
  if (v.cfgCapitalFixedUsdt != null && v.cfgCapitalFixedUsdt > 0)
    return `$${Number(v.cfgCapitalFixedUsdt).toLocaleString()}`;
  return "—";
}

export function StrategySidebar() {
  const mode = useAppStore((s) => s.mode);
  const modeSlug = tradingModeToApiModeSlug(mode);
  const modeLabel = apiModeSlugToModeLabel(modeSlug);
  const collapsed = useAppStore((s) => s.layout.strategySidebarCollapsed);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const strategies = useAppStore((s) => s.strategiesByMode[modeSlug] ?? EMPTY_STRATEGIES);
  const fetchStrategiesForMode = useAppStore((s) => s.fetchStrategiesForMode);
  const strategiesLoading = useAppStore((s) => s.strategiesLoading);
  const strategiesError = useAppStore((s) => s.strategiesError);
  const activeVid = useAppStore((s) => s.activeStrategyVersionByMode[modeSlug]);
  const selectStrategy = useAppStore((s) => s.selectStrategy);
  const selectedStrategyId = useAppStore((s) => s.selectedStrategyId);
  const setActiveStrategyVersionForMode = useAppStore((s) => s.setActiveStrategyVersionForMode);
  const archiveStrategyStore = useAppStore((s) => s.archiveStrategyStore);
  const createStrategyForMode = useAppStore((s) => s.createStrategyForMode);
  const runningByMode = useAppStore((s) => s.runningByMode);
  const bot = useAppStore((s) => s.bot);

  const [createOpen, setCreateOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [switchCtx, setSwitchCtx] = useState<{
    versionId: string;
    label: string;
    currentLabel: string;
  } | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);

  const running = Boolean(runningByMode?.[String(mode || "").toUpperCase()] ?? bot?.running);

  const refresh = useCallback(() => {
    void fetchStrategiesForMode(modeSlug, { includeArchived: showArchived });
  }, [fetchStrategiesForMode, modeSlug, showArchived]);

  useEffect(() => {
    void fetchStrategiesForMode(modeSlug, { includeArchived: showArchived });
  }, [fetchStrategiesForMode, modeSlug, showArchived]);

  const dbUserRequired = strategiesError === "db_user_required";

  async function runSetActive(versionId: string, label: string) {
    const go = async () => {
      await setActiveStrategyVersionForMode(modeSlug, versionId);
      await fetchStrategiesForMode(modeSlug, { includeArchived: showArchived });
      useAppStore.getState().pushLog({
        level: "info",
        msg: `Active strategy set: ${label}`,
        category: "config",
        reason: "strategy_active",
      });
    };
    if (!running) {
      await go();
      return;
    }
    const curStrat = strategies.find((s) => s.latestVersion?.id === activeVid);
    setSwitchCtx({
      versionId,
      label,
      currentLabel: curStrat?.name ? `${curStrat.name} (active)` : "Current strategy",
    });
  }

  async function confirmSwitch() {
    if (!switchCtx) return;
    setSwitchBusy(true);
    try {
      await api.botStop({
        reason: "strategy_switch",
        mode: mode as "PAPER" | "BINANCE_DEMO_API" | "BINANCE_TESTNET" | "BINANCE_LIVE",
      });
      await setActiveStrategyVersionForMode(modeSlug, switchCtx.versionId);
      await fetchStrategiesForMode(modeSlug, { includeArchived: showArchived });
      setSwitchCtx(null);
      useAppStore.getState().pushLog({
        level: "info",
        msg: `Bot stopped and active strategy set: ${switchCtx.label}`,
        category: "config",
        reason: "strategy_switch",
      });
    } finally {
      setSwitchBusy(false);
    }
  }

  if (collapsed) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center border-l border-slate-200 bg-slate-100/95 py-2 dark:border-slate-800 dark:bg-slate-950/60">
        <button
          type="button"
          title="Expand strategies"
          className="rounded-md p-1 text-slate-600 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-800"
          onClick={() => setSidebarCollapsed("strategy", false)}
        >
          <span className="text-lg" aria-hidden>
            ◆
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="flex w-[280px] shrink-0 flex-col rounded-xl border border-slate-200 bg-slate-100/95 shadow-glow-light dark:border-slate-800 dark:bg-slate-950/60 dark:shadow-glow">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">Strategies</h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={dbUserRequired}
            onClick={() => setCreateOpen(true)}
            className="rounded-md bg-sky-600 px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-40"
          >
            + New
          </button>
          <button
            type="button"
            title="Collapse"
            className="rounded p-1 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800"
            onClick={() => setSidebarCollapsed("strategy", true)}
          >
            →
          </button>
        </div>
      </div>
      <div className="px-3 py-2 text-[11px] text-slate-600 dark:text-slate-400">
        Active in{" "}
        <span className="font-semibold text-slate-800 dark:text-slate-200">{modeLabel}</span>
        <span className="text-slate-500"> · strategies shared across modes</span>
        <label className="mt-2 flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>
      </div>
      {dbUserRequired ? (
        <p className="px-3 pb-3 text-[11px] text-amber-700 dark:text-amber-400">
          Sign in with a database user to manage strategies.
        </p>
      ) : null}
      <div className="max-h-[70vh] min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-3">
        {strategiesLoading && !strategies.length ? (
          <p className="px-2 text-xs text-slate-500">Loading…</p>
        ) : null}
        {strategies.map((s) => {
          const v = s.latestVersion;
          const isStar = v != null && v.id === activeVid;
          return (
            <div
              key={s.id}
              role="button"
              tabIndex={0}
              onClick={() => {
                selectStrategy(s.id);
                setDrawerOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  selectStrategy(s.id);
                  setDrawerOpen(true);
                }
              }}
              className={clsx(
                "relative rounded-lg border px-2 py-2 text-left transition-colors",
                selectedStrategyId === s.id
                  ? "border-sky-500 bg-sky-50/50 dark:border-sky-600 dark:bg-sky-950/30"
                  : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900",
              )}
            >
              <div className="flex items-start justify-between gap-1">
                <div className="min-w-0">
                  <div className="flex items-center gap-1 text-xs font-semibold text-slate-900 dark:text-slate-100">
                    <span aria-hidden>{isStar ? "★" : "○"}</span>
                    <span className="truncate">{s.name}</span>
                    {v ? <span className="shrink-0 text-slate-500">v{v.versionNumber}</span> : null}
                  </div>
                  <p className="mt-1 text-[10px] text-slate-600 dark:text-slate-400">
                    {v?.cfgSymbol ?? "—"} · {v?.cfgTimeframe ?? "—"}
                  </p>
                  <p className="text-[10px] text-slate-600 dark:text-slate-400">
                    ST: {v?.cfgStPeriod ?? "—"} × {v?.cfgStMultiplier ?? "—"} · {capitalLine(v)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <button
                    type="button"
                    className="rounded bg-sky-600 px-1.5 py-0.5 text-[10px] font-semibold text-white disabled:opacity-40"
                    disabled={!v || dbUserRequired}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!v) return;
                      void runSetActive(v.id, `${s.name} v${v.versionNumber}`);
                    }}
                  >
                    Load
                  </button>
                  <div className="relative">
                    <button
                      type="button"
                      className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] dark:border-slate-600"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuId((id) => (id === s.id ? null : s.id));
                      }}
                    >
                      ···
                    </button>
                    {menuId === s.id ? (
                      <div className="absolute right-0 z-10 mt-1 w-40 rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
                        <button
                          type="button"
                          className="block w-full px-2 py-1 text-left text-[11px] hover:bg-slate-100 dark:hover:bg-slate-800"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuId(null);
                            const n = window.prompt("Strategy name", s.name);
                            if (n == null) return;
                            void useAppStore
                              .getState()
                              .updateStrategyMetaStore(s.id, { name: n.trim() || s.name })
                              .then(() => refresh());
                          }}
                        >
                          Edit name
                        </button>
                        <button
                          type="button"
                          className="block w-full px-2 py-1 text-left text-[11px] hover:bg-slate-100 dark:hover:bg-slate-800"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuId(null);
                            selectStrategy(s.id);
                            setDrawerOpen(true);
                          }}
                        >
                          View versions
                        </button>
                        <button
                          type="button"
                          className="block w-full px-2 py-1 text-left text-[11px] hover:bg-slate-100 dark:hover:bg-slate-800"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuId(null);
                            if (!v) return;
                            void useAppStore
                              .getState()
                              .cloneStrategyVersionStore(s.id, v.id, {})
                              .then(() => refresh());
                          }}
                        >
                          Clone latest
                        </button>
                        <button
                          type="button"
                          className="block w-full px-2 py-1 text-left text-[11px] text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuId(null);
                            if (!window.confirm(`Archive “${s.name}”?`)) return;
                            void archiveStrategyStore(s.id).then(() => refresh());
                          }}
                        >
                          Archive
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <CreateStrategyModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={async (data) => {
          const { strategy } = await createStrategyForMode(modeSlug, data);
          selectStrategy(strategy.id);
          setDrawerOpen(true);
          refresh();
        }}
      />

      <StrategyDetailDrawer
        strategyId={drawerOpen ? selectedStrategyId : null}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onActivated={() => refresh()}
      />

      <SwitchStrategyModal
        open={switchCtx != null}
        onClose={() => !switchBusy && setSwitchCtx(null)}
        onConfirm={confirmSwitch}
        busy={switchBusy}
        currentLabel={switchCtx?.currentLabel ?? ""}
        targetLabel={switchCtx?.label ?? ""}
      />
    </div>
  );
}
