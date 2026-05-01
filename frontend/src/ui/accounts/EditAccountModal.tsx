import { useEffect, useState, type FormEvent } from "react";
import type { Account } from "../../types/accounts";

export function EditAccountModal({
  open,
  account,
  onClose,
  onSave,
  busy,
}: {
  open: boolean;
  account: Account | null;
  onClose: () => void;
  onSave: (accountId: string, patch: { label: string; notes: string | null; binance_uid: string | null }) => Promise<void>;
  busy: boolean;
}) {
  const [label, setLabel] = useState("");
  const [binanceUid, setBinanceUid] = useState("");
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!account) return;
    setLabel(account.label);
    setBinanceUid(account.binanceUid ?? "");
    setNotes(account.notes ?? "");
    setErr(null);
  }, [account, open]);

  if (!open || !account) return null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!label.trim()) {
      setErr("Label is required");
      return;
    }
    try {
      await onSave(account.id, {
        label: label.trim(),
        notes: notes.trim() ? notes.trim() : null,
        binance_uid: binanceUid.trim() ? binanceUid.trim() : null,
      });
      onClose();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed");
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal>
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Edit account</h2>
        <form className="mt-4 space-y-3" onSubmit={onSubmit}>
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
            Label<span className="text-rose-500">*</span>
            <input
              required
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-950"
            />
          </label>
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
            Binance UID
            <input
              value={binanceUid}
              onChange={(e) => setBinanceUid(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-950"
            />
          </label>
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
            Notes
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-950"
            />
          </label>
          {err ? <p className="text-xs text-rose-600 dark:text-rose-400">{err}</p> : null}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-sky-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
