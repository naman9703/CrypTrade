import { useCallback, useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import { tradingModeToApiModeSlug } from "../../lib/tradingModeSlug";
import { EMPTY_BOT_INSTANCES, EMPTY_STRATEGIES } from "../../lib/stableEmptyArrays";
import { useAppStore } from "../../ws/store";
import type { BotInstance } from "../../types/instance";
import { CreateInstanceModal } from "./CreateInstanceModal";
import { DeleteInstanceModal } from "./DeleteInstanceModal";

function statusDotClass(isOn: boolean) {
  return isOn ? "bg-emerald-500 shadow-sm shadow-emerald-500/50" : "bg-rose-500";
}

/** Browser-tab bar below RegimeEngineStrip: Overview | [instance tabs] | + */
export function InstanceNavBar() {
  const mode = useAppStore((s) => s.mode);
  const modeSlug = useMemo(() => tradingModeToApiModeSlug(mode), [mode]);
  const mainView = useAppStore((s) => s.mainView);
  const selectedInstanceId = useAppStore((s) => s.selectedInstanceId);
  const instances = useAppStore((s) => s.instancesByMode[modeSlug] ?? EMPTY_BOT_INSTANCES);
  const strategies = useAppStore((s) => s.strategiesByMode[modeSlug] ?? EMPTY_STRATEGIES);
  const enterInstance = useAppStore((s) => s.enterInstance);
  const setMainView = useAppStore((s) => s.setMainView);
  const fetchInstancesForMode = useAppStore((s) => s.fetchInstancesForMode);
  const fetchStrategiesForMode = useAppStore((s) => s.fetchStrategiesForMode);
  const runningByMode = useAppStore((s) => s.runningByMode ?? {});
  const pushLog = useAppStore((s) => s.pushLog);

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteCtx, setDeleteCtx] = useState<BotInstance | null>(null);

  const modeUpper = String(mode || "PAPER").toUpperCase() as
    | "PAPER"
    | "BINANCE_DEMO_API"
    | "BINANCE_TESTNET"
    | "BINANCE_LIVE";

  const engineRunning = Boolean(runningByMode[modeUpper]);

  useEffect(() => {
    void fetchInstancesForMode(modeSlug);
    void fetchStrategiesForMode(modeSlug);
  }, [fetchInstancesForMode, fetchStrategiesForMode, modeSlug]);

  const onRefresh = useCallback(() => {
    void fetchInstancesForMode(modeSlug);
  }, [fetchInstancesForMode, modeSlug]);

  function onDeleteTab(inst: BotInstance) {
    const st = String(inst.status).toLowerCase();
    if (st === "running" || st === "paused") {
      pushLog({ level: "warn", msg: "Stop the bot before deleting this instance" });
      return;
    }
    setDeleteCtx(inst);
  }

  return (
    <>
      <div className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950/90">
        <div className="mx-auto max-w-[1920px] flex items-stretch gap-0 px-1 overflow-x-auto overflow-y-hidden scrollbar-thin">
          {/* Overview tab */}
          <button
            type="button"
            role="tab"
            aria-selected={mainView === "overview"}
            onClick={() => setMainView("overview")}
            className={clsx(
              "flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-4 text-xs font-semibold transition-colors",
              mainView === "overview"
                ? "border-sky-500 text-sky-700 dark:text-sky-300"
                : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200",
            )}
          >
            Overview
          </button>

          {/* Instance tabs */}
          {instances.map((inst) => {
            const isActive = mainView === "instance" && selectedInstanceId === inst.id;
            const instanceName = inst.label || `Instance ${inst.id.slice(0, 6)}`;
            const strategyName =
              inst.strategyName ||
              strategies.find((s) => s.id === inst.strategyId)?.name ||
              null;
            const tabLabel = strategyName ? `${instanceName} (${strategyName})` : instanceName;
            const st = String(inst.status).toLowerCase();
            const isOn = engineRunning && st === "running";

            return (
              <div
                key={inst.id}
                className={clsx(
                  "group relative flex h-10 shrink-0 items-center gap-2 border-b-2 px-3 pr-7 text-xs transition-colors cursor-pointer select-none",
                  isActive
                    ? "border-sky-500 bg-sky-50/60 font-semibold text-sky-700 dark:bg-sky-950/20 dark:text-sky-300"
                    : "border-transparent text-slate-500 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-900/50 dark:hover:text-slate-200",
                )}
                role="tab"
                tabIndex={0}
                aria-selected={isActive}
                onClick={() => void enterInstance(inst.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void enterInstance(inst.id); }
                }}
              >
                <span
                  className={clsx("h-2 w-2 shrink-0 rounded-full", statusDotClass(isOn))}
                  title={isOn ? "ON" : "OFF"}
                />
                <span className="whitespace-nowrap" title={tabLabel}>
                  <span>{instanceName}</span>
                  {strategyName ? (
                    <span className="font-normal opacity-80"> ({strategyName})</span>
                  ) : null}
                </span>

                {/* Delete tab button on hover */}
                <button
                  type="button"
                  className="absolute right-0.5 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-slate-400 hover:bg-slate-200 group-hover:flex dark:hover:bg-slate-700"
                  aria-label="Delete instance"
                  title="Delete instance"
                  onClick={(e) => { e.stopPropagation(); onDeleteTab(inst); }}
                >
                  ×
                </button>
              </div>
            );
          })}

          {/* Add new instance */}
          <button
            type="button"
            className="flex h-10 w-10 shrink-0 items-center justify-center border-b-2 border-transparent text-lg text-slate-400 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-slate-900/50 dark:hover:text-slate-300"
            title="New instance"
            onClick={() => {
              void fetchStrategiesForMode(modeSlug);
              setCreateOpen(true);
            }}
          >
            +
          </button>
        </div>
      </div>

      <CreateInstanceModal
        modeSlug={modeSlug}
        strategies={strategies}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          onRefresh();
          void enterInstance(id);
          setCreateOpen(false);
        }}
      />
      {deleteCtx ? (
        <DeleteInstanceModal
          instance={deleteCtx}
          open={Boolean(deleteCtx)}
          onClose={() => setDeleteCtx(null)}
          onDeleted={() => {
            onRefresh();
            setDeleteCtx(null);
            if (deleteCtx?.id === selectedInstanceId) setMainView("overview");
          }}
        />
      ) : null}
    </>
  );
}
