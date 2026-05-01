import { useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import { useAppStore as useStore } from "../../ws/store";
import { CompositeScoreGauge } from "./CompositeScoreGauge";
import { SignalBreakdown } from "./SignalBreakdown";
import { FearGreedCard } from "./FearGreedCard";
import { FundingCard } from "./FundingCard";
import { OpenInterestCard } from "./OpenInterestCard";
import { OrderBookCard } from "./OrderBookCard";
import { OptionsCard } from "./OptionsCard";
import { ConfluenceCard } from "./ConfluenceCard";
import { VolatilityCard } from "./VolatilityCard";
import { OnChainCard } from "./OnChainCard";
import { LiquidationsCard } from "./LiquidationsCard";
import { NewsImpactCard } from "./NewsImpactCard";
import { MarketIntelligenceSettingsModal } from "./MarketIntelligenceSettingsModal";
import type { IntelligenceData } from "../../types/intelligence";

const COMMON_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];

function GateStatusBadge({ enabled, embedded }: { enabled: boolean; embedded?: boolean }) {
  return (
    <div
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${
        enabled
          ? embedded
            ? "bg-emerald-500/15 text-emerald-800 ring-1 ring-emerald-600/40 dark:bg-emerald-950/60 dark:text-emerald-300 dark:ring-emerald-700"
            : "bg-emerald-950/60 text-emerald-300 ring-1 ring-emerald-700"
          : embedded
            ? "bg-slate-200/80 text-slate-600 dark:bg-slate-800 dark:text-slate-500"
            : "bg-slate-800 text-slate-500"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${enabled ? "bg-emerald-500 animate-pulse dark:bg-emerald-400" : "bg-slate-400 dark:bg-slate-600"}`} />
      Gate {enabled ? "on" : "off"}
    </div>
  );
}

export function IntelligencePanel({ embedded = false }: { embedded?: boolean }) {
  const bot = useStore((s) => s.bot);
  const chartDisplaySymbol = useStore((s) => s.chartDisplaySymbol);
  const intelligence = useStore((s) => s.intelligence);
  const fetchIntel = useStore((s) => s.fetchIntelligence);

  const botSymbol = String((bot as Record<string, unknown>)?.symbol ?? "BTCUSDT").toUpperCase().trim() || "BTCUSDT";
  const chartSym = useMemo(() => {
    const c = chartDisplaySymbol ? String(chartDisplaySymbol).trim().toUpperCase() : "";
    return c || botSymbol;
  }, [chartDisplaySymbol, botSymbol]);

  const symbols = useMemo(() => Array.from(new Set([chartSym, botSymbol, ...COMMON_SYMBOLS])), [chartSym, botSymbol]);

  const [selected, setSelected] = useState<string>(embedded ? chartSym : botSymbol);
  const [intelSettingsOpen, setIntelSettingsOpen] = useState(false);

  useEffect(() => {
    if (embedded) setSelected(chartSym);
  }, [embedded, chartSym]);

  useEffect(() => {
    void fetchIntel(selected);
  }, [selected, fetchIntel]);

  useEffect(() => {
    const interval = setInterval(() => {
      void fetchIntel(selected);
    }, 30_000);
    return () => clearInterval(interval);
  }, [selected, fetchIntel]);

  const data: IntelligenceData | null = intelligence[selected] ?? null;
  const gateEnabled = Boolean((bot as Record<string, unknown>)?.intelligenceGateEnabled);

  const shellCls = embedded
    ? "mt-3 flex w-full min-w-0 flex-col rounded-xl border border-slate-200 bg-slate-100/90 shadow-sm dark:border-slate-800 dark:bg-slate-950/40"
    : "flex h-full min-h-0 w-full min-w-0 flex-col bg-slate-950";

  const headerCls = embedded
    ? "flex items-center justify-between border-b border-slate-200 bg-white/80 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/60"
    : "flex items-center justify-between border-b border-slate-800 px-5 py-3";

  const tabsCls = embedded
    ? "flex gap-1 border-b border-slate-200 px-2 py-1.5 dark:border-slate-800"
    : "flex gap-1 border-b border-slate-800 px-4 py-2";

  const bodyCls = embedded
    ? "flex w-full min-w-0 flex-col gap-3 px-3 py-3"
    : "flex w-full min-w-0 flex-1 flex-col gap-4 px-4 py-4";

  const titleCls = embedded ? "text-xs font-bold text-slate-800 dark:text-white" : "text-base font-bold text-white";
  const subCls = embedded ? "text-[10px] text-slate-500 dark:text-slate-500" : "text-xs text-slate-500";

  const tabActive = embedded
    ? "bg-slate-700 text-white dark:bg-slate-700"
    : "bg-slate-700 text-white";
  const tabIdle = embedded
    ? "text-slate-600 hover:text-slate-900 dark:text-slate-500 dark:hover:text-slate-300"
    : "text-slate-500 hover:text-slate-300";

  return (
    <div className={shellCls}>
      <div className={embedded ? "flex min-w-0 flex-col" : "flex min-h-0 min-w-0 flex-1 flex-col"}>
        <div className={headerCls}>
          <div>
            <h2 className={titleCls}>Market Intelligence</h2>
            <p className={subCls}>Multi-layer signals · sizing hint</p>
          </div>
          <div className="flex flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-2">
            <GateStatusBadge enabled={gateEnabled} embedded={embedded} />
            {data ? (
              <span className={embedded ? "text-[10px] text-slate-500" : "text-[10px] text-slate-600"}>
                {new Date(data.timestamp).toLocaleTimeString()}
              </span>
            ) : null}
            <button
              type="button"
              title="Market Intelligence API settings"
              aria-label="Market Intelligence API settings"
              onClick={() => setIntelSettingsOpen(true)}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors ${
                embedded
                  ? "border-slate-300 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                  : "border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800"
              }`}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
              </svg>
            </button>
          </div>
        </div>

        <div className={tabsCls}>
          {symbols.map((sym) => (
            <button
              key={sym}
              type="button"
              onClick={() => setSelected(sym)}
              className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition-colors ${
                selected === sym ? tabActive : tabIdle
              }`}
            >
              {sym.replace("USDT", "")}
            </button>
          ))}
        </div>

        <div className={bodyCls}>
          <div
            className={`mb-3 grid gap-3 ${embedded ? "grid-cols-1 xl:grid-cols-[auto_1fr]" : "grid-cols-[auto_1fr]"}`}
          >
            <div className="flex flex-col items-center justify-center">
              {data?.composite ? (
                <CompositeScoreGauge composite={data.composite} />
              ) : (
                <div className="flex h-36 w-52 flex-col items-center justify-center">
                  <div className="mb-2 h-20 w-20 animate-pulse rounded-full bg-slate-300 dark:bg-slate-800" />
                  <div className="h-3 w-28 animate-pulse rounded bg-slate-300 dark:bg-slate-800" />
                </div>
              )}
            </div>
            <div className="flex min-w-0 flex-col justify-center">
              <p
                className={`mb-2 font-semibold uppercase tracking-wide ${embedded ? "text-[10px] text-slate-500" : "text-xs text-slate-400"}`}
              >
                Signal breakdown
              </p>
              {data?.composite ? (
                <SignalBreakdown bullish={data.composite.bullishSignals} bearish={data.composite.bearishSignals} />
              ) : (
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-4 w-full animate-pulse rounded bg-slate-300 dark:bg-slate-800" />
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className={`mb-3 grid grid-cols-2 gap-2 lg:grid-cols-4`}>
            <FearGreedCard data={data?.fearGreed ?? null} />
            <FundingCard data={data?.funding ?? null} symbol={selected} />
            <OpenInterestCard data={data?.openInterest ?? null} />
            <OrderBookCard data={data?.orderBook ?? null} />
            <OptionsCard data={data?.options ?? null} symbol={selected} />
            <OnChainCard data={data?.onChain ?? null} />
            <div
              className={clsx(
                data?.liquidations?.intensity === "high" || data?.liquidations?.intensity === "extreme"
                  ? "col-span-2 lg:col-span-4"
                  : "",
              )}
            >
              <LiquidationsCard data={data?.liquidations ?? null} />
            </div>
            <NewsImpactCard data={data?.newsImpact ?? null} />
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <ConfluenceCard data={data?.confluence ?? null} />
            <VolatilityCard data={data?.volatility ?? null} />
          </div>
        </div>
      </div>
      <MarketIntelligenceSettingsModal open={intelSettingsOpen} onClose={() => setIntelSettingsOpen(false)} />
    </div>
  );
}
