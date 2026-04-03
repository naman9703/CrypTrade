import { useEffect } from "react";
import { clsx } from "clsx";
import { HeaderBar } from "./HeaderBar";
import { ChartPanel } from "./ChartPanel";
import { TradingPanel } from "./TradingPanel";
import { InsightsPanel } from "./InsightsPanel";
import { PortfolioPanel } from "./PortfolioPanel";
import { LogsPanel } from "./LogsPanel";
import { useAppStore } from "../ws/store";

export function App() {
  const connect = useAppStore((s) => s.connect);
  const connected = useAppStore((s) => s.ws.connected);

  useEffect(() => {
    connect();
  }, [connect]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
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
          <div className="lg:col-span-2 rounded-xl border border-slate-800 bg-slate-950/60 shadow-glow">
            <PortfolioPanel />
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-950/60 shadow-glow">
            <ChartPanel />
          </div>

          <div className="grid gap-4">
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 shadow-glow">
              <TradingPanel />
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 shadow-glow">
              <InsightsPanel />
            </div>
          </div>

          <div className="lg:col-span-2 rounded-xl border border-slate-800 bg-slate-950/60 shadow-glow">
            <LogsPanel />
          </div>
        </div>

        <div className="mt-3 text-xs text-slate-500">
          Status:{" "}
          <span className={connected ? "text-emerald-400" : "text-rose-400"}>
            {connected ? "WS connected" : "WS disconnected"}
          </span>
        </div>
      </div>
    </div>
  );
}

