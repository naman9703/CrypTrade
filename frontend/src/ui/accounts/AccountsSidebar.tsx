import { useCallback, useEffect, useState } from "react";
import { useAuthActions } from "../../authContext";
import { apiModeSlugToModeLabel, tradingModeToApiModeSlug } from "../../lib/tradingModeSlug";
import { useAppStore } from "../../ws/store";
import type { Account } from "../../types/accounts";
import { AddAccountModal } from "./AddAccountModal";
import { ApiKeyModal } from "./ApiKeyModal";
import { EditAccountModal } from "./EditAccountModal";

function statusDot(account: Account) {
  if (!account.isActive) {
    return "bg-rose-500 ring-2 ring-rose-200 dark:ring-rose-900";
  }
  if (account.accountType === "system" && !account.requiresApi) {
    return "bg-emerald-500 ring-2 ring-emerald-200 dark:ring-emerald-900";
  }
  if (account.credentials?.isActive) {
    return "bg-emerald-500 ring-2 ring-emerald-200 dark:ring-emerald-900";
  }
  return "bg-slate-400 ring-2 ring-slate-200 dark:bg-slate-500 dark:ring-slate-700";
}

function modeBadgeClass(slug: string) {
  switch (slug) {
    case "live":
      return "bg-emerald-600/90 text-white";
    case "testnet":
      return "bg-sky-600/90 text-white";
    case "demo_api":
      return "bg-amber-500/95 text-amber-950";
    default:
      return "bg-slate-600/90 text-white";
  }
}

export function AccountsSidebar() {
  const auth = useAuthActions();
  const mode = useAppStore((s) => s.mode);
  const accounts = useAppStore((s) => s.accounts);
  const accountsLoading = useAppStore((s) => s.accountsLoading);
  const accountsError = useAppStore((s) => s.accountsError);
  const selectedAccountId = useAppStore((s) => s.selectedAccountId);
  const selectAccount = useAppStore((s) => s.selectAccount);
  const fetchAccountsForMode = useAppStore((s) => s.fetchAccountsForMode);
  const createAccount = useAppStore((s) => s.createAccount);
  const updateAccount = useAppStore((s) => s.updateAccount);
  const deactivateAccount = useAppStore((s) => s.deactivateAccount);
  const activeAccountByMode = useAppStore((s) => s.activeAccountByMode);
  const setActiveAccountForMode = useAppStore((s) => s.setActiveAccountForMode);
  const accountsCollapsed = useAppStore((s) => s.layout.accountsSidebarCollapsed);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);

  const modeSlug = tradingModeToApiModeSlug(mode);
  const modeLabel = apiModeSlugToModeLabel(modeSlug);
  const isPaper = modeSlug === "paper";

  const [addOpen, setAddOpen] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [keyAccount, setKeyAccount] = useState<Account | null>(null);
  const [editAccount, setEditAccount] = useState<Account | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [activeBusyId, setActiveBusyId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void fetchAccountsForMode(modeSlug);
  }, [fetchAccountsForMode, modeSlug]);

  useEffect(() => {
    void fetchAccountsForMode(modeSlug);
  }, [fetchAccountsForMode, modeSlug]);

  const dbUserRequired = accountsError === "db_user_required";

  async function onCreateAccount(data: Parameters<typeof createAccount>[1]) {
    setAddBusy(true);
    try {
      const acc = await createAccount(modeSlug, data);
      setAddOpen(false);
      if (!isPaper && acc.requiresApi) {
        setKeyAccount(acc);
      }
    } finally {
      setAddBusy(false);
    }
  }

  if (accountsCollapsed) {
    return (
      <>
        <div className="flex w-10 shrink-0 flex-col items-center rounded-xl border border-slate-200 bg-slate-100/95 py-2 dark:border-slate-800 dark:bg-slate-950/60">
          <button
            type="button"
            title="Expand accounts"
            className="rounded-md p-1 text-slate-600 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-800"
            onClick={() => setSidebarCollapsed("accounts", false)}
          >
            <span className="text-lg" aria-hidden>
              👤
            </span>
          </button>
        </div>
        <AddAccountModal
          open={addOpen}
          busy={addBusy}
          onClose={() => setAddOpen(false)}
          onCreate={onCreateAccount}
        />
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
          onClose={() => {
            setEditOpen(false);
            setEditAccount(null);
          }}
          onSave={async (id, patch) => {
            setEditBusy(true);
            try {
              await updateAccount(id, patch);
            } finally {
              setEditBusy(false);
            }
          }}
        />
      </>
    );
  }

  return (
    <div className="w-[280px] shrink-0 rounded-xl border border-slate-200 bg-slate-100/95 shadow-glow-light dark:border-slate-800 dark:bg-slate-950/60 dark:shadow-glow">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">Accounts</h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={isPaper || dbUserRequired}
            onClick={() => setAddOpen(true)}
            className="rounded-md bg-sky-600 px-2 py-1 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            + Add
          </button>
          <button
            type="button"
            title="Collapse"
            className="rounded p-1 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800"
            onClick={() => setSidebarCollapsed("accounts", true)}
          >
            ←
          </button>
        </div>
      </div>
      <div className="px-3 py-2 text-[11px] text-slate-600 dark:text-slate-400">
        Mode:{" "}
        <span className={`ml-1 rounded px-1.5 py-0.5 font-bold ${modeBadgeClass(modeSlug)}`}>{modeLabel}</span>
      </div>

      {auth?.gated && dbUserRequired ? (
        <p className="px-3 pb-3 text-xs text-amber-700 dark:text-amber-300">
          Sign in with a database user (seeded admin) to manage accounts. Env-only login cannot access account APIs.
        </p>
      ) : null}

      {accountsLoading && accounts.length === 0 ? (
        <p className="px-3 pb-3 text-xs text-slate-500">Loading…</p>
      ) : null}
      {accountsError && !dbUserRequired ? (
        <p className="px-3 pb-3 text-xs text-rose-600 dark:text-rose-400">{accountsError}</p>
      ) : null}

      <ul className="max-h-[420px] space-y-0 overflow-y-auto border-t border-slate-200 dark:border-slate-800">
        {accounts.map((a) => {
          const isEngineActive = !isPaper && activeAccountByMode[modeSlug] === a.id;
          const canSetEngineActive =
            !isPaper &&
            !dbUserRequired &&
            a.requiresApi !== false &&
            a.isActive;
          return (
          <li
            key={a.id}
            className={`border-b border-slate-200 px-3 py-2.5 dark:border-slate-800 ${
              selectedAccountId === a.id ? "bg-sky-50/80 dark:bg-sky-950/30" : ""
            }`}
          >
            <button
              type="button"
              onClick={() => {
                selectAccount(a.id);
                /** Align UI selection with engine binding so Start uses this account. */
                if (!isPaper && canSetEngineActive && !isEngineActive) {
                  setActiveBusyId(a.id);
                  void setActiveAccountForMode(modeSlug, a.id).finally(() => setActiveBusyId(null));
                }
              }}
              className="flex w-full items-start gap-2 text-left"
            >
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${statusDot(a)}`} title="status" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1">
                  <span
                    className={
                      isEngineActive
                        ? "text-amber-500"
                        : "text-slate-300 dark:text-slate-600"
                    }
                    title={
                      isEngineActive ? "Active for this mode (exchange uses this account’s API keys)" : "Not the active account"
                    }
                  >
                    {isEngineActive ? "★" : "○"}
                  </span>
                  <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{a.label}</span>
                  <span className={`rounded px-1 py-px text-[9px] font-bold uppercase ${modeBadgeClass(modeSlug)}`}>
                    {modeLabel}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-slate-600 dark:text-slate-400">
                  API:{" "}
                  {a.accountType === "system" && !a.requiresApi ? (
                    <span className="text-slate-500">not required</span>
                  ) : a.credentials?.isActive ? (
                    <span className="font-mono text-emerald-700 dark:text-emerald-400">{a.credentials.apiKey}</span>
                  ) : (
                    <span className="text-slate-500">not set</span>
                  )}
                </p>
                <p className="text-[10px] text-slate-500">
                  {a.isActive ? (
                    <span className="text-emerald-600 dark:text-emerald-400">✓ Active</span>
                  ) : (
                    <span className="text-rose-600 dark:text-rose-400">✗ Inactive</span>
                  )}
                </p>
              </div>
            </button>
            <div className="mt-2 flex flex-wrap gap-1.5 pl-4">
              {!isPaper ? (
                <button
                  type="button"
                  disabled={!canSetEngineActive || isEngineActive || activeBusyId != null}
                  title={
                    isEngineActive
                      ? "Already the active account for this mode"
                      : !canSetEngineActive
                        ? "Requires an active account row"
                        : undefined
                  }
                  onClick={() => {
                    setActiveBusyId(a.id);
                    void setActiveAccountForMode(modeSlug, a.id).finally(() => setActiveBusyId(null));
                  }}
                  className="rounded border border-slate-300 px-2 py-0.5 text-[10px] font-medium disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-600"
                >
                  {activeBusyId === a.id ? "…" : "Set Active"}
                </button>
              ) : null}
              {a.accountType !== "system" ? (
                <button
                  type="button"
                  onClick={() => {
                    setEditAccount(a);
                    setEditOpen(true);
                  }}
                  className="rounded border border-slate-300 px-2 py-0.5 text-[10px] font-medium dark:border-slate-600"
                >
                  Edit
                </button>
              ) : null}
              {a.requiresApi !== false ? (
                <button
                  type="button"
                  onClick={() => setKeyAccount(a)}
                  className="rounded border border-slate-300 px-2 py-0.5 text-[10px] font-medium dark:border-slate-600"
                >
                  Keys
                </button>
              ) : null}
              {a.accountType !== "system" ? (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setMenuId(menuId === a.id ? null : a.id)}
                    className="rounded border border-slate-300 px-2 py-0.5 text-[10px] font-medium dark:border-slate-600"
                  >
                    ···
                  </button>
                  {menuId === a.id ? (
                    <div className="absolute right-0 z-10 mt-1 w-36 rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
                      <button
                        type="button"
                        className="block w-full px-3 py-1.5 text-left text-[11px] text-rose-600 hover:bg-slate-50 dark:hover:bg-slate-800"
                        onClick={() => {
                          setMenuId(null);
                          if (confirm(`Deactivate “${a.label}”?`)) {
                            void deactivateAccount(a.id);
                          }
                        }}
                      >
                        Deactivate
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </li>
        );
        })}
      </ul>

      {!isPaper && !dbUserRequired ? (
        <div className="border-t border-slate-200 p-2 dark:border-slate-800">
          <button
            type="button"
            disabled={addBusy}
            onClick={() => setAddOpen(true)}
            className="w-full rounded-lg border border-dashed border-slate-300 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-slate-900"
          >
            + Add subaccount
          </button>
        </div>
      ) : null}

      <AddAccountModal
        open={addOpen}
        busy={addBusy}
        onClose={() => setAddOpen(false)}
        onCreate={onCreateAccount}
      />

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
        onClose={() => {
          setEditOpen(false);
          setEditAccount(null);
        }}
        onSave={async (id, patch) => {
          setEditBusy(true);
          try {
            await updateAccount(id, patch);
          } finally {
            setEditBusy(false);
          }
        }}
      />
    </div>
  );
}
