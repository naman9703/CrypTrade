import { useEffect, useState, type FormEvent } from "react";
import type { StrategyUsageContext } from "../../types/strategyUsage";

type Props = {
  open: boolean;
  usage: StrategyUsageContext | null;
  busy?: boolean;
  startOnNewName?: boolean;
  onClose: () => void;
  onSaveAnyway: () => void | Promise<void>;
  onSaveAsNew: (name: string) => void | Promise<void>;
  defaultNewName?: string;
};

export function StrategySaveConfirmModal({
  open,
  usage,
  busy,
  startOnNewName = false,
  onClose,
  onSaveAnyway,
  onSaveAsNew,
  defaultNewName = "New Strategy",
}: Props) {
  const [showNewName, setShowNewName] = useState(false);
  const [newName, setNewName] = useState(defaultNewName);

  useEffect(() => {
    if (open) {
      setNewName(defaultNewName);
      setShowNewName(Boolean(startOnNewName));
    }
  }, [open, defaultNewName, startOnNewName]);

  if (!open || !usage) return null;

  async function submitNew(e: FormEvent) {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed || busy) return;
    await onSaveAsNew(trimmed);
    setShowNewName(false);
  }

  const others = usage.instances.length - 1;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
          <h2 className="text-sm font-semibold">Shared strategy</h2>
          <button type="button" className="text-slate-500" onClick={onClose} disabled={busy}>
            ×
          </button>
        </div>
        <div className="space-y-3 px-4 py-4 text-xs text-slate-600 dark:text-slate-300">
          <p>
            This strategy is used by <b>{usage.instanceCount}</b> instance{usage.instanceCount === 1 ? "" : "s"}
            {others > 0 ? ` (${others} other than the active tab)` : ""}.
          </p>
          {!showNewName ? (
            <>
              <p>
                <b>Save anyway</b> updates the shared config for every instance and mode using it.
                <b> Save as new</b> forks a private copy and binds only the active instance to it.
              </p>
              {usage.blockReason ? (
                <p className="rounded-md bg-amber-50 px-2 py-1.5 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
                  {usage.blockReason}
                </p>
              ) : null}
              <div className="flex flex-wrap justify-end gap-2 pt-1">
                <button
                  type="button"
                  className="rounded-lg border px-3 py-1.5 text-sm"
                  onClick={onClose}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-sky-500/60 px-3 py-1.5 text-sm font-semibold text-sky-700 disabled:opacity-40 dark:text-sky-300"
                  disabled={busy || !usage.canSaveInPlace}
                  title={!usage.canSaveInPlace ? usage.blockReason ?? undefined : undefined}
                  onClick={() => void onSaveAnyway()}
                >
                  {busy ? "Saving…" : "Save anyway"}
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                  disabled={busy}
                  onClick={() => {
                    setNewName(defaultNewName);
                    setShowNewName(true);
                  }}
                >
                  Save as new
                </button>
              </div>
            </>
          ) : (
            <form onSubmit={submitNew} className="space-y-3">
              <label className="block text-xs font-medium">
                New strategy name
                <input
                  className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-950"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  maxLength={200}
                  required
                  autoFocus
                  disabled={busy}
                />
              </label>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded-lg border px-3 py-1.5 text-sm"
                  onClick={() => setShowNewName(false)}
                  disabled={busy}
                >
                  Back
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                  disabled={busy || !newName.trim()}
                >
                  {busy ? "Creating…" : "Create & bind instance"}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
