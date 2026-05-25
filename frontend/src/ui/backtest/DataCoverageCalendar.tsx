/**
 * Right-pane card. Shows total bar coverage for `(symbol, tf)` plus a per-month
 * grid (green/amber/red) and a "Sync data" button that triggers backfill.
 *
 * Sync pulls Binance **REST klines** (official OHLC) into `ohlcv_candles`: USD-M
 * futures (`/fapi/v1/klines`) vs spot (`/api/v3/klines`) — pick the venue that
 * matches your strategy's market mode or bars won't match live execution.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import type { BacktestCoverage, BacktestMonthlyCoverage } from "../../types/backtest";

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"];

type Props = {
  symbol: string;
  timeframe: string;
  onSymbolChange: (s: string) => void;
  onTfChange: (s: string) => void;
};

export function DataCoverageCalendar({ symbol, timeframe, onSymbolChange, onTfChange }: Props) {
  const [coverage, setCoverage] = useState<BacktestCoverage | null>(null);
  const [monthly, setMonthly] = useState<BacktestMonthlyCoverage[]>([]);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  /** Must match strategy market mode: futures vs spot use different Binance kline endpoints. */
  const [market, setMarket] = useState<"futures" | "spot">("futures");

  const refresh = useCallback(async () => {
    if (!symbol || !timeframe) return;
    try {
      const from = new Date();
      from.setMonth(from.getMonth() - 12);
      const to = new Date();
      const r = await api.getDataCoverage({
        symbol,
        timeframe,
        from: from.toISOString(),
        to: to.toISOString(),
      });
      setCoverage((r?.coverage ?? null) as BacktestCoverage | null);
      setMonthly((r?.monthly ?? []) as BacktestMonthlyCoverage[]);
    } catch {
      /* ignore */
    }
  }, [symbol, timeframe]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function sync() {
    setErr(null);
    setSyncing(true);
    try {
      const from = new Date();
      from.setFullYear(from.getFullYear() - 1);
      await api.syncHistoricalData({
        symbol,
        timeframe,
        from: from.toISOString(),
        to: new Date().toISOString(),
        market,
      });
      await refresh();
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e ?? "error");
      setErr(m);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950/60">
      <div className="text-sm font-semibold pb-1">Data coverage</div>
      <div className="grid grid-cols-2 gap-2 pb-2 text-xs">
        <label className="block">
          <span className="block pb-0.5 text-[10px] uppercase tracking-wide text-slate-500">Symbol</span>
          <input
            value={symbol}
            onChange={(e) => onSymbolChange(e.target.value.toUpperCase())}
            className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
          />
        </label>
        <label className="block">
          <span className="block pb-0.5 text-[10px] uppercase tracking-wide text-slate-500">Timeframe</span>
          <select
            value={timeframe}
            onChange={(e) => onTfChange(e.target.value)}
            className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
          >
            {TIMEFRAMES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="block col-span-2">
          <span className="block pb-0.5 text-[10px] uppercase tracking-wide text-slate-500">Venue (Binance OHLC)</span>
          <select
            value={market}
            onChange={(e) => setMarket(e.target.value === "spot" ? "spot" : "futures")}
            className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
          >
            <option value="futures">USD-M Futures klines</option>
            <option value="spot">Spot klines</option>
          </select>
        </label>
      </div>
      <div className="text-[11px] text-slate-500">
        {coverage
          ? `${coverage.have.toLocaleString()} bars · ${coverage.coveragePct != null ? coverage.coveragePct.toFixed(1) + "%" : "—"}`
          : "—"}
      </div>
      <div className="mt-2 grid grid-cols-6 gap-1">
        {monthly.map((m) => {
          const tone =
            m.coveragePct >= 99
              ? "bg-emerald-200 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
              : m.coveragePct >= 60
                ? "bg-amber-200 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                : "bg-rose-200 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300";
          return (
            <div
              key={m.month}
              className={`rounded px-1 py-0.5 text-center text-[9px] font-mono ${tone}`}
              title={`${m.month}: ${m.have}/${m.expected} bars (${m.coveragePct.toFixed(1)}%)`}
            >
              {m.month.slice(2)}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={sync}
        disabled={syncing}
        className="mt-3 w-full rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-60"
      >
        {syncing ? "Syncing…" : "Sync 1y backfill"}
      </button>
      {err && <div className="mt-2 rounded bg-rose-50 px-2 py-1 text-[11px] text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{err}</div>}
    </div>
  );
}
