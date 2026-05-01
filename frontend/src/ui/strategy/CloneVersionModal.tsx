import { useEffect, useState, type FormEvent } from "react";
import type { Strategy } from "../../types/strategy";

type Props = {
  open: boolean;
  onClose: () => void;
  strategies: Strategy[];
  defaultTargetStrategyId: string;
  onClone: (targetStrategyId: string, label: string) => Promise<void>;
};

export function CloneVersionModal({ open, onClose, strategies, defaultTargetStrategyId, onClone }: Props) {
  const [targetId, setTargetId] = useState(defaultTargetStrategyId);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setTargetId(defaultTargetStrategyId);
  }, [open, defaultTargetStrategyId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!targetId || busy) return;
    setBusy(true);
    try {
      await onClone(targetId, label.trim());
      setLabel("");
      onClose();
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
          <h2 className="text-sm font-semibold">Clone version</h2>
          <button type="button" className="text-slate-500" onClick={onClose} disabled={busy}>
            ×
          </button>
        </div>
        <form onSubmit={submit} className="space-y-3 px-4 py-4">
          <label className="block text-xs font-medium">
            Target strategy
            <select
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-950"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              disabled={busy}
            >
              {strategies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium">
            Label (optional)
            <input
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-950"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={500}
              disabled={busy}
            />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" className="rounded-lg border px-3 py-1.5 text-sm" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
              disabled={busy}
            >
              {busy ? "Cloning…" : "Clone"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
