import { useEffect } from "react";
import { clsx } from "clsx";
import { HeaderBar } from "./HeaderBar";
import { HeaderSignalsStrip } from "./HeaderSignalsStrip";
import { ChartPanel } from "./ChartPanel";
import { ChartErrorBoundary } from "./ChartErrorBoundary";
import { TradingPanel } from "./TradingPanel";
import { InsightsPanel } from "./InsightsPanel";
import { PortfolioPanel } from "./PortfolioPanel";
import { LogsPanel } from "./LogsPanel";
import { ThemeToggle } from "./ThemeToggle";
import { TradingModeBadge } from "./TradingModeBadge";
import { useAuthActions } from "../authContext";
import { hydrateStateViaHttp, useAppStore } from "../ws/store";

export function App() {
  const auth = useAuthActions();
  const connect = useAppStore((s) => s.connect);
  const connected = useAppStore((s) => s.ws.connected);

  useEffect(() => {
    connect();
  }, [connect]);

  /** When WS is down (proxy/buffering), keep UI fresh via polled `/api/state`. */
  useEffect(() => {
    if (connected) return;
    void hydrateStateViaHttp();
    const t = window.setInterval(() => void hydrateStateViaHttp(), 4000);
    return () => window.clearInterval(t);
  }, [connected]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <HeaderSignalsStrip />
      <HeaderBar />

      <div className="mx-auto max-w-[1600px] px-4 pb-6 pt-4">
        <div
          className={clsx(
            "grid gap-4",
            "grid-cols-1",
            "lg:grid-cols-[1.6fr_1fr]",
            "auto-rows-min"
          )}
        >
          <div className="lg:col-span-2 rounded-xl border border-slate-200 bg-slate-100/95 shadow-glow-light dark:border-slate-800 dark:bg-slate-950/60 dark:shadow-glow">
            <PortfolioPanel />
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-100/95 shadow-glow-light dark:border-slate-800 dark:bg-slate-950/60 dark:shadow-glow">
            <ChartErrorBoundary>
              <ChartPanel />
            </ChartErrorBoundary>
          </div>

          <div className="grid gap-4">
            <div className="rounded-xl border border-slate-200 bg-slate-100/95 shadow-glow-light dark:border-slate-800 dark:bg-slate-950/60 dark:shadow-glow">
              <TradingPanel />
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-100/95 shadow-glow-light dark:border-slate-800 dark:bg-slate-950/60 dark:shadow-glow">
              <InsightsPanel />
            </div>
          </div>

          <div className="lg:col-span-2 rounded-xl border border-slate-200 bg-slate-100/95 shadow-glow-light dark:border-slate-800 dark:bg-slate-950/60 dark:shadow-glow">
            <LogsPanel />
          </div>
        </div>

        <div className="mt-3 text-xs text-slate-600 dark:text-slate-500">
          Status:{" "}
          <span className={connected ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
            {connected ? "WS connected" : "WS disconnected"}
          </span>
        </div>

        <div className="mt-6 flex items-center justify-between gap-4">
          {auth?.gated ? (
            <button
              type="button"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              title="Sign out — session cleared, return to login"
              onClick={() => {
                void auth.logout();
              }}
            >
              Log out
            </button>
          ) : (
            <span aria-hidden className="inline-block min-w-0" />
          )}
          <ThemeToggle />
        </div>
      </div>

      <TradingModeBadge />
    </div>
  );
}


