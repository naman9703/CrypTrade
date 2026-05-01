import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../api/client";

type Props = {
  instanceId: string;
  initialLabel: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
};

export function EditInstanceLabelModal({ instanceId, initialLabel, open, onClose, onSaved }: Props) {
  const [label, setLabel] = useState(initialLabel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setLabel(initialLabel);
  }, [open, initialLabel]);

  if (!open) return null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!label.trim()) {
      setError("Label required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.patchInstanceLabel(instanceId, label.trim());
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal>
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Edit label</h2>
          <button type="button" className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={onClose}>
            ×
          </button>
        </div>
        <form onSubmit={onSubmit} className="space-y-3 p-4">
          <input
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-950"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={200}
          />
          {error ? <p className="text-xs text-rose-600">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <button type="button" className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm dark:border-slate-600" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
