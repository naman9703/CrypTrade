/**
 * Right-pane card. Shows total bar coverage for `(symbol, tf)` plus a per-month
 * grid (green/amber/red) and sync buttons that patch-fill remaining gaps by
 * exact DB timestamps (not a full multi-year re-download by default).
 *
 * Sync pulls Binance **REST klines** (official OHLC) into `ohlcv_candles`: USD-M
 * futures (`/fapi/v1/klines`) vs spot (`/api/v3/klines`) — pick the venue that
 * matches your strategy's market mode or bars won't match live execution.
 *
 * Long windows run as async jobs (POST returns jobId); the button polls progress
 * and reconnects after refresh via active job lookup.
 */
import { useCallback, useEffect, useRef, useState } from "react";
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

function formatRemaining(days: number | null | undefined): string | null {
  if (days == null || !Number.isFinite(days) || days <= 0) return null;
  if (days < 1) {
    const hours = Math.max(1, Math.round(days * 24));
    return `~${hours}h remaining`;
  }
  if (days < 10) return `~${days.toFixed(1)}d remaining`;
  return `~${Math.round(days)}d remaining`;
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

const PHASE_LABEL: Record<string, string> = {
  klines: "OHLC",
  klines_1m: "1m OHLC",
  mark: "mark",
  funding: "funding",
  fear_greed: "F&G",
  open_interest: "OI",
  done: "done",
  failed: "failed",
};

function jobStorageKey(kind: "ohlc" | "mark", symbol: string, timeframe: string, market: string) {
  return `dataSyncJob:${kind}:${symbol}:${timeframe}:${market}`;
}

async function waitForDataSyncJob(
  jobId: string,
  onProgress: (pct: number, phase: string | null) => void,
  signal?: { cancelled: boolean },
): Promise<void> {
  const started = Date.now();
  const maxMs = 2 * 60 * 60 * 1000;
  while (Date.now() - started < maxMs) {
    if (signal?.cancelled) return;
    const st = await api.getDataSyncJob(jobId);
    const status = String(st?.status ?? "");
    const pct = Number(st?.progressPct ?? 0);
    onProgress(Number.isFinite(pct) ? pct : 0, st?.phase != null ? String(st.phase) : null);
    if (status === "done") return;
    if (status === "failed") {
      throw new Error(st?.error ? String(st.error) : "sync_failed");
    }
    if (status === "" || (st as { error?: string })?.error === "job_not_found") {
      // 404 body may still parse; treat missing job as lost.
      throw new Error("sync_job_lost");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("sync_timeout");
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
  const [syncPct, setSyncPct] = useState<number>(0);
  const [syncPhase, setSyncPhase] = useState<string | null>(null);
  const [syncMode, setSyncMode] = useState<"patch" | "full" | null>(null);
  const [markSyncing, setMarkSyncing] = useState<boolean>(false);
  const [markSyncPct, setMarkSyncPct] = useState<number>(0);
  const [markSyncPhase, setMarkSyncPhase] = useState<string | null>(null);
  const [historyYears, setHistoryYears] = useState<HistoryYears>(1);
  const [err, setErr] = useState<string | null>(null);
  const [markErr, setMarkErr] = useState<string | null>(null);
  /** Must match strategy market mode: futures vs spot use different Binance kline endpoints. */
  const [market, setMarket] = useState<"futures" | "spot">("futures");
  const pollCancelRef = useRef<{ cancelled: boolean }>({ cancelled: false });
  const watchingJobRef = useRef<string | null>(null);

  const windowFrom = dateYearsAgo(historyYears);
  const windowTo = new Date();
  const windowLabel = `${formatWindowDate(windowFrom)} → ${formatWindowDate(windowTo)}`;

  const remainingLabel = formatRemaining(coverage?.remainingDays);
  const markRemainingLabel = formatRemaining(markCoverage?.remainingDays);

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
        market,
      });
      setCoverage((r?.coverage ?? null) as BacktestCoverage | null);
      setMonthly((r?.monthly ?? []) as BacktestMonthlyCoverage[]);
      setMarkCoverage((r?.markCoverage ?? null) as BacktestCoverage | null);
      setMarkMonthly((r?.markMonthly ?? []) as BacktestMonthlyCoverage[]);
      return r;
    } catch {
      return null;
    }
  }, [symbol, timeframe, historyYears, market]);

  const attachJob = useCallback(
    async (kind: "ohlc" | "mark", jobId: string, mode: "patch" | "full" | null) => {
      if (watchingJobRef.current === jobId) return;
      watchingJobRef.current = jobId;
      pollCancelRef.current = { cancelled: false };
      const signal = pollCancelRef.current;
      try {
        localStorage.setItem(jobStorageKey(kind, symbol, timeframe, market), jobId);
      } catch {
        /* ignore */
      }
      if (kind === "ohlc") {
        setSyncing(true);
        setSyncMode(mode);
        setErr(null);
      } else {
        setMarkSyncing(true);
        setMarkErr(null);
      }
      try {
        await waitForDataSyncJob(
          jobId,
          (pct, phase) => {
            if (kind === "ohlc") {
              setSyncPct(pct);
              setSyncPhase(phase);
            } else {
              setMarkSyncPct(pct);
              setMarkSyncPhase(phase);
            }
          },
          signal,
        );
        if (signal.cancelled) return;
        if (kind === "ohlc") {
          setSyncPct(100);
          setSyncPhase("done");
        } else {
          setMarkSyncPct(100);
          setMarkSyncPhase("done");
        }
        await refresh();
      } catch (e: unknown) {
        if (signal.cancelled) return;
        const m = e instanceof Error ? e.message : String(e ?? "error");
        if (kind === "ohlc") setErr(m);
        else setMarkErr(m);
      } finally {
        if (watchingJobRef.current === jobId) watchingJobRef.current = null;
        if (!signal.cancelled) {
          try {
            localStorage.removeItem(jobStorageKey(kind, symbol, timeframe, market));
          } catch {
            /* ignore */
          }
          if (kind === "ohlc") {
            setSyncing(false);
            setSyncPct(0);
            setSyncPhase(null);
            setSyncMode(null);
          } else {
            setMarkSyncing(false);
            setMarkSyncPct(0);
            setMarkSyncPhase(null);
          }
        }
      }
    },
    [symbol, timeframe, market, refresh],
  );

  useEffect(() => {
    void (async () => {
      const r = await refresh();
      const active = r?.activeSync;
      const activeMark = r?.activeMarkSync;
      let ohlcJob = active?.jobId ? String(active.jobId) : "";
      let markJob = activeMark?.jobId ? String(activeMark.jobId) : "";
      if (!ohlcJob) {
        try {
          ohlcJob = localStorage.getItem(jobStorageKey("ohlc", symbol, timeframe, market)) || "";
        } catch {
          ohlcJob = "";
        }
      }
      if (!markJob) {
        try {
          markJob = localStorage.getItem(jobStorageKey("mark", symbol, timeframe, market)) || "";
        } catch {
          markJob = "";
        }
      }
      if (ohlcJob) {
        const mode = active?.mode === "full" ? "full" : "patch";
        if (active?.progressPct != null) setSyncPct(Number(active.progressPct) || 0);
        if (active?.phase) setSyncPhase(String(active.phase));
        void attachJob("ohlc", ohlcJob, mode);
      }
      if (markJob && market === "futures") {
        if (activeMark?.progressPct != null) setMarkSyncPct(Number(activeMark.progressPct) || 0);
        if (activeMark?.phase) setMarkSyncPhase(String(activeMark.phase));
        void attachJob("mark", markJob, "patch");
      }
    })();
    return () => {
      pollCancelRef.current.cancelled = true;
    };
    // Reconnect only when identity of the coverage card changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, timeframe, historyYears, market]);

  // While syncing, refresh coverage periodically so the grid updates live.
  // Progress % still comes from the job — coverage alone must not imply "done".
  useEffect(() => {
    if (!syncing && !markSyncing) return;
    const id = setInterval(() => {
      void refresh();
    }, 4000);
    return () => clearInterval(id);
  }, [syncing, markSyncing, refresh]);

  async function sync(mode: "patch" | "full" = "patch") {
    setErr(null);
    setSyncing(true);
    setSyncPct(0);
    setSyncPhase("klines");
    setSyncMode(mode);
    try {
      const from = dateYearsAgo(historyYears);
      const started = await api.syncHistoricalData({
        symbol,
        timeframe,
        from: from.toISOString(),
        to: new Date().toISOString(),
        market,
        mode,
      });
      if (started?.skipped) {
        setSyncPct(100);
        setSyncPhase("done");
        await refresh();
        setSyncing(false);
        setSyncPct(0);
        setSyncPhase(null);
        setSyncMode(null);
        return;
      }
      const jobId = started?.jobId != null ? String(started.jobId) : "";
      if (jobId && started?.async !== false) {
        if (started.progressPct != null) setSyncPct(Number(started.progressPct) || 0);
        await attachJob("ohlc", jobId, mode);
        return;
      }
      setSyncPct(100);
      setSyncPhase("done");
      await refresh();
      setSyncing(false);
      setSyncPct(0);
      setSyncPhase(null);
      setSyncMode(null);
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e ?? "error");
      setErr(m);
      setSyncing(false);
      setSyncPct(0);
      setSyncPhase(null);
      setSyncMode(null);
    }
  }

  async function syncMark(mode: "patch" | "full" = "patch") {
    if (market !== "futures") return;
    setMarkErr(null);
    setMarkSyncing(true);
    setMarkSyncPct(0);
    setMarkSyncPhase("mark");
    try {
      const from = dateYearsAgo(historyYears);
      const started = await api.syncMarkHistoricalData({
        symbol,
        from: from.toISOString(),
        to: new Date().toISOString(),
        mode,
      });
      const jobId = started?.jobId != null ? String(started.jobId) : "";
      if (jobId && started?.async !== false) {
        if (started.progressPct != null) setMarkSyncPct(Number(started.progressPct) || 0);
        await attachJob("mark", jobId, mode);
        return;
      }
      setMarkSyncPct(100);
      setMarkSyncPhase("done");
      await refresh();
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e ?? "error");
      setMarkErr(m);
      setMarkSyncing(false);
      setMarkSyncPct(0);
      setMarkSyncPhase(null);
    }
  }

  const windowFootprint = sumFootprint(coverage, market === "futures" ? markCoverage : null);
  const ohlcFootprintLine = formatFootprintLine(coverage);
  const markFootprintLine = formatFootprintLine(markCoverage);

  function syncButtonLabel(
    busy: boolean,
    pct: number,
    phase: string | null,
    idle: string,
    busyWord: string,
    mode: "patch" | "full" | null,
  ) {
    if (!busy) return idle;
    const phaseLabel = phase ? PHASE_LABEL[phase] ?? phase : null;
    const pctLabel = Number.isFinite(pct) ? `${Math.round(pct)}%` : "…";
    const modeTag = mode === "full" ? "full" : mode === "patch" ? "patch" : null;
    const bits = [busyWord, pctLabel];
    if (modeTag) bits.push(modeTag);
    if (phaseLabel) bits.push(phaseLabel);
    return bits.join(" · ");
  }

  function idleOhlcLabel() {
    if (remainingLabel) return `Fill remaining (${remainingLabel.replace(/^~/, "")})`;
    if (coverage?.coveragePct != null && coverage.coveragePct >= 99.5) return "Up to date — tip sync";
    return `Fill remaining · ${historyYears}y window`;
  }

  function idleMarkLabel() {
    if (markRemainingLabel) return `Fill mark remaining (${markRemainingLabel.replace(/^~/, "")})`;
    if (markCoverage?.coveragePct != null && markCoverage.coveragePct >= 99.5) return "Mark up to date — tip sync";
    return `Fill mark remaining · ${historyYears}y`;
  }

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
            Coverage uses the last {historyYears} year{historyYears > 1 ? "s" : ""}. Sync patches only missing ranges
            from exact timestamps (not a full re-download).
          </span>
          <span className="mt-1 block font-mono text-[10px] text-slate-600 dark:text-slate-400">{windowLabel}</span>
        </div>
      </div>
      <div className="text-[11px] text-slate-500">
        <span className="font-medium text-slate-600 dark:text-slate-300">{timeframe}</span>
        {" · "}
        {formatCoverageLine(coverage)}
        {remainingLabel ? (
          <>
            {" · "}
            <span className="text-amber-700 dark:text-amber-300">{remainingLabel}</span>
          </>
        ) : null}
      </div>
      {coverage?.maxTs != null && (
        <div className="mt-0.5 font-mono text-[10px] text-slate-500">
          tip {new Date(coverage.maxTs).toISOString().slice(0, 19)}Z
          {coverage.patchFrom != null && coverage.patchFrom !== coverage.maxTs
            ? ` · patch from ${new Date(coverage.patchFrom).toISOString().slice(0, 19)}Z`
            : ""}
        </div>
      )}
      {ohlcFootprintLine && <div className="mt-0.5 text-[10px] text-slate-500">{ohlcFootprintLine}</div>}
      {monthlyGrid(monthly)}
      {syncing && (
        <div className="mt-2 rounded border border-sky-200 bg-sky-50 px-2 py-1 text-[10px] text-sky-900 dark:border-sky-900/50 dark:bg-sky-950/40 dark:text-sky-100">
          Job in progress ({syncMode || "patch"}). Coverage grid may look green before mark/aux finish — progress bar is
          the source of truth.
        </div>
      )}
      <button
        type="button"
        onClick={() => void sync("patch")}
        disabled={syncing}
        className="relative mt-3 w-full overflow-hidden rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-90"
      >
        {syncing && (
          <span
            className="absolute inset-y-0 left-0 bg-sky-400/50 transition-[width] duration-300"
            style={{ width: `${Math.max(2, Math.min(100, syncPct))}%` }}
            aria-hidden
          />
        )}
        <span className="relative">
          {syncButtonLabel(syncing, syncPct, syncPhase, idleOhlcLabel(), "Syncing", syncMode)}
        </span>
      </button>
      <button
        type="button"
        onClick={() => void sync("full")}
        disabled={syncing}
        className="mt-1.5 w-full rounded border border-slate-300 bg-white px-3 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        Re-sync full {historyYears}y (slow)
      </button>
      {err && <div className="mt-2 rounded bg-rose-50 px-2 py-1 text-[11px] text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{err}</div>}

      {market === "futures" && (
        <div className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-800">
          <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">Mark price · 1m</div>
          <p className="mt-0.5 text-[10px] text-slate-500">
            Futures mark klines for live-parity trailing replay. Patch fills from exact tip timestamp.
          </p>
          <div className="mt-1 text-[11px] text-slate-500">
            {formatCoverageLine(markCoverage, "mark bars")}
            {markRemainingLabel ? (
              <>
                {" · "}
                <span className="text-amber-700 dark:text-amber-300">{markRemainingLabel}</span>
              </>
            ) : null}
          </div>
          {markFootprintLine && <div className="mt-0.5 text-[10px] text-slate-500">{markFootprintLine}</div>}
          {monthlyGrid(markMonthly)}
          <button
            type="button"
            onClick={() => void syncMark("patch")}
            disabled={markSyncing}
            className="relative mt-3 w-full overflow-hidden rounded border border-violet-500 bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-90"
          >
            {markSyncing && (
              <span
                className="absolute inset-y-0 left-0 bg-violet-400/50 transition-[width] duration-300"
                style={{ width: `${Math.max(2, Math.min(100, markSyncPct))}%` }}
                aria-hidden
              />
            )}
            <span className="relative">
              {syncButtonLabel(markSyncing, markSyncPct, markSyncPhase, idleMarkLabel(), "Syncing mark", "patch")}
            </span>
          </button>
          <button
            type="button"
            onClick={() => void syncMark("full")}
            disabled={markSyncing}
            className="mt-1.5 w-full rounded border border-slate-300 bg-white px-3 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Re-sync mark full {historyYears}y (slow)
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
