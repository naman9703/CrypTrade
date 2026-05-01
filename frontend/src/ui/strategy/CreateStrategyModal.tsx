import { useState, type FormEvent } from "react";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreate: (data: { name: string; description: string; tags: string[] }) => Promise<void>;
};

export function CreateStrategyModal({ open, onClose, onCreate }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tagsStr, setTagsStr] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      const tags = tagsStr
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 48);
      await onCreate({ name: n, description: description.trim(), tags });
      setName("");
      setDescription("");
      setTagsStr("");
      onClose();
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">New strategy</h2>
          <button
            type="button"
            className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            onClick={onClose}
            disabled={busy}
          >
            ×
          </button>
        </div>
        <form onSubmit={onSubmit} className="space-y-3 px-4 py-4">
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
            Name *
            <input
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-950"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={200}
              disabled={busy}
            />
          </label>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
            Description
            <textarea
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-950"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={4000}
              disabled={busy}
            />
          </label>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
            Tags (comma separated)
            <input
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-950"
              value={tagsStr}
              onChange={(e) => setTagsStr(e.target.value)}
              disabled={busy}
            />
          </label>
          <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-2 text-[11px] text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100">
            <p className="font-medium">Starting config</p>
            <p className="mt-1">Clones from the current running bot config for this mode as version 1.</p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
              disabled={busy || !name.trim()}
            >
              {busy ? "Creating…" : "Create strategy"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
