import { useAppStore } from "../ws/store";

export function TradingModeBadge() {
  const mode = useAppStore((s) => s.mode);
  const m = String(mode || "PAPER").toUpperCase();

  const cfg =
    m === "BINANCE_LIVE"
      ? {
          label: "LIVE",
          className:
            "border-emerald-400/50 bg-emerald-600 text-white shadow-emerald-900/40 dark:bg-emerald-500 dark:text-emerald-950 dark:shadow-emerald-950/50 dark:border-emerald-300/40",
        }
      : m === "BINANCE_DEMO_API"
        ? {
            label: "DEMO",
            className:
              "border-amber-400/40 bg-amber-500/95 text-amber-950 shadow-amber-900/25 dark:bg-amber-500/90 dark:text-amber-950 dark:border-amber-300/30",
          }
        : m === "BINANCE_TESTNET"
          ? {
              label: "TESTNET",
              className:
                "border-sky-500/40 bg-sky-600 text-white shadow-sky-900/30 dark:bg-sky-500 dark:border-sky-400/35",
            }
          : null;

  if (!cfg) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-5 right-5 z-[100] select-none"
      aria-hidden
    >
      <div
        className={`rounded-md border px-2.5 py-1 text-[11px] font-bold uppercase tracking-widest shadow-lg backdrop-blur-sm ${cfg.className}`}
      >
        {cfg.label}
      </div>
    </div>
  );
}
