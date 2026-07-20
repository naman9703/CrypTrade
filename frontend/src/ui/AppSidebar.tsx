import { useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import { useAuthActions } from "../authContext";
import { tradingModeToApiModeSlug, apiModeSlugToModeLabel } from "../lib/tradingModeSlug";
import { EMPTY_BOT_INSTANCES, EMPTY_STRATEGIES } from "../lib/stableEmptyArrays";
import { useAppStore } from "../ws/store";
import { AddAccountModal } from "./accounts/AddAccountModal";
import { ApiKeyModal } from "./accounts/ApiKeyModal";
import { CreateInstanceModal } from "./instances/CreateInstanceModal";
import type { Account } from "../types/accounts";

function statusDotClass(status: string) {
  const s = String(status).toLowerCase();
  if (s === "running") return "bg-emerald-500";
  if (s === "paused") return "bg-amber-400";
  if (s === "error") return "bg-rose-500";
  return "bg-slate-400 dark:bg-slate-600";
}

type Props = {
  open: boolean;
  onClose: () => void;
};

/** Slide-in sidebar from the left. Opened by the hamburger (≡) icon in HeaderBar. */
export function AppSidebar({ open, onClose }: Props) {
  const auth = useAuthActions();
  const mode = useAppStore((s) => s.mode);
  const modeSlug = useMemo(() => tradingModeToApiModeSlug(mode), [mode]);
  const mainView = useAppStore((s) => s.mainView);
  const selectedInstanceId = useAppStore((s) => s.selectedInstanceId);
  const enterInstance = useAppStore((s) => s.enterInstance);
  const setMainView = useAppStore((s) => s.setMainView);
  const accounts = useAppStore((s) => s.accounts);
  const activeAccountByMode = useAppStore((s) => s.activeAccountByMode);
  const instances = useAppStore((s) => s.instancesByMode[modeSlug] ?? EMPTY_BOT_INSTANCES);
  const strategies = useAppStore((s) => s.strategiesByMode[modeSlug] ?? EMPTY_STRATEGIES);
  const selectedStrategyId = useAppStore((s) => s.selectedStrategyId);
  const selectStrategy = useAppStore((s) => s.selectStrategy);
  const createAccount = useAppStore((s) => s.createAccount);
  const fetchStrategiesForMode = useAppStore((s) => s.fetchStrategiesForMode);
  const fetchAccountsForMode = useAppStore((s) => s.fetchAccountsForMode);
  const fetchInstancesForMode = useAppStore((s) => s.fetchInstancesForMode);

  const panelRef = useRef<HTMLDivElement>(null);
  const modeLabel = apiModeSlugToModeLabel(modeSlug);
  const activeAccountId = activeAccountByMode[modeSlug];
  const activeAccount = accounts.find((a) => a.id === activeAccountId);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [addAccountBusy, setAddAccountBusy] = useState(false);
  const [keyAccount, setKeyAccount] = useState<Account | null>(null);
  const [createInstanceOpen, setCreateInstanceOpen] = useState(false);

  async function onCreateAccount(data: { label: string; accountType: "main" | "sub"; binanceUid?: string; notes?: string }) {
    setAddAccountBusy(true);
    try {
      const acc = await createAccount(modeSlug, data);
      await fetchAccountsForMode(modeSlug);
      setAddAccountOpen(false);
      if (modeSlug !== "paper" && acc.requiresApi) {
        setKeyAccount(acc);
      }
    } finally {
      setAddAccountBusy(false);
    }
  }

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open, onClose]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      {/* Overlay */}
      <div
        className={clsx(
          "fixed inset-0 z-40 bg-black/30 transition-opacity duration-200",
          open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
        )}
        aria-hidden
      />

      {/* Drawer */}
      <div
        ref={panelRef}
        className={clsx(
          "fixed left-0 top-0 z-50 flex h-full w-72 flex-col border-r border-slate-200 bg-white shadow-2xl transition-transform duration-200 dark:border-slate-800 dark:bg-slate-950",
          open ? "translate-x-0" : "-translate-x-full",
        )}
        aria-modal
        role="dialog"
        aria-label="Navigation sidebar"
      >
        {/* Sidebar header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">Navigation</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label="Close sidebar"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {/* Account info */}
          <div className="px-4 py-2">
            <div className="mb-1 flex items-center justify-between">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Active account · {modeLabel}</div>
              <button
                type="button"
                onClick={() => setAddAccountOpen(true)}
                className="rounded border border-slate-300 px-1.5 py-0.5 text-[10px] dark:border-slate-700"
              >
                + Add
              </button>
            </div>
            {activeAccount ? (
              <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sky-500/20 text-xs font-bold text-sky-700 dark:text-sky-300">
                  {String(activeAccount.label || "A").slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-slate-800 dark:text-slate-100">{activeAccount.label}</p>
                  <p className="text-[10px] text-slate-500">
                    {activeAccount.credentials?.isActive ? "API connected" : activeAccount.requiresApi === false ? "No API needed" : "API not set"}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-500">No active account</p>
            )}
          </div>

          <div className="mx-4 my-2 border-t border-slate-100 dark:border-slate-800" />

          {/* Overview link */}
          <button
            type="button"
            onClick={() => { setMainView("overview"); onClose(); }}
            className={clsx(
              "flex w-full items-center gap-2.5 px-4 py-2.5 text-sm transition-colors",
              mainView === "overview"
                ? "bg-sky-50 font-semibold text-sky-700 dark:bg-sky-950/30 dark:text-sky-300"
                : "text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-900",
            )}
          >
            <span className="text-base" aria-hidden>⊞</span>
            Overview
          </button>

          {/* Backtest workbench */}
          <button
            type="button"
            onClick={() => { setMainView("backtest"); onClose(); }}
            className={clsx(
              "flex w-full items-center gap-2.5 px-4 py-2.5 text-sm transition-colors",
              mainView === "backtest"
                ? "bg-sky-50 font-semibold text-sky-700 dark:bg-sky-950/30 dark:text-sky-300"
                : "text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-900",
            )}
          >
            <span className="text-base" aria-hidden>≡</span>
            Backtest
          </button>

          <div className="mx-4 my-2 border-t border-slate-100 dark:border-slate-800" />

          {/* Instances */}
          {instances.length > 0 ? (
            <div className="px-2">
              <div className="flex items-center justify-between px-2 pb-1 pt-1">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Instances ({instances.length})</div>
                <button
                  type="button"
                  onClick={() => setCreateInstanceOpen(true)}
                  className="rounded border border-slate-300 px-1.5 py-0.5 text-[10px] dark:border-slate-700"
                >
                  + Add
                </button>
              </div>
              {instances.map((inst) => {
                const isActive = mainView === "instance" && selectedInstanceId === inst.id;
                const label = inst.label || `Instance ${inst.id.slice(0, 6)}`;
                const strategyName =
                  inst.strategyName ||
                  strategies.find((s) => s.id === inst.strategyId)?.name ||
                  null;
                return (
                  <button
                    key={inst.id}
                    type="button"
                    onClick={() => { void enterInstance(inst.id); onClose(); }}
                    className={clsx(
                      "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-xs transition-colors",
                      isActive
                        ? "bg-sky-50 font-semibold text-sky-700 dark:bg-sky-950/30 dark:text-sky-300"
                        : "text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-900",
                    )}
                  >
                    <span className={clsx("h-2 w-2 shrink-0 rounded-full", statusDotClass(inst.status))} />
                    <span className="min-w-0 flex-1 truncate">
                      {label}
                      {strategyName ? ` (${strategyName})` : ""}
                    </span>
                    <span className="text-[10px] capitalize text-slate-400">{inst.status}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="px-4">
              <div className="mb-1 flex items-center justify-between">
                <p className="text-xs text-slate-500">No instances yet.</p>
                <button
                  type="button"
                  onClick={() => setCreateInstanceOpen(true)}
                  className="rounded border border-slate-300 px-1.5 py-0.5 text-[10px] dark:border-slate-700"
                >
                  + Add
                </button>
              </div>
            </div>
          )}

          {strategies.length > 0 ? (
            <>
              <div className="mx-4 my-2 border-t border-slate-100 dark:border-slate-800" />
              <div className="px-2">
                <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Strategies ({strategies.length})
                </div>
                {strategies.map((strat) => {
                  const isSelected = selectedStrategyId === strat.id;
                  return (
                    <button
                      key={strat.id}
                      type="button"
                      onClick={() => {
                        selectStrategy(strat.id);
                        setMainView("overview");
                        onClose();
                      }}
                      className={clsx(
                        "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-xs transition-colors",
                        isSelected
                          ? "bg-violet-50 font-semibold text-violet-700 dark:bg-violet-950/30 dark:text-violet-300"
                          : "text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-900",
                      )}
                    >
                      <span className="text-[11px] text-violet-400" aria-hidden>⊠</span>
                      <span
                        className="min-w-0 flex-1 truncate"
                        title={strat.description ? String(strat.description) : "No description"}
                      >
                        {strat.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <div className="mx-4 my-2 border-t border-slate-100 dark:border-slate-800" />
              <div className="px-4">
                <p className="text-xs text-slate-500">No strategies yet.</p>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="space-y-2 border-t border-slate-200 p-3 dark:border-slate-800">
          <div className="text-[10px] text-slate-400">
            Mode: <span className="font-semibold text-slate-600 dark:text-slate-300">{modeLabel}</span>
          </div>
          {auth?.gated ? (
            <button
              type="button"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              title="Sign out — session cleared, return to login"
              onClick={() => {
                onClose();
                void auth.logout();
              }}
            >
              Log out
            </button>
          ) : null}
        </div>
      </div>
      <AddAccountModal
        open={addAccountOpen}
        busy={addAccountBusy}
        onClose={() => setAddAccountOpen(false)}
        onCreate={onCreateAccount}
      />
      <ApiKeyModal
        open={keyAccount != null}
        account={keyAccount}
        onClose={() => setKeyAccount(null)}
        onSaved={() => {
          void fetchAccountsForMode(modeSlug);
        }}
      />
      <CreateInstanceModal
        modeSlug={modeSlug}
        strategies={strategies}
        open={createInstanceOpen}
        onClose={() => setCreateInstanceOpen(false)}
        onCreated={(id) => {
          void fetchInstancesForMode(modeSlug);
          void enterInstance(id);
          setCreateInstanceOpen(false);
          onClose();
        }}
      />
    </>
  );
}
