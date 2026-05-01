import { useState, type FormEvent } from "react";
import type { BotInstance } from "../../types/instance";
import { useAppStore } from "../../ws/store";

type Props = {
  instance: BotInstance;
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
};

export function DeleteInstanceModal({ instance, open, onClose, onDeleted }: Props) {
  const deleteInstanceStore = useAppStore((s) => s.deleteInstanceStore);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stopped = String(instance.status).toLowerCase() === "stopped";
  const cap = instance.allotment?.configuredUsdt ?? 0;

  if (!open) return null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!stopped) return;
    setBusy(true);
    setError(null);
    try {
      await deleteInstanceStore(instance.id);
      onDeleted();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal>
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Delete instance</h2>
          <button type="button" className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={onClose}>
            ×
          </button>
        </div>
        <form onSubmit={onSubmit} className="space-y-3 p-4 text-sm">
          <p className="text-slate-700 dark:text-slate-300">
            Delete &quot;{instance.label || instance.id.slice(0, 8)}&quot;?
          </p>
          <p className="text-slate-600 dark:text-slate-400">
            This releases{" "}
            <span className="font-mono font-medium text-slate-900 dark:text-slate-100">${cap.toFixed(2)}</span> of reserved
            capital. Trade history is preserved.
          </p>
          {!stopped ? (
            <p className="text-rose-600 dark:text-rose-400">Stop the bot before deleting.</p>
          ) : null}
          {error ? <p className="text-xs text-rose-600">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <button type="button" className="rounded-lg border border-slate-200 px-3 py-1.5 dark:border-slate-600" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={!stopped || busy}
              className="rounded-lg bg-rose-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
            >
              Delete
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
