import { lazy, Suspense, useEffect, useState } from "react";
import { clsx } from "clsx";
import { HeaderBar } from "./HeaderBar";
import { HeaderSignalsStrip } from "./HeaderSignalsStrip";
import { RegimeEngineStrip } from "./RegimeEngineStrip";
import { ActivityToasts } from "./ActivityToasts";
import { ChartPanel } from "./ChartPanel";
import { ChartErrorBoundary } from "./ChartErrorBoundary";
import { TradingPanel } from "./TradingPanel";
import { InsightsPanel } from "./InsightsPanel";
import { PortfolioPanel } from "./PortfolioPanel";
import { MlctsLayersPanel } from "./MlctsLayersPanel";
import type { MlctsLayerStatus } from "./MlctsLayersPanel";
import { LiqCascadeRadarPanel } from "./LiqCascadeRadarPanel";
import type { LiqCascadeRadarStatus } from "./LiqCascadeRadarPanel";
import { LogsPanel } from "./LogsPanel";
import { ThemeToggle } from "./ThemeToggle";
import { TradingModeBadge } from "./TradingModeBadge";
import { StrategySidebar } from "./strategy/StrategySidebar";
import { InstanceNavBar } from "./instances/InstanceNavBar";
import { AccountWidget } from "./accounts/AccountWidget";
import { AppSidebar } from "./AppSidebar";
import { useAuthActions } from "../authContext";
import { hydrateStateViaHttp, useAppStore } from "../ws/store";
import { OverviewPage } from "./analytics/OverviewPage";
import { ModeSwitchOverlay } from "./ModeSwitchOverlay";

const BacktestPage = lazy(() =>
  import("./backtest/BacktestPage").then((m) => ({ default: m.BacktestPage })),
);

function MlctsLayersSection() {
  const manualStrategy = useAppStore((s) => String(s.bot?.manualStrategy ?? "").toUpperCase());
  const fromBot = useAppStore((s) => s.bot?.mlctsLayerStatus as MlctsLayerStatus | undefined);
  const fromMarket = useAppStore((s) => (s.market as { mlctsLayerStatus?: MlctsLayerStatus } | undefined)?.mlctsLayerStatus);
  if (manualStrategy !== "MLCTS") return null;
  return (
    <div className="lg:col-span-2">
      <MlctsLayersPanel status={fromMarket ?? fromBot} />
    </div>
  );
}

function LiqCascadeRadarSection() {
  const manualStrategy = useAppStore((s) => String(s.bot?.manualStrategy ?? "").toUpperCase());
  const fromBot = useAppStore((s) => s.bot?.liqCascadeRadarStatus as LiqCascadeRadarStatus | undefined);
  const fromMarket = useAppStore(
    (s) => (s.market as { liqCascadeRadarStatus?: LiqCascadeRadarStatus } | undefined)?.liqCascadeRadarStatus,
  );
  if (manualStrategy !== "LIQ_CASCADE") return null;
  return (
    <div className="lg:col-span-2">
      <LiqCascadeRadarPanel status={fromMarket ?? fromBot} />
    </div>
  );
}

function notificationsEnabledFromEnv(): boolean {
  const raw = String(import.meta.env.VITE_ACTIVITY_NOTIFICATIONS ?? "1").trim().toLowerCase();
  if (!raw) return true;
  return raw !== "0" && raw !== "false" && raw !== "off";
}

export function App() {
  const auth = useAuthActions();
  const connect = useAppStore((s) => s.connect);
  const connected = useAppStore((s) => s.ws.connected);
  const wsLastError = useAppStore((s) => s.ws.lastError);
  const mainView = useAppStore((s) => s.mainView);
  const notificationsOn = notificationsEnabledFromEnv();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useEffect(() => {
    connect();
  }, [connect]);

  /** When WS is down (proxy/buffering), keep UI fresh via polled `/api/state`. */
  useEffect(() => {
    if (connected) return;
    const first = window.setTimeout(() => void hydrateStateViaHttp(), 1500);
    const t = window.setInterval(() => void hydrateStateViaHttp(), 4000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [connected]);

  const shellTop = (
    <>
      <HeaderSignalsStrip />
      <HeaderBar onOpenSidebar={() => setSidebarOpen(true)} />
      <RegimeEngineStrip />
      <InstanceNavBar />
      {notificationsOn ? <ActivityToasts /> : null}
      <AppSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <AccountWidget />
      <ModeSwitchOverlay />
    </>
  );

  if (mainView === "backtest") {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
        {shellTop}
        <Suspense fallback={<div className="p-8 text-center text-sm text-slate-500">Loading backtest…</div>}>
          <BacktestPage />
        </Suspense>
        <TradingModeBadge />
      </div>
    );
  }

  if (mainView !== "instance") {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
        {shellTop}
        <OverviewPage />
        <TradingModeBadge />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {shellTop}

      <div className="mx-auto max-w-[1920px] px-4 pb-6 pt-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <div
              className={clsx(
                "grid min-w-0 gap-4",
                "grid-cols-1",
                "lg:grid-cols-[1.6fr_1fr]",
                "auto-rows-min",
              )}
            >
              <div className="lg:col-span-2 rounded-xl border border-slate-200 bg-slate-100/95 shadow-glow-light dark:border-slate-800 dark:bg-slate-950/60 dark:shadow-glow">
                <PortfolioPanel />
              </div>

              <MlctsLayersSection />

              <LiqCascadeRadarSection />

              <div className="space-y-3">
                <div className="rounded-xl border border-slate-200 bg-slate-100/95 shadow-glow-light dark:border-slate-800 dark:bg-slate-950/60 dark:shadow-glow">
                  <ChartErrorBoundary>
                    <ChartPanel />
                  </ChartErrorBoundary>
                </div>
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
          </div>
          <StrategySidebar />
        </div>

        <div className="mt-3 text-xs text-slate-600 dark:text-slate-500">
          Status:{" "}
          <span className={connected ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
            {connected ? "WS connected" : "WS disconnected"}
          </span>
          {!connected && wsLastError ? (
            <span className="ml-2 font-mono text-[0.65rem] text-slate-500 dark:text-slate-400" title="WebSocket debug hint">
              ({wsLastError})
            </span>
          ) : null}
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


