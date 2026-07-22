import { useEffect } from "react";
import { useAppStore } from "../ws/store";

const MODE_LABELS: Record<string, string> = {
  PAPER: "Paper",
  BINANCE_DEMO_API: "Demo",
  BINANCE_TESTNET: "Testnet",
  BINANCE_LIVE: "Live",
};

const MODE_SWITCH_TIMEOUT_MS = 15_000;

export function ModeSwitchOverlay() {
  const pending = useAppStore((s) => s.modeSwitchPending);

  useEffect(() => {
    if (!pending) return;
    const target = pending;
    const t = window.setTimeout(() => {
      const st = useAppStore.getState();
      if (st.modeSwitchPending !== target) return;
      useAppStore.setState({ modeSwitchPending: null });
      st.pushLog({
        level: "warn",
        msg: `Mode switch to ${MODE_LABELS[target] ?? target} timed out — UI refreshed anyway`,
      });
    }, MODE_SWITCH_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [pending]);

  if (!pending) return null;

  const label = MODE_LABELS[pending] ?? pending;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-950/40 backdrop-blur-[2px]"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="flex flex-col items-center gap-3 rounded-xl border border-slate-300/70 bg-white/95 px-6 py-5 shadow-xl dark:border-slate-700 dark:bg-slate-900/95">
        <div
          className="h-9 w-9 animate-spin rounded-full border-[3px] border-sky-500 border-t-transparent dark:border-sky-400"
          aria-hidden
        />
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Switching to {label}…</p>
        <p className="text-xs text-slate-500 dark:text-slate-400">Reloading chart and account data</p>
      </div>
    </div>
  );
}
