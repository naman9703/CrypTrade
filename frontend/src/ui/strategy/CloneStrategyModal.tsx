import { useEffect, useState, type FormEvent } from "react";

type Props = {
  open: boolean;
  sourceName: string;
  onClose: () => void;
  onClone: (name: string) => Promise<void>;
};

export function CloneStrategyModal({ open, sourceName, onClose, onClone }: Props) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setName(`${sourceName} copy`.slice(0, 200));
  }, [open, sourceName]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onClone(trimmed);
      setName("");
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
          <h2 className="text-sm font-semibold">Duplicate strategy</h2>
          <button type="button" className="text-slate-500" onClick={onClose} disabled={busy}>
            ×
          </button>
        </div>
        <form onSubmit={submit} className="space-y-3 px-4 py-4">
          <p className="text-[11px] text-slate-600 dark:text-slate-400">
            Creates a new strategy config with the same saved settings as{" "}
            <span className="font-semibold text-slate-800 dark:text-slate-200">{sourceName}</span>.
          </p>
          <label className="block text-xs font-medium">
            New strategy name
            <input
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-950"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              required
              autoFocus
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
              disabled={busy || !name.trim()}
            >
              {busy ? "Creating…" : "Create copy"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
