import { useCallback, useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import { tradingModeToApiModeSlug, apiModeSlugToModeLabel } from "../../lib/tradingModeSlug";
import { useAppStore } from "../../ws/store";
import type { Account } from "../../types/accounts";
import { AddAccountModal } from "./AddAccountModal";
import { ApiKeyModal } from "./ApiKeyModal";
import { EditAccountModal } from "./EditAccountModal";

function statusDotClass(account: Account) {
  if (!account.isActive) return "bg-rose-500";
  if (account.accountType === "system" && !account.requiresApi) return "bg-emerald-500";
  if (account.credentials?.isActive) return "bg-emerald-500";
  return "bg-slate-400 dark:bg-slate-500";
}

function accountInitial(label: string) {
  return String(label || "A")
    .trim()
    .slice(0, 2)
    .toUpperCase();
}

/** Sticky bottom-left account widget. Click to open a floating account switcher panel. */
export function AccountWidget() {
  const mode = useAppStore((s) => s.mode);
  const modeSlug = tradingModeToApiModeSlug(mode);
  const accounts = useAppStore((s) => s.accounts);
  const accountsLoading = useAppStore((s) => s.accountsLoading);
  const activeAccountByMode = useAppStore((s) => s.activeAccountByMode);
  const setActiveAccountForMode = useAppStore((s) => s.setActiveAccountForMode);
  const fetchAccountsForMode = useAppStore((s) => s.fetchAccountsForMode);
  const createAccount = useAppStore((s) => s.createAccount);
  const updateAccount = useAppStore((s) => s.updateAccount);
  const deactivateAccount = useAppStore((s) => s.deactivateAccount);

  const isPaper = modeSlug === "paper";
  const activeId = activeAccountByMode[modeSlug];
  const activeAccount = accounts.find((a) => a.id === activeId) ?? accounts[0] ?? null;

  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [keyAccount, setKeyAccount] = useState<Account | null>(null);
  const [editAccount, setEditAccount] = useState<Account | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [activeBusyId, setActiveBusyId] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetchAccountsForMode(modeSlug);
  }, [fetchAccountsForMode, modeSlug]);

  const refresh = useCallback(() => {
    void fetchAccountsForMode(modeSlug);
  }, [fetchAccountsForMode, modeSlug]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  async function onCreateAccount(data: Parameters<typeof createAccount>[1]) {
    setAddBusy(true);
    try {
      const acc = await createAccount(modeSlug, data);
      setAddOpen(false);
      if (!isPaper && acc.requiresApi) setKeyAccount(acc);
    } finally {
      setAddBusy(false);
    }
  }

  const modeLabel = apiModeSlugToModeLabel(modeSlug);

  return (
    <>
      {/* Floating panel */}
      {open ? (
        <div
          ref={panelRef}
          className="fixed bottom-16 left-4 z-50 w-72 rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
        >
          <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-700">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
              Accounts
              <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                {modeLabel}
              </span>
            </span>
            <button
              type="button"
              className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
              onClick={() => setOpen(false)}
            >
              ✕
            </button>
          </div>

          {accountsLoading && accounts.length === 0 ? (
            <p className="px-3 py-3 text-xs text-slate-500">Loading…</p>
          ) : null}

          <ul className="max-h-64 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
            {accounts.map((a) => {
              const isEngineActive = !isPaper && activeAccountByMode[modeSlug] === a.id;
              const canSetActive = !isPaper && a.isActive && a.requiresApi !== false;
              return (
                <li key={a.id} className={clsx("px-3 py-2", isEngineActive && "bg-sky-50/70 dark:bg-sky-950/20")}>
                  <div className="flex items-center gap-2">
                    <span className={clsx("h-2 w-2 shrink-0 rounded-full", statusDotClass(a))} />
                    <span className="flex-1 truncate text-xs font-medium text-slate-800 dark:text-slate-100">
                      {a.label}
                      {isEngineActive ? <span className="ml-1.5 text-amber-500 text-[10px]">★ active</span> : null}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1 pl-4">
                    {canSetActive && !isEngineActive ? (
                      <button
                        type="button"
                        disabled={activeBusyId != null}
                        className="rounded border border-slate-300 px-2 py-0.5 text-[10px] font-medium hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-800"
                        onClick={() => {
                          setActiveBusyId(a.id);
                          void setActiveAccountForMode(modeSlug, a.id).finally(() => setActiveBusyId(null));
                        }}
                      >
                        {activeBusyId === a.id ? "…" : "Set Active"}
                      </button>
                    ) : null}
                    {a.accountType !== "system" ? (
                      <button
                        type="button"
                        className="rounded border border-slate-300 px-2 py-0.5 text-[10px] font-medium hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800"
                        onClick={() => { setEditAccount(a); setEditOpen(true); }}
                      >
                        Edit
                      </button>
                    ) : null}
                    {a.requiresApi !== false ? (
                      <button
                        type="button"
                        className="rounded border border-slate-300 px-2 py-0.5 text-[10px] font-medium hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800"
                        onClick={() => setKeyAccount(a)}
                      >
                        Keys
                      </button>
                    ) : null}
                    {a.accountType !== "system" ? (
                      <button
                        type="button"
                        className="rounded border border-rose-200 px-2 py-0.5 text-[10px] font-medium text-rose-600 hover:bg-rose-50 dark:border-rose-700/50 dark:hover:bg-rose-950/30"
                        onClick={() => {
                          if (confirm(`Deactivate "${a.label}"?`)) void deactivateAccount(a.id);
                        }}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>

          {!isPaper ? (
            <div className="border-t border-slate-200 p-2 dark:border-slate-700">
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="w-full rounded-lg border border-dashed border-slate-300 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-slate-900"
              >
                + Add subaccount
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Sticky trigger button */}
      <button
        type="button"
        title={activeAccount ? `Account: ${activeAccount.label} (${modeLabel})` : "Switch account"}
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          "fixed bottom-4 left-4 z-40 flex h-11 items-center gap-2 rounded-full border pl-2 pr-3 text-[11px] font-bold shadow-md transition-all",
          "border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800",
          open && "ring-2 ring-sky-400/60",
        )}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-slate-100 text-[12px] dark:border-slate-700 dark:bg-slate-800">
          {activeAccount ? accountInitial(activeAccount.label) : "👤"}
        </span>
        <span className="min-w-0 max-w-[10rem] truncate text-left text-xs font-medium">
          {activeAccount ? activeAccount.label : "Account"}
          <span className="ml-1 text-[10px] text-slate-500 dark:text-slate-400">
            ({activeAccount?.accountType === "system" ? "main" : "sub"})
          </span>
        </span>
      </button>

      {/* Modals */}
      <AddAccountModal open={addOpen} busy={addBusy} onClose={() => setAddOpen(false)} onCreate={onCreateAccount} />
      <ApiKeyModal
        open={keyAccount != null}
        account={keyAccount}
        onClose={() => setKeyAccount(null)}
        onSaved={refresh}
      />
      <EditAccountModal
        open={editOpen}
        account={editAccount}
        busy={editBusy}
        onClose={() => { setEditOpen(false); setEditAccount(null); }}
        onSave={async (id, patch) => {
          setEditBusy(true);
          try { await updateAccount(id, patch); }
          finally { setEditBusy(false); }
        }}
      />
    </>
  );
}
