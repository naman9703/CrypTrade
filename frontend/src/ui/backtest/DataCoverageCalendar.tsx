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
const HISTORY_YEARS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
type HistoryYears = (typeof HISTORY_YEARS)[number];

function dateYearsAgo(years: number): Date {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d;
}

function formatWindowDate(d: Date): string {
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatCoverageLine(cov: BacktestCoverage | null, unit = "bars"): string {
  if (!cov) return "—";
  const have = cov.have.toLocaleString();
  const expected =
    cov.expected != null && Number.isFinite(cov.expected) ? cov.expected.toLocaleString() : "—";
  const pct = cov.coveragePct != null ? `${cov.coveragePct.toFixed(1)}%` : "—";
  return `${have} / ${expected} ${unit} (${pct})`;
}

function formatMb(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb > 0 && mb < 0.1) return "<0.1";
  return mb >= 10 ? mb.toFixed(0) : mb.toFixed(1);
}

function formatFootprintLine(cov: BacktestCoverage | null): string | null {
  if (cov?.diskBytes == null || cov.memBytesEst == null) return null;
  let line = `~${formatMb(cov.diskBytes)} MB disk · ~${formatMb(cov.memBytesEst)} MB load est.`;
  if (
    cov.diskBytesFull != null &&
    cov.expected != null &&
    cov.have < cov.expected &&
    cov.coveragePct != null &&
    cov.coveragePct < 99.9
  ) {
    line += ` (~${formatMb(cov.diskBytesFull)} MB disk at 100%)`;
  }
  return line;
}

function sumFootprint(a: BacktestCoverage | null, b: BacktestCoverage | null) {
  const diskBytes = (a?.diskBytes ?? 0) + (b?.diskBytes ?? 0);
  const memBytesEst = (a?.memBytesEst ?? 0) + (b?.memBytesEst ?? 0);
  const diskBytesFull =
    a?.diskBytesFull != null || b?.diskBytesFull != null
      ? (a?.diskBytesFull ?? a?.diskBytes ?? 0) + (b?.diskBytesFull ?? b?.diskBytes ?? 0)
      : null;
  const memBytesFull =
    a?.memBytesFull != null || b?.memBytesFull != null
      ? (a?.memBytesFull ?? a?.memBytesEst ?? 0) + (b?.memBytesFull ?? b?.memBytesEst ?? 0)
      : null;
  if (diskBytes <= 0 && memBytesEst <= 0) return null;
  return { diskBytes, memBytesEst, diskBytesFull, memBytesFull } as Pick<
    BacktestCoverage,
    "diskBytes" | "memBytesEst" | "diskBytesFull" | "memBytesFull"
  >;
}

type Props = {
  symbol: string;
  timeframe: string;
  onSymbolChange: (s: string) => void;
  onTfChange: (s: string) => void;
};

export function DataCoverageCalendar({ symbol, timeframe, onSymbolChange, onTfChange }: Props) {
  const [coverage, setCoverage] = useState<BacktestCoverage | null>(null);
  const [monthly, setMonthly] = useState<BacktestMonthlyCoverage[]>([]);
  const [markCoverage, setMarkCoverage] = useState<BacktestCoverage | null>(null);
  const [markMonthly, setMarkMonthly] = useState<BacktestMonthlyCoverage[]>([]);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [markSyncing, setMarkSyncing] = useState<boolean>(false);
  const [historyYears, setHistoryYears] = useState<HistoryYears>(1);
  const [err, setErr] = useState<string | null>(null);
  const [markErr, setMarkErr] = useState<string | null>(null);
  /** Must match strategy market mode: futures vs spot use different Binance kline endpoints. */
  const [market, setMarket] = useState<"futures" | "spot">("futures");

  const windowFrom = dateYearsAgo(historyYears);
  const windowTo = new Date();
  const windowLabel = `${formatWindowDate(windowFrom)} → ${formatWindowDate(windowTo)}`;

  const refresh = useCallback(async () => {
    if (!symbol || !timeframe) return;
    try {
      const from = dateYearsAgo(historyYears);
      const to = new Date();
      const r = await api.getDataCoverage({
        symbol,
        timeframe,
        from: from.toISOString(),
        to: to.toISOString(),
      });
      setCoverage((r?.coverage ?? null) as BacktestCoverage | null);
      setMonthly((r?.monthly ?? []) as BacktestMonthlyCoverage[]);
      setMarkCoverage((r?.markCoverage ?? null) as BacktestCoverage | null);
      setMarkMonthly((r?.markMonthly ?? []) as BacktestMonthlyCoverage[]);
    } catch {
      /* ignore */
    }
  }, [symbol, timeframe, historyYears]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function sync() {
    setErr(null);
    setSyncing(true);
    try {
      const from = dateYearsAgo(historyYears);
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

  async function syncMark() {
    if (market !== "futures") return;
    setMarkErr(null);
    setMarkSyncing(true);
    try {
      const from = dateYearsAgo(historyYears);
      await api.syncMarkHistoricalData({
        symbol,
        from: from.toISOString(),
        to: new Date().toISOString(),
      });
      await refresh();
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e ?? "error");
      setMarkErr(m);
    } finally {
      setMarkSyncing(false);
    }
  }

  const windowFootprint = sumFootprint(coverage, market === "futures" ? markCoverage : null);
  const ohlcFootprintLine = formatFootprintLine(coverage);
  const markFootprintLine = formatFootprintLine(markCoverage);

  function monthlyGrid(items: BacktestMonthlyCoverage[]) {
    return (
      <div className="mt-2 grid grid-cols-6 gap-1">
        {items.map((m) => {
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
    );
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
        <div className="col-span-2">
          <span className="block pb-0.5 text-[10px] uppercase tracking-wide text-slate-500">History window</span>
          <div className="flex flex-wrap gap-1">
            {HISTORY_YEARS.map((y) => (
              <button
                key={y}
                type="button"
                onClick={() => setHistoryYears(y)}
                className={`rounded px-2 py-1 text-[11px] font-semibold ${
                  historyYears === y
                    ? "bg-sky-600 text-white"
                    : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                }`}
              >
                {y}y
              </button>
            ))}
          </div>
          <span className="mt-0.5 block text-[10px] text-slate-500">
            Coverage grid and sync use the last {historyYears} year{historyYears > 1 ? "s" : ""}.
          </span>
          <span className="mt-1 block font-mono text-[10px] text-slate-600 dark:text-slate-400">{windowLabel}</span>
        </div>
      </div>
      <div className="text-[11px] text-slate-500">
        <span className="font-medium text-slate-600 dark:text-slate-300">{timeframe}</span>
        {" · "}
        {formatCoverageLine(coverage)}
      </div>
      {ohlcFootprintLine && <div className="mt-0.5 text-[10px] text-slate-500">{ohlcFootprintLine}</div>}
      {monthlyGrid(monthly)}
      <button
        type="button"
        onClick={sync}
        disabled={syncing}
        className="mt-3 w-full rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-60"
      >
        {syncing ? "Syncing…" : `Sync ${historyYears}y backfill`}
      </button>
      {err && <div className="mt-2 rounded bg-rose-50 px-2 py-1 text-[11px] text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{err}</div>}

      {market === "futures" && (
        <div className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-800">
          <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">Mark price · 1m</div>
          <p className="mt-0.5 text-[10px] text-slate-500">
            Futures mark klines for live-parity trailing replay. Trade 1m fills any missing minutes at run time.
          </p>
          <div className="mt-1 text-[11px] text-slate-500">{formatCoverageLine(markCoverage, "mark bars")}</div>
          {markFootprintLine && <div className="mt-0.5 text-[10px] text-slate-500">{markFootprintLine}</div>}
          {monthlyGrid(markMonthly)}
          <button
            type="button"
            onClick={syncMark}
            disabled={markSyncing}
            className="mt-3 w-full rounded border border-violet-500 bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-60"
          >
            {markSyncing ? "Syncing mark…" : `Sync mark ${historyYears}y (1m)`}
          </button>
          {markErr && (
            <div className="mt-2 rounded bg-rose-50 px-2 py-1 text-[11px] text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
              {markErr}
            </div>
          )}
        </div>
      )}

      {windowFootprint && (
        <div className="mt-3 border-t border-slate-200 pt-2 text-[10px] text-slate-500 dark:border-slate-800">
          <span className="font-medium text-slate-600 dark:text-slate-300">Window total</span>
          {" · "}
          ~{formatMb(windowFootprint.diskBytes)} MB disk · ~{formatMb(windowFootprint.memBytesEst)} MB load est.
          {windowFootprint.diskBytesFull != null &&
            coverage?.expected != null &&
            (coverage.have < coverage.expected ||
              (markCoverage?.expected != null && markCoverage.have < markCoverage.expected)) && (
              <> (~{formatMb(windowFootprint.diskBytesFull)} MB disk at 100%)</>
            )}
        </div>
      )}
    </div>
  );
}
