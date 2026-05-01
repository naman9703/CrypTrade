import { useEffect, useMemo, useRef } from "react";
import { clsx } from "clsx";
import { computeMultiCoinTabSymbols } from "../lib/multiCoinTabSymbols";
import { displayMarketDecisionVerdict } from "../lib/marketDecision/display";
import { useAppStore } from "../ws/store";

const CHART_TIMEZONE = "Asia/Kolkata";

type WatchSnap = {
  ts: number;
  buySignal: boolean;
  sellSignal: boolean;
  trend: number | null;
  strength01: number | null;
  signalStrength: number | null;
  stAction: string | null;
  aiGateBuy: number | null;
  aiGateSell: number | null;
  bufferBars: number | null;
  updatedAt: number;
  source?: string;
  marketDecisionSnapshot?: {
    verdict?: string;
    failedStage?: string | null;
    reasons?: string[];
    regime?: { ltf?: { type?: string; confidence?: number } };
  } | null;
};

function formatIst(ms: number) {
  try {
    return new Date(ms).toLocaleString("en-IN", {
      timeZone: CHART_TIMEZONE,
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return "—";
  }
}

function ageSec(updatedAt: number) {
  const s = Math.floor((Date.now() - updatedAt) / 1000);
  if (!Number.isFinite(s) || s < 0) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** Tabs under the main chart: one row per allowed multi-coin symbol with live ST snapshot from the server. */
export function MultiCoinSignalTabs() {
  const bot = useAppStore((s) => s.bot);
  const chartDisplaySymbol = useAppStore((s) => s.chartDisplaySymbol);
  const setChartDisplaySymbol = useAppStore((s) => s.setChartDisplaySymbol);

  const liveTabs = useMemo(() => computeMultiCoinTabSymbols(bot as Record<string, unknown>), [bot]);
  const lastNonEmptyTabsRef = useRef<string[]>([]);
  const tabs = useMemo(() => {
    if (liveTabs.length > 0) {
      lastNonEmptyTabsRef.current = liveTabs;
      return liveTabs;
    }
    /** Keep tabs stable across transient bot snapshot gaps. */
    return lastNonEmptyTabsRef.current;
  }, [liveTabs]);

  const liveSnaps = (bot?.multiSymbolWatchSignals || {}) as Record<string, WatchSnap>;
  const lastSnapsRef = useRef<Record<string, WatchSnap>>({});
  const snaps = useMemo(() => {
    const next = { ...lastSnapsRef.current };
    for (const k of Object.keys(liveSnaps)) next[k] = liveSnaps[k];
    // Keep cache bounded to active tabs (+ primary) so stale symbols don't accumulate forever.
    const keep = new Set<string>([
      ...tabs,
      String((bot as Record<string, unknown> | null | undefined)?.symbol ?? "")
        .trim()
        .toUpperCase(),
    ]);
    for (const k of Object.keys(next)) {
      if (k && keep.size && !keep.has(k)) delete next[k];
    }
    lastSnapsRef.current = next;
    return next;
  }, [liveSnaps, tabs, bot]);
  const primary = String(bot?.symbol || "").toUpperCase();

  const chartU = String(chartDisplaySymbol ?? "")
    .trim()
    .toUpperCase();

  /** Snapshot panel matches the tab row when the main chart is on a listed symbol; otherwise first tab. */
  const detailSym = chartU && tabs.includes(chartU) ? chartU : tabs[0] ?? null;

  useEffect(() => {
    if (!tabs.length) return;
    if (chartDisplaySymbol != null) return;
    const serverFocus = String((bot as Record<string, unknown>)?.uiChartFocusSymbol ?? "")
      .trim()
      .toUpperCase();
    const pick = serverFocus && tabs.includes(serverFocus) ? serverFocus : tabs[0];
    setChartDisplaySymbol(pick);
  }, [tabs, chartDisplaySymbol, setChartDisplaySymbol, bot]);

  if (tabs.length === 0) return null;

  const snap = detailSym ? snaps[detailSym] : undefined;

  return (
    <div className="w-full rounded-md border border-slate-200/90 dark:border-slate-800/80 bg-slate-50 dark:bg-slate-950/50 px-2 py-2">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-500">
        Multi-coin signals (realtime)
      </div>
      <p className="mb-2 text-[10px] leading-snug text-slate-600 dark:text-slate-500">
        Bar-close Supertrend + AI gates for each allowed symbol in your multi setup (same engine as autotrade). Updates on kline close (
        <span className="font-mono">kline_ws</span>) and on the periodic sweep (<span className="font-mono">sweep</span>).
      </p>
      <div className="flex flex-wrap gap-1 border-b border-slate-200/80 pb-2 dark:border-slate-800/80">
        {tabs.map((sym) => {
          const s = snaps[sym];
          const isPrimary = sym === primary;
          const hasData = s != null && Number.isFinite(Number(s.updatedAt));
          return (
            <button
              key={sym}
              type="button"
              onClick={() => setChartDisplaySymbol(sym)}
              className={clsx(
                "rounded-t px-2 py-1 text-[11px] font-medium transition-colors",
                chartU === sym
                  ? "bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-slate-100"
                  : "bg-transparent text-slate-600 hover:bg-slate-200/80 dark:text-slate-400 dark:hover:bg-slate-800/80",
                isPrimary && "ring-1 ring-sky-500/40",
              )}
              title={isPrimary ? "Primary trading symbol" : undefined}
            >
              <span className="font-mono">{sym}</span>
              {hasData ? (
                <span
                  className={clsx(
                    "ml-1 text-[10px]",
                    s.buySignal ? "text-emerald-600 dark:text-emerald-400" : "",
                    s.sellSignal ? "text-rose-600 dark:text-rose-400" : "",
                    !s.buySignal && !s.sellSignal ? "text-slate-500" : "",
                  )}
                >
                  {s.buySignal ? "B" : s.sellSignal ? "S" : "·"}
                </span>
              ) : (
                <span className="ml-1 text-[10px] text-slate-500">…</span>
              )}
            </button>
          );
        })}
      </div>
      {detailSym ? (
        <div className="mt-2 space-y-1 text-[11px] leading-relaxed text-slate-700 dark:text-slate-300">
          {chartU && !tabs.includes(chartU) ? (
            <p className="mb-1 text-[10px] text-slate-500 dark:text-slate-500">
              Main chart <span className="font-mono text-slate-700 dark:text-slate-300">{chartU}</span> — signals below follow{" "}
              <span className="font-mono">{detailSym}</span> (open position / not in tab list).
            </p>
          ) : null}
          {!snap || !Number.isFinite(Number(snap.updatedAt)) ? (
            <div className="text-slate-500 dark:text-slate-500">
              No snapshot yet — waiting for a closed bar on the feed (ensure MARKET_FEED is BINANCE / BINANCE_FUTURES and the bot is running
              with multi Supertrend enabled).
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                <span>
                  Last bar: <span className="font-mono text-slate-900 dark:text-slate-100">{formatIst(Number(snap.ts))}</span>
                </span>
                <span className="text-slate-500">·</span>
                <span>
                  Age: <span className="font-mono">{ageSec(snap.updatedAt)}</span>
                </span>
                <span className="text-slate-500">·</span>
                <span>
                  Source: <span className="font-mono text-slate-600 dark:text-slate-400">{snap.source || "—"}</span>
                </span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                <span>
                  Signal:{" "}
                  <span
                    className={clsx(
                      "font-semibold",
                      snap.buySignal ? "text-emerald-600 dark:text-emerald-400" : "",
                      snap.sellSignal ? "text-rose-600 dark:text-rose-400" : "",
                      !snap.buySignal && !snap.sellSignal ? "text-slate-500" : "",
                    )}
                  >
                    {snap.buySignal ? "BUY" : snap.sellSignal ? "SELL" : "— (no flip)"}
                  </span>
                </span>
                <span className="text-slate-500">·</span>
                <span>
                  Trend:{" "}
                  <span className="font-mono">
                    {snap.trend != null && Number.isFinite(snap.trend) ? (snap.trend >= 0 ? `+${snap.trend}` : String(snap.trend)) : "—"}
                  </span>
                </span>
                <span className="text-slate-500">·</span>
                <span>
                  Buffer: <span className="font-mono">{snap.bufferBars != null ? String(snap.bufferBars) : "—"}</span> bars
                </span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-slate-600 dark:text-slate-400">
                <span>
                  AI long: <span className="font-mono">{snap.aiGateBuy != null ? Number(snap.aiGateBuy).toFixed(2) : "—"}</span>
                  <span className="text-slate-500"> · </span>
                  AI short: <span className="font-mono">{snap.aiGateSell != null ? Number(snap.aiGateSell).toFixed(2) : "—"}</span>
                </span>
                <span>·</span>
                <span>
                  ST strength: <span className="font-mono">{snap.strength01 != null ? Number(snap.strength01).toFixed(3) : "—"}</span>
                </span>
                <span>·</span>
                <span>
                  SS: <span className="font-mono">{snap.signalStrength != null ? Math.round(Number(snap.signalStrength)) : "—"}</span>
                </span>
                <span>·</span>
                <span>
                  Action: <span className="font-mono">{snap.stAction ?? "—"}</span>
                </span>
              </div>
              {snap.marketDecisionSnapshot ? (
                <div className="mt-1 rounded border border-violet-200/80 bg-violet-50/80 px-2 py-1.5 text-[10px] leading-snug text-violet-950 dark:border-violet-800/60 dark:bg-violet-950/40 dark:text-violet-100">
                  <span className="font-semibold uppercase tracking-wide text-violet-800 dark:text-violet-200">
                    Market decision
                  </span>
                  <span className="mx-1 text-violet-400">·</span>
                  <span className="font-mono font-semibold">
                    {displayMarketDecisionVerdict(snap.marketDecisionSnapshot as Record<string, unknown>) ?? "—"}
                  </span>
                  {snap.marketDecisionSnapshot.regime?.ltf?.type ? (
                    <>
                      <span className="mx-1 text-violet-400">·</span>
                      <span className="text-violet-800/90 dark:text-violet-200/90">
                        regime {String(snap.marketDecisionSnapshot.regime.ltf.type)}
                        {snap.marketDecisionSnapshot.regime.ltf.confidence != null
                          ? ` (${Math.round(Number(snap.marketDecisionSnapshot.regime.ltf.confidence))})`
                          : ""}
                      </span>
                    </>
                  ) : null}
                  {snap.marketDecisionSnapshot.reasons?.length ? (
                    <div className="mt-0.5 text-violet-900/85 dark:text-violet-200/85">
                      {snap.marketDecisionSnapshot.reasons.slice(0, 2).join(" · ")}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
