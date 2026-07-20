import { useCallback, useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import { api } from "../../api/client";
import { useAppStore } from "../../ws/store";
import { apiModeSlugToModeLabel, tradingModeToApiModeSlug } from "../../lib/tradingModeSlug";
import { EMPTY_BOT_INSTANCES, EMPTY_STRATEGIES } from "../../lib/stableEmptyArrays";
import { isStrategyInUseForInstance } from "../../lib/strategyInUse";
import { renameStrategyWithGuard } from "../../lib/strategyInstanceBind";
import type { StrategyVersion } from "../../types/strategy";
import {
  strategyVersionBadgeLabels,
  strategyVersionStLine,
} from "../../lib/strategyVersionDisplay";
import { CloneStrategyModal } from "./CloneStrategyModal";
import { CreateStrategyModal } from "./CreateStrategyModal";
import { StrategyDetailDrawer } from "./StrategyDetailDrawer";
import { SwitchStrategyModal } from "./SwitchStrategyModal";

function strategyCardSubtitle(v: StrategyVersion | null | undefined) {
  if (!v) return "No saved config";
  return strategyVersionBadgeLabels(v).join(" · ");
}

export function StrategySidebar() {
  const mode = useAppStore((s) => s.mode);
  const modeSlug = tradingModeToApiModeSlug(mode);
  const modeLabel = apiModeSlugToModeLabel(modeSlug);
  const collapsed = useAppStore((s) => s.layout.strategySidebarCollapsed);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const strategies = useAppStore((s) => s.strategiesByMode[modeSlug] ?? EMPTY_STRATEGIES);
  const instances = useAppStore((s) => s.instancesByMode[modeSlug] ?? EMPTY_BOT_INSTANCES);
  const activeInstanceId = useAppStore((s) => s.activeInstanceByMode[modeSlug]);
  const fetchStrategiesForMode = useAppStore((s) => s.fetchStrategiesForMode);
  const fetchInstancesForMode = useAppStore((s) => s.fetchInstancesForMode);
  const strategiesLoading = useAppStore((s) => s.strategiesLoading);
  const strategiesError = useAppStore((s) => s.strategiesError);
  const selectStrategy = useAppStore((s) => s.selectStrategy);
  const selectedStrategyId = useAppStore((s) => s.selectedStrategyId);
  const bindInstanceStrategyStore = useAppStore((s) => s.bindInstanceStrategyStore);
  const archiveStrategyStore = useAppStore((s) => s.archiveStrategyStore);
  const cloneStrategyAsNewStore = useAppStore((s) => s.cloneStrategyAsNewStore);
  const createStrategyForMode = useAppStore((s) => s.createStrategyForMode);
  const runningByMode = useAppStore((s) => s.runningByMode);
  const bot = useAppStore((s) => s.bot);
  const pushLog = useAppStore((s) => s.pushLog);

  const [createOpen, setCreateOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [cloneSource, setCloneSource] = useState<{ id: string; name: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [switchCtx, setSwitchCtx] = useState<{
    strategyId: string;
    label: string;
    currentLabel: string;
  } | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);

  const running = Boolean(runningByMode?.[String(mode || "").toUpperCase()] ?? bot?.running);

  const refresh = useCallback(() => {
    void fetchStrategiesForMode(modeSlug, { includeArchived: showArchived });
    void fetchInstancesForMode(modeSlug);
  }, [fetchStrategiesForMode, fetchInstancesForMode, modeSlug, showArchived]);

  useEffect(() => {
    const st = useAppStore.getState();
    if ((st.strategiesByMode[modeSlug]?.length ?? 0) === 0) {
      void fetchStrategiesForMode(modeSlug, { includeArchived: showArchived });
    }
    if ((st.instancesByMode[modeSlug]?.length ?? 0) === 0) {
      void fetchInstancesForMode(modeSlug);
    }
  }, [fetchStrategiesForMode, fetchInstancesForMode, modeSlug, showArchived]);

  const dbUserRequired = strategiesError === "db_user_required";

  async function runSetActiveForInstance(strategyId: string, label: string) {
    if (!activeInstanceId) {
      pushLog({ level: "warn", msg: "Select an instance tab first, then Set active." });
      return;
    }
    const go = async () => {
      await bindInstanceStrategyStore(activeInstanceId, strategyId);
      refresh();
      pushLog({
        level: "info",
        msg: `Instance now uses strategy: ${label}`,
        category: "config",
        reason: "strategy_instance_bind",
      });
    };
    try {
      if (!running) {
        await go();
        return;
      }
      const curStrat = strategies.find((s) =>
        isStrategyInUseForInstance(s.id, instances, activeInstanceId),
      );
      setSwitchCtx({
        strategyId,
        label,
        currentLabel: curStrat?.name ? `${curStrat.name} (in use)` : "Current strategy",
      });
    } catch (e) {
      pushLog({
        level: "error",
        msg: `Set active failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  async function confirmSwitch() {
    if (!switchCtx || !activeInstanceId) return;
    setSwitchBusy(true);
    try {
      await api.botStop({
        reason: "strategy_switch",
        mode: mode as "PAPER" | "BINANCE_DEMO_API" | "BINANCE_TESTNET" | "BINANCE_LIVE",
      });
      await bindInstanceStrategyStore(activeInstanceId, switchCtx.strategyId);
      refresh();
      pushLog({
        level: "info",
        msg: `Bot stopped — instance now uses: ${switchCtx.label}`,
        category: "config",
        reason: "strategy_switch",
      });
      setSwitchCtx(null);
    } catch (e) {
      pushLog({
        level: "error",
        msg: `Strategy switch failed: ${e instanceof Error ? e.message : String(e)}`,
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
        <span className="text-slate-500"> · ★ = bound to active instance</span>
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
      {strategiesError && strategiesError !== "db_user_required" ? (
        <p className="px-3 pb-2 text-[11px] text-rose-600 dark:text-rose-400">{strategiesError}</p>
      ) : null}
      <div className="max-h-[70vh] min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-3">
        {strategiesLoading && !strategies.length ? (
          <p className="px-2 text-xs text-slate-500">Loading…</p>
        ) : null}
        {strategies.map((s) => {
          const v = s.latestVersion;
          const isStar = isStrategyInUseForInstance(s.id, instances, activeInstanceId);
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
                    <span aria-hidden title={isStar ? "Used by active instance" : undefined}>
                      {isStar ? "★" : "○"}
                    </span>
                    <span className="truncate">{s.name}</span>
                  </div>
                  <p className="mt-1 text-[10px] text-slate-600 dark:text-slate-400">{strategyCardSubtitle(v)}</p>
                  <p className="text-[10px] text-slate-600 dark:text-slate-400">ST {strategyVersionStLine(v)}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <button
                    type="button"
                    className="rounded bg-sky-600 px-1.5 py-0.5 text-[10px] font-semibold text-white disabled:opacity-40"
                    disabled={!v || dbUserRequired || !activeInstanceId || isStar}
                    title={
                      !activeInstanceId
                        ? "Select an instance tab first"
                        : isStar
                          ? "Already active on this instance"
                          : undefined
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!v || isStar) return;
                      void runSetActiveForInstance(s.id, s.name);
                    }}
                  >
                    Set active
                  </button>
                  <div className="relative">
                    <button
                      type="button"
                      className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] disabled:opacity-40 dark:border-slate-600"
                      disabled={dbUserRequired}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuId((id) => (id === s.id ? null : s.id));
                      }}
                    >
                      ···
                    </button>
                    {menuId === s.id ? (
                      <div className="absolute right-0 z-10 mt-1 w-44 rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
                        <button
                          type="button"
                          className="block w-full px-2 py-1 text-left text-[11px] hover:bg-slate-100 dark:hover:bg-slate-800"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuId(null);
                            const n = window.prompt("Strategy name", s.name);
                            if (n == null) return;
                            void renameStrategyWithGuard(s.id, n.trim() || s.name)
                              .then(() => {
                                refresh();
                                pushLog({ level: "info", msg: "Strategy renamed", category: "config" });
                              })
                              .catch((err) =>
                                pushLog({
                                  level: "error",
                                  msg:
                                    err instanceof Error
                                      ? err.message
                                      : `Rename failed: ${String(err)}`,
                                }),
                              );
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
                          View config
                        </button>
                        <button
                          type="button"
                          className="block w-full px-2 py-1 text-left text-[11px] hover:bg-slate-100 dark:hover:bg-slate-800"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuId(null);
                            if (!v) return;
                            setCloneSource({ id: s.id, name: s.name });
                          }}
                        >
                          Duplicate
                        </button>
                        <button
                          type="button"
                          className="block w-full px-2 py-1 text-left text-[11px] text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuId(null);
                            if (!window.confirm(`Archive “${s.name}”?`)) return;
                            void archiveStrategyStore(s.id)
                              .then(() => {
                                refresh();
                                pushLog({ level: "info", msg: `Archived “${s.name}”`, category: "config" });
                              })
                              .catch((err) => {
                                const msg = err instanceof Error ? err.message : String(err);
                                pushLog({
                                  level: msg === "default_strategy_cannot_be_archived" ? "warn" : "error",
                                  msg:
                                    msg === "default_strategy_cannot_be_archived"
                                      ? "Default strategy cannot be archived"
                                      : `Archive failed: ${msg}`,
                                });
                              });
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

      <CloneStrategyModal
        open={cloneSource != null}
        sourceName={cloneSource?.name ?? "Strategy"}
        onClose={() => setCloneSource(null)}
        onClone={async (name) => {
          if (!cloneSource) return;
          const st = await cloneStrategyAsNewStore(cloneSource.id, name);
          selectStrategy(st.id);
          setDrawerOpen(true);
          refresh();
          pushLog({ level: "info", msg: `Created strategy “${name}”`, category: "config" });
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
