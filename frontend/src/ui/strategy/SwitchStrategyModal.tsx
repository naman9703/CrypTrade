type Props = {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  currentLabel: string;
  targetLabel: string;
  busy?: boolean;
};

export function SwitchStrategyModal({ open, onClose, onConfirm, currentLabel, targetLabel, busy }: Props) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="switch-strategy-title"
        className="w-full max-w-md rounded-xl border-2 border-rose-600/80 bg-white shadow-xl dark:border-rose-500 dark:bg-slate-900"
      >
        <div className="flex items-start justify-between border-b border-rose-200 px-4 py-3 dark:border-rose-900/60">
          <h2 id="switch-strategy-title" className="text-sm font-semibold text-rose-800 dark:text-rose-200">
            Switch strategy
          </h2>
          <button
            type="button"
            className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="space-y-3 px-4 py-4 text-sm text-slate-700 dark:text-slate-300">
          <p>The bot is currently running on:</p>
          <p className="rounded-md bg-slate-100 px-2 py-1 font-medium dark:bg-slate-800">{currentLabel}</p>
          <p>Switching to:</p>
          <p className="rounded-md bg-slate-100 px-2 py-1 font-medium dark:bg-slate-800">{targetLabel}</p>
          <p className="text-rose-700 dark:text-rose-300">
            This will <strong>stop the bot immediately</strong>. You will need to restart it manually after the switch.
          </p>
          <p className="font-medium text-rose-800 dark:text-rose-200">
            Any open positions will <strong>not</strong> be closed automatically.
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-700">
          <button
            type="button"
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            onClick={() => void onConfirm()}
            disabled={busy}
          >
            {busy ? "Stopping…" : "Stop bot & switch"}
          </button>
        </div>
      </div>
    </div>
  );
}
