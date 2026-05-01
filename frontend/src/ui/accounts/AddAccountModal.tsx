import { useState, type FormEvent } from "react";
import type { CreateAccountDto } from "../../types/accounts";

export function AddAccountModal({
  open,
  onClose,
  onCreate,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (data: CreateAccountDto) => Promise<void>;
  busy: boolean;
}) {
  const [label, setLabel] = useState("Main Account");
  const [accountType, setAccountType] = useState<"main" | "sub">("main");
  const [binanceUid, setBinanceUid] = useState("");
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<string | null>(null);

  if (!open) return null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!label.trim()) {
      setErr("Label is required");
      return;
    }
    try {
      await onCreate({
        label: label.trim(),
        accountType,
        binanceUid: binanceUid.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      setLabel("Main Account");
      setAccountType("main");
      setBinanceUid("");
      setNotes("");
      onClose();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Failed");
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal>
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Add account</h2>
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
          <div className="text-xs font-medium text-slate-700 dark:text-slate-300">Type</div>
          <div className="flex gap-4 text-sm">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="acctType"
                checked={accountType === "main"}
                onChange={() => setAccountType("main")}
              />
              Main
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="acctType"
                checked={accountType === "sub"}
                onChange={() => setAccountType("sub")}
              />
              Subaccount
            </label>
          </div>
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
            Binance UID <span className="font-normal text-slate-500">(optional)</span>
            <input
              value={binanceUid}
              onChange={(e) => setBinanceUid(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-950"
            />
          </label>
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
            Notes <span className="font-normal text-slate-500">(optional)</span>
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
              {busy ? "Creating…" : "Create account"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
