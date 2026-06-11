/**
 * Centre pane: tabbed results for the currently selected run.
 * Tabs: Equity, Drawdown, Monthly heatmap, Trades, Distributions.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { effectiveBacktestBotCfg } from "../../lib/backtestEffectiveCfg";
import { computeWalkForwardClient } from "../../lib/backtestWalkForward";
import type {
  BacktestEquityPoint,
  BacktestMetrics,
  BacktestRunSummary,
  BacktestTrade,
} from "../../types/backtest";
import { TradeListTable } from "./TradeListTable";
import { MonthlyHeatmapTable } from "./MonthlyHeatmapTable";
import { PnlHistogram } from "./PnlHistogram";
import { MaeMfeScatter } from "./MaeMfeScatter";
import { ChartErrorBoundary } from "../ChartErrorBoundary";
import { BacktestEquityChart } from "./BacktestEquityChart";
import { WithVsWithoutGatePanel } from "./WithVsWithoutGatePanel";
import { PromoteToInstanceModal } from "./PromoteToInstanceModal";
import { BacktestTradeChart } from "./BacktestTradeChart";
import { TrendHtfStChopSummary } from "./TrendHtfStChopSummary";
import { SessionWeekdayHeatmap } from "./SessionWeekdayHeatmap";

type Tab = "kpis" | "equity" | "drawdown" | "monthly" | "trades" | "distributions" | "gate";

type Props = {
  run: BacktestRunSummary | null;
  progress?: { progressPct: number; status?: string; error?: string };
  onAfterPromote: () => void | Promise<void>;
};

function normalizeClientMetrics(raw: unknown): BacktestMetrics | null {
  if (raw == null) return null;
  let m: unknown = raw;
  if (typeof m === "string") {
    try {
      m = JSON.parse(m);
    } catch {
      return null;
    }
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  if (o.monthlyReturns == null && o.monthly_returns != null) {
    return { ...o, monthlyReturns: o.monthly_returns } as BacktestMetrics;
  }
  return m as BacktestMetrics;
}

function metricsLooksComplete(m: BacktestMetrics | null): boolean {
  return m != null && typeof m === "object" && Object.keys(m).length > 0;
}

/** List endpoint omits config_snapshot; detail GET returns JSONB (sometimes a string). */
function normalizeConfigSnapshot(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw) as unknown;
      return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

export function BacktestResultPanel({ run, progress, onAfterPromote }: Props) {
  const [tab, setTab] = useState<Tab>("kpis");
  const [trades, setTrades] = useState<BacktestTrade[] | null>(null);
  const [selectedTrade, setSelectedTrade] = useState<BacktestTrade | null>(null);
  const [curve, setCurve] = useState<BacktestEquityPoint[] | null>(null);
  const [hydratedRun, setHydratedRun] = useState<BacktestRunSummary | null>(null);
  const [promoteOpen, setPromoteOpen] = useState<boolean>(false);
  const isTerminalRest =
    run?.status === "done" || run?.status === "failed" || run?.status === "cancelled";
  const status = run && isTerminalRest ? run.status : (progress?.status ?? run?.status);
  const livePct = Math.min(
    100,
    Math.max(0, Number(progress?.progressPct ?? run?.progressPct ?? 0) || 0),
  );

  const doneEnoughForDetails = useMemo(() => {
    if (!run?.id || run.status === "failed" || run.status === "cancelled") return false;
    const mx = normalizeClientMetrics(run.metrics);
    return run.status === "done" || progress?.status === "done" || metricsLooksComplete(mx);
  }, [run?.id, run?.status, run?.metrics, progress?.status]);

  const displayRun: BacktestRunSummary | null = useMemo(() => {
    if (!run) return null;
    const merged = hydratedRun ? { ...run, ...hydratedRun } : { ...run };
    const mx = normalizeClientMetrics(merged.metrics);
    const snap = normalizeConfigSnapshot(merged.configSnapshot);
    const inst = normalizeConfigSnapshot(merged.instanceOperationalSnapshot);
    const base = mx != null ? { ...merged, metrics: mx } : merged;
    return {
      ...base,
      configSnapshot: snap,
      instanceOperationalSnapshot: inst,
    };
  }, [run, hydratedRun]);

  const futuresLeverage = useMemo(() => {
    const snap = displayRun?.configSnapshot as Record<string, unknown> | null | undefined;
    const bot =
      snap?.bot && typeof snap.bot === "object" && !Array.isArray(snap.bot)
        ? (snap.bot as Record<string, unknown>)
        : snap;
    const lev = Number(bot?.futuresLeverage);
    return Number.isFinite(lev) && lev > 0 ? lev : 5;
  }, [displayRun?.configSnapshot]);

  useEffect(() => {
    setTrades(null);
    setCurve(null);
    setHydratedRun(null);
    setSelectedTrade(null);
  }, [run?.id]);

  /**
   * List GET omits config_snapshot (mapRunRow list:true). Always load run detail on select
   * so "Strategy config used" and raw JSON are available — not only when metrics are empty.
   */
  useEffect(() => {
    const rid = run?.id;
    if (!rid) {
      setHydratedRun(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const d = await api.getBacktestRun(rid);
        if (cancelled) return;
        const row = d?.run;
        if (row && typeof row === "object") setHydratedRun(row as BacktestRunSummary);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [run?.id]);

  /** Load equity + all trades as soon as the run is finished — not tied to active tab. */
  useEffect(() => {
    if (!doneEnoughForDetails || !run?.id) return;
    const runId = run.id;
    let cancelled = false;
    void (async () => {
      try {
        const eq = await api.getBacktestEquity(runId);
        const loaded: BacktestTrade[] = [];
        const pageSize = 2000;
        for (let offset = 0; ; offset += pageSize) {
          const tr = await api.getBacktestTrades(runId, { limit: pageSize, offset });
          const batch = (tr?.trades ?? []) as BacktestTrade[];
          loaded.push(...batch);
          if (batch.length < pageSize) break;
        }
        if (cancelled) return;
        setCurve((eq?.points ?? []) as BacktestEquityPoint[]);
        setTrades(loaded);
      } catch {
        if (!cancelled) {
          setCurve([]);
          setTrades([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [run?.id, doneEnoughForDetails]);

  const metrics = displayRun?.metrics ?? null;

  const walkForward = useMemo(
    () => (displayRun ? computeWalkForwardClient(displayRun, trades, curve) : null),
    [displayRun, trades, curve],
  );

  const failMsg =
    displayRun?.status === "failed" ? String(progress?.error ?? displayRun.error ?? "").trim() : "";

  if (!run || !displayRun) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">
        Select a run from the left, or queue a new one.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-950/60">
        <div>
          <div className="text-sm font-semibold">
            {displayRun.label || displayRun.engineType || "Backtest"}{" "}
            {displayRun.isPortfolio && displayRun.symbols?.length ? (
              <span className="inline-flex flex-wrap items-center gap-1 text-slate-500">
                · Portfolio ·
                {displayRun.symbols.map((sym) => (
                  <span
                    key={sym}
                    className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-sky-800 dark:bg-sky-900/50 dark:text-sky-200"
                  >
                    {sym.replace("USDT", "")}
                  </span>
                ))}
                · {displayRun.timeframe}
              </span>
            ) : (
              <span className="text-slate-500">· {displayRun.symbol} · {displayRun.timeframe}</span>
            )}
          </div>
          <div className="text-[11px] text-slate-500">
            {fmtRange(displayRun.startDate, displayRun.endDate)} · gate: {displayRun.gateMode}
            {displayRun.coveragePct != null && ` · coverage ${displayRun.coveragePct.toFixed(1)}%`}
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {status === "running" || status === "queued" ? (
            <span className="flex items-center gap-1.5 rounded bg-sky-100 px-2 py-1 font-mono text-sky-800 dark:bg-sky-900/40 dark:text-sky-200">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
              {status} · {livePct.toFixed(0)}%
            </span>
          ) : null}
          {displayRun.status === "done" && (
            <button
              type="button"
              onClick={() => setPromoteOpen(true)}
              className="rounded bg-emerald-600 px-3 py-1 font-semibold text-white hover:bg-emerald-500"
            >
              Promote to instance
            </button>
          )}
        </div>
      </header>

      {failMsg ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-900/50 dark:bg-rose-950/50 dark:text-rose-100">
          <div className="font-semibold">Run failed</div>
          <div className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px]">{failMsg}</div>
        </div>
      ) : null}

      {displayRun.coveragePct != null && displayRun.coveragePct < 99 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/50 dark:text-amber-100">
          <div className="font-semibold">Partial data coverage</div>
          <div className="mt-1">
            This run used {displayRun.coveragePct.toFixed(1)}% of expected candles for the window. Sync missing data before treating the
            result as reliable.
          </div>
        </div>
      ) : null}

      <KpiGrid run={displayRun} />

      <WalkForwardSummary run={displayRun} walkForward={walkForward} tradesLoaded={trades != null} />

      <div className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 text-xs dark:border-slate-800 dark:bg-slate-950/60">
        {(
          [
            ["kpis", "Summary"],
            ["equity", "Equity"],
            ["drawdown", "Drawdown"],
            ["monthly", "Monthly heatmap"],
            ["trades", "Trades"],
            ["distributions", "Distributions"],
            ["gate", "Gate ON/OFF"],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded px-3 py-1 ${tab === key ? "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-200" : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950/60">
        {tab === "kpis" && <SummaryBlock run={displayRun} trades={trades} />}
        {tab === "equity" && (
          curve == null ? (
            <Loading />
          ) : (
            <ChartErrorBoundary>
              <BacktestEquityChart points={curve} kind="equity" />
            </ChartErrorBoundary>
          )
        )}
        {tab === "drawdown" && (
          curve == null ? (
            <Loading />
          ) : (
            <ChartErrorBoundary>
              <BacktestEquityChart points={curve} kind="drawdown" />
            </ChartErrorBoundary>
          )
        )}
        {tab === "monthly" &&
          (metrics ? (
            <MonthlyHeatmapTable
              monthly={metrics.monthlyReturns ?? {}}
              trades={trades}
              curve={curve}
              initialCapital={displayRun.initialCapital}
            />
          ) : (
            <Empty />
          ))}
        {tab === "trades" &&
          (trades == null ? (
            <Loading />
          ) : (
            <TradeListTable
              trades={trades}
              futuresLeverage={futuresLeverage}
              variant="detailed"
              selectedTradeNumber={selectedTrade?.tradeNumber ?? null}
              onSelectTrade={setSelectedTrade}
            />
          ))}
        {tab === "distributions" && (
          trades == null ? <Loading /> : (
            <div className="space-y-3">
              <TrendHtfStChopSummary trades={trades} />
              <div className="grid gap-3 lg:grid-cols-2">
                <PnlHistogram trades={trades} />
                <MaeMfeScatter trades={trades} />
              </div>
            </div>
          )
        )}
        {tab === "gate" && (
          <div className="space-y-3">
            <GateReplaySummary run={displayRun} />
            <WithVsWithoutGatePanel run={displayRun} />
          </div>
        )}
      </div>

      {/* Trade chart + list — always below tabs when run is done */}
      {displayRun.status === "done" && (
        <div className="space-y-3">
          <ChartErrorBoundary>
            {/* Remount per run so chart TF + fetch state reset; avoids stale loading from aborted fetches */}
            <BacktestTradeChart
              key={displayRun.id}
              run={displayRun}
              trades={trades ?? []}
              selectedTrade={selectedTrade}
              onSelectTrade={setSelectedTrade}
            />
          </ChartErrorBoundary>
          <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950/60">
            <div className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
              Trades
              {trades != null && (
                <span className="ml-2 font-normal text-slate-500">({trades.length})</span>
              )}
            </div>
            {trades == null ? (
              <Loading />
            ) : (
              <TradeListTable
                trades={trades}
                futuresLeverage={futuresLeverage}
                selectedTradeNumber={selectedTrade?.tradeNumber ?? null}
                onSelectTrade={setSelectedTrade}
              />
            )}
          </div>
        </div>
      )}

      {promoteOpen && (
        <PromoteToInstanceModal
          run={displayRun}
          onClose={() => setPromoteOpen(false)}
          onSuccess={async () => {
            setPromoteOpen(false);
            await onAfterPromote();
          }}
        />
      )}
    </div>
  );
}

function fmtRange(a: string | undefined, b: string | undefined) {
  if (!a || !b) return "";
  const fmt = (s: string) =>
    new Date(s).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
  return `${fmt(a)} → ${fmt(b)}`;
}

function Loading() {
  return <div className="py-8 text-center text-sm text-slate-500">Loading…</div>;
}
function Empty() {
  return <div className="py-8 text-center text-sm text-slate-500">No data</div>;
}

function num(n: unknown, digits?: number): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return digits != null ? v.toFixed(digits) : String(v);
}

function WalkForwardSummary({
  run,
  walkForward,
  tradesLoaded,
}: {
  run: BacktestRunSummary;
  walkForward: BacktestMetrics["walkForward"] | null | undefined;
  tradesLoaded: boolean;
}) {
  const wf = walkForward ?? run.metrics?.walkForward;
  const splitPct = run.walkForwardSplit?.trainPct ?? wf?.trainPct;
  const wfRequested = splitPct != null && Number.isFinite(Number(splitPct));

  if (!wfRequested || run.status !== "done") return null;

  if (!wf?.train || !wf?.test) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100">
        <div className="font-semibold">Walk-forward ({Math.round(Number(splitPct) * 100)}% train)</div>
        <p className="mt-1 text-[10px]">
          {tradesLoaded
            ? "Could not compute train/test split — check that the run has trades in both windows."
            : "Loading train/test breakdown…"}
        </p>
      </div>
    );
  }

  const trainSharpe = wf.train.sharpe;
  const testSharpe = wf.test.sharpe;
  const stable =
    trainSharpe != null &&
    testSharpe != null &&
    Number.isFinite(trainSharpe) &&
    Number.isFinite(testSharpe) &&
    Math.sign(trainSharpe) === Math.sign(testSharpe);

  const splitLabel =
    wf.splitTs != null && Number.isFinite(Number(wf.splitTs))
      ? new Date(Number(wf.splitTs)).toISOString().slice(0, 10)
      : "—";

  const fmtPct = (n: unknown) => {
    const v = Number(n);
    return Number.isFinite(v) ? `${v.toFixed(1)}%` : "—";
  };
  const fmtNum = (n: unknown, d = 2) => {
    const v = Number(n);
    return Number.isFinite(v) ? v.toFixed(d) : "—";
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-950/60">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold text-slate-800 dark:text-slate-100">
          Walk-forward split ({Math.round((wf.trainPct ?? 0.7) * 100)}% train)
        </div>
        <div className="text-[10px] text-slate-500">Split date: {splitLabel}</div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div>
          <div className="text-[10px] uppercase text-slate-500">WF train→test Sharpe</div>
          <div className={`font-mono font-semibold ${stable ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
            {fmtNum(trainSharpe)} → {fmtNum(testSharpe)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-slate-500">Train return</div>
          <div className="font-mono">{fmtPct(wf.train.totalReturnPct)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-slate-500">Test return</div>
          <div className="font-mono">{fmtPct(wf.test.totalReturnPct)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-slate-500">Train / test trades</div>
          <div className="font-mono">
            {wf.train.totalTrades ?? 0} / {wf.test.totalTrades ?? 0}
          </div>
        </div>
      </div>
      <p className="mt-2 text-[10px] text-slate-500">
        Same full-window simulation; train/test rows split by trade exit time. Headline KPIs above are the full window.
      </p>
    </div>
  );
}

function KpiGrid({ run }: { run: BacktestRunSummary }) {
  const m = run.metrics;
  const kpis = useMemo(() => {
    const ret = m != null ? Number(m.totalReturnPct) : NaN;
    const wr = m != null ? Number(m.winRate) : NaN;
    return [
      {
        label: "Total return",
        value: Number.isFinite(ret) ? `${ret.toFixed(2)}%` : "—",
        tone: Number.isFinite(ret) && ret >= 0 ? ("pos" as const) : Number.isFinite(ret) ? ("neg" as const) : undefined,
      },
      { label: "Win rate", value: Number.isFinite(wr) ? `${(wr * 100).toFixed(1)}%` : "—" },
      { label: "Profit factor", value: num(m?.profitFactor, 2) },
      { label: "Sharpe", value: num(m?.sharpe, 2) },
      { label: "Max DD", value: Number.isFinite(Number(m?.maxDrawdownPct)) ? `${Number(m.maxDrawdownPct).toFixed(2)}%` : "—", tone: "neg" as const },
      { label: "# Trades", value: m != null && Number.isFinite(Number(m.totalTrades)) ? String(Math.round(Number(m.totalTrades))) : "—" },
      { label: "Expectancy", value: num(m?.expectancy, 2) },
      { label: "Avg hold", value: m != null && Number.isFinite(Number(m.avgHoldMs)) ? fmtMs(Number(m.avgHoldMs)) : "—" },
    ];
  }, [m]);
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
      {kpis.map((k) => (
        <div
          key={k.label}
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-950/60"
        >
          <div className="text-[10px] uppercase tracking-wide text-slate-500">{k.label}</div>
          <div
            className={`text-sm font-semibold ${k.tone === "pos" ? "text-emerald-600 dark:text-emerald-400" : k.tone === "neg" ? "text-rose-600 dark:text-rose-400" : "text-slate-900 dark:text-slate-100"}`}
          >
            {k.value}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Prefer `futuresLeverage` (live bot) then `leverage` (legacy / UI alias). */
function leverageSummary(cfg: Record<string, unknown>): string {
  const raw = cfg.futuresLeverage ?? cfg.leverage;
  if (raw == null || raw === "") return "—";
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const mode = cfg.futuresLeverageMode;
  const x = `${Math.floor(n)}×`;
  if (mode != null && String(mode).trim() !== "") return `${x} (${String(mode)})`;
  return x;
}

function SummaryBlock({ run, trades }: { run: BacktestRunSummary; trades: BacktestTrade[] | null }) {
  const [showCfgJson, setShowCfgJson] = useState(false);

  const cfg: Record<string, unknown> = useMemo(
    () =>
      effectiveBacktestBotCfg(
        run.configSnapshot,
        run.instanceOperationalSnapshot as Record<string, unknown> | null | undefined,
      ),
    [run.configSnapshot, run.instanceOperationalSnapshot],
  );

  const exitBreakdown = useMemo(() => {
    if (!trades || !trades.length) return null;
    const counts: Record<string, number> = {};
    for (const t of trades) {
      const r = t.exitReason ?? "unknown";
      counts[r] = (counts[r] ?? 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [trades]);

  const m = run.metrics;
  if (!m)
    return <div className="py-8 text-center text-sm text-slate-500">Pending…</div>;

  const fmt = (n: unknown, digits = 2) => {
    const v = Number(n);
    return Number.isFinite(v) ? v.toFixed(digits) : "—";
  };
  const cfgVal = (key: string) => (cfg[key] != null ? String(cfg[key]) : "—");

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
        <Card title="PnL breakdown">
          <Row k="Gross PnL" v={`${fmt(m.totalGrossPnl)} USDT`} />
          <Row k="Fees" v={`${fmt(m.totalFees)} USDT`} />
          <Row k="Funding paid" v={`${fmt(m.totalFunding)} USDT`} />
          <Row k="Slippage" v={`${fmt(m.totalSlippage)} USDT`} />
          <Row k="Net PnL" v={`${fmt(m.totalNetPnl)} USDT`} bold />
          {m.totalTrades > 0 && (
            <Row
              k="Avg fee/trade"
              v={`${(m.totalFees / m.totalTrades).toFixed(2)} USDT`}
            />
          )}
        </Card>
        <Card title="Trade stats">
          <Row k="Wins / Losses" v={`${m.wins} / ${m.losses}`} />
          <Row k="Avg win" v={fmt(m.avgWin)} />
          <Row k="Avg loss" v={fmt(m.avgLoss)} />
          <Row k="Largest win" v={fmt(m.largestWin)} />
          <Row k="Largest loss" v={fmt(m.largestLoss)} />
        </Card>
        <Card title="Risk">
          <Row k="Max drawdown" v={`${fmt(m.maxDrawdownPct)}%`} />
          <Row k="Drawdown duration" v={fmtMs(m.maxDrawdownDurationMs)} />
          <Row k="Sortino" v={fmt(m.sortino)} />
          <Row k="RoMD" v={m.romd != null ? fmt(m.romd) : "—"} />
        </Card>
        <Card title="Exit reasons">
          {exitBreakdown == null ? (
            <span className="text-slate-400">Loading…</span>
          ) : exitBreakdown.length === 0 ? (
            <span className="text-slate-400">No trades</span>
          ) : (
            exitBreakdown.map(([reason, cnt]) => (
              <Row
                key={reason}
                k={reason}
                v={`${cnt} (${((cnt / (trades?.length ?? 1)) * 100).toFixed(0)}%)`}
              />
            ))
          )}
        </Card>
        {run.isPortfolio && trades && trades.length > 0 ? (
          <Card title="Per-coin breakdown">
            <PortfolioPerCoinTable run={run} trades={trades} initialCapital={run.initialCapital} />
          </Card>
        ) : null}
        {trades && trades.length > 0 ? (
          <Card title="Session × weekday (UTC)">
            <SessionWeekdayHeatmap trades={trades} />
            {run.isPortfolio && run.symbols?.length ? (
              <div className="mt-3 space-y-3 border-t border-slate-200 pt-3 dark:border-slate-700">
                {run.symbols.map((sym) => {
                  const symTrades = trades.filter((t) => t.symbol === sym);
                  if (!symTrades.length) return null;
                  return (
                    <SessionWeekdayHeatmap
                      key={sym}
                      trades={symTrades}
                      title={sym.replace("USDT", "")}
                    />
                  );
                })}
              </div>
            ) : null}
          </Card>
        ) : null}
        <Card title="Gate replay (intelligence)">
          <Row k="Mode" v={String(m.gateReplay?.mode ?? run.gateMode ?? "off")} />
          <Row k="Evaluated" v={String(m.gateReplay?.evaluated ?? 0)} />
          <Row k="Passed" v={String(m.gateReplay?.pass ?? 0)} />
          <Row k="Vetoed" v={String(m.gateReplay?.vetoed ?? 0)} />
          <Row k="Size-scaled" v={String(m.gateReplay?.sizeScaled ?? 0)} />
          {m.gateReplay?.mode === "approx" &&
            (m.gateReplay?.evaluated ?? 0) > 0 &&
            (m.gateReplay?.vetoed ?? 0) === 0 &&
            (m.gateReplay?.sizeScaled ?? 0) === 0 && (
              <p className="mt-1.5 border-t border-slate-200 pt-1.5 text-[10px] leading-snug text-slate-600 dark:border-slate-700 dark:text-slate-400">
                MIS evaluated every entry but none met live veto bands (LONG needs composite ≤35, SHORT needs ≥65) and none
                triggered size scaling — matching trade count vs MIS off for this window is expected.
                {m.gateReplay.avgIntelScore != null && (
                  <> Avg replay composite at entries: {Number(m.gateReplay.avgIntelScore).toFixed(1)}.</>
                )}
              </p>
            )}
        </Card>
        {/* Show which gate flags were active in the config used for this run */}
        <GateStatusCard cfg={cfg} />
        {/* Fee-drag analysis — shows why a strategy is profitable or not */}
        {(() => {
          const feesTotal = Number(m.totalFees ?? 0);
          const slipTotal = Number(m.totalSlippage ?? 0);
          const grossTotal = Number(m.totalGrossPnl ?? 0);
          const capital = Number(run.initialCapital ?? 1000);
          const nTrades = Number(m.totalTrades ?? 0);
          if (nTrades === 0) return null;
          const avgFee = feesTotal / nTrades;
          const avgSlip = slipTotal / nTrades;
          const feeAsPctOfGross = Math.abs(grossTotal) > 0.01 ? (feesTotal / Math.abs(grossTotal)) * 100 : null;
          const feeAsPctCapital = capital > 0 ? (feesTotal / capital) * 100 : null;
          const winRateNeeded = avgFee > 0 && Math.abs(Number(m.avgLoss ?? 0)) > 0
            ? Math.abs(Number(m.avgLoss ?? 0)) / (Math.abs(Number(m.avgLoss ?? 0)) + Number(m.avgWin ?? 0))
            : null;
          return (
            <Card title="Fee drag analysis">
              <Row k="Avg fee/trade" v={`${avgFee.toFixed(2)} USDT`} />
              <Row k="Avg slip/trade" v={`${avgSlip.toFixed(2)} USDT`} />
              {feeAsPctCapital != null && <Row k="Fees % of capital" v={`${feeAsPctCapital.toFixed(1)}%`} />}
              {feeAsPctOfGross != null && (
                <Row k="Fees vs gross PnL" v={`${feeAsPctOfGross.toFixed(0)}% of gross`} />
              )}
              {winRateNeeded != null && (
                <Row k="Min WR to break even" v={`${(winRateNeeded * 100).toFixed(1)}%`} />
              )}
            </Card>
          );
        })()}
      </div>
      {/* Strategy config snapshot used for this run (from GET /runs/:id — not on list rows) */}
      {run.configSnapshot ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs dark:border-slate-800 dark:bg-slate-900/40">
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Strategy config used</span>
              <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-mono text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                {run.configSource === "instance_snapshot_with_live_panel"
                  || run.configSource === "instance_merged_live_panel"
                  || run.configSource === "strategy_with_live_panel"
                  ? "live panel merged"
                  : run.configSource === "instance_snapshot"
                    || run.configSource === "instance_merged"
                    ? "instance snapshot"
                    : "strategy only"}
              </span>
            </div>
            <button type="button" className="text-[11px] text-sky-600 dark:text-sky-400" onClick={() => setShowCfgJson((v) => !v)}>
              {showCfgJson ? "Hide raw JSON" : "Show raw JSON"}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3 lg:grid-cols-4">
            <Row k="Market mode" v={cfgVal("marketMode")} />
            <Row k="ST period" v={cfgVal("supertrendPeriod")} />
            <Row k="ST multiplier" v={cfgVal("supertrendMultiplier")} />
            <Row k="Trailing" v={cfgVal("futuresTrailingStopMode")} />
            <Row k="Trail auto" v={String(cfg.trailingStopLossAuto ?? "—")} />
            <Row k="Trail buffer" v={cfgVal("trailBufferRate")} />
            <Row k="Fixed SL %" v={cfgVal("supertrendFuturesFixedSlPct")} />
            <Row k="Fixed TP %" v={cfgVal("supertrendFuturesFixedTpPct")} />
            <Row
              k="SL bracket"
              v={cfgVal("supertrendFuturesUseFixedSl") === false ? "Off" : "On"}
            />
            <Row
              k="TP bracket"
              v={cfgVal("supertrendFuturesUseFixedTp") === false ? "Off" : "On"}
            />
            {(cfg.intradayGateLiquidity === true ||
              cfg.intradayGateInstitutionalSr === true ||
              cfg.intradaySrAPlusMode === true) && (
              <>
                <Row
                  k="Liq structure SL"
                  v={
                    cfg.supertrendFuturesUseFixedSl === false
                      ? "Off (no per-trade stop)"
                      : "On (sweep / level)"
                  }
                />
                <Row
                  k="Liq max SL cap"
                  v={
                    Number(cfg.intradayLiqMaxSlPct) > 0
                      ? `${(Number(cfg.intradayLiqMaxSlPct) * 100).toFixed(2)}%`
                      : "—"
                  }
                />
                <Row
                  k="Liq min R:R"
                  v={cfgVal("intradayLiqMinRr")}
                />
                <Row
                  k="Liq max TP R:R"
                  v={
                    Number(cfg.intradayLiqMaxTpRr) > 0
                      ? String(cfg.intradayLiqMaxTpRr)
                      : Number(cfg.intradaySmcMaxTpRr) > 0
                        ? `${cfg.intradaySmcMaxTpRr} (SMC fallback)`
                        : "off"
                  }
                />
                <Row
                  k="Liq TP2"
                  v={cfg.intradayLiqTp2Enabled === false ? "Off" : "On"}
                />
                <Row
                  k="Max hold (bars)"
                  v={String(
                    cfg.intradayLiqMaxHoldBars ??
                      cfg.intradaySmcMaxHoldBars ??
                      0,
                  )}
                />
              </>
            )}
            {Number(cfg.supertrendFuturesFixedSlPct) === 0 &&
            Number(cfg.supertrendFuturesFixedTpPct) === 0 &&
            (cfg.intradayGateLiquidity === true ||
              cfg.intradayGateInstitutionalSr === true) ? (
              <div className="col-span-2 rounded bg-slate-100 px-2 py-1 text-[10px] text-slate-700 dark:bg-slate-950/60 dark:text-slate-300 sm:col-span-4">
                <b>Fixed SL/TP 0%</b> is the global Supertrend % bracket (unused here). Trade exits labeled{" "}
                <span className="font-mono">sl</span> are hits on the <b>per-trade structure stop</b> placed beyond
                the liquidity sweep (see each trade&apos;s SL price), not a 0% stop.{" "}
                <span className="font-mono">time_stop</span> = max hold bars without TP.
              </div>
            ) : null}
            <Row k="Risk/trade" v={cfgVal("riskPerTrade")} />
            <Row k="Risk unit" v={cfgVal("riskPerTradeUnit")} />
            <Row k="Leverage" v={leverageSummary(cfg)} />
            <Row k="Intelligence gate" v={String(cfg.intelligenceGateEnabled ?? "—")} />
            <Row k="Market decision" v={String((cfg.marketDecision as Record<string,unknown>)?.enabled ?? "—")} />
            <Row k="Move quality gate" v={String(cfg.supertrendMoveQualityGate ?? "—")} />
            <Row k="Signal strength gate" v={String(cfg.signalStrengthGatesTrades ?? "—")} />
            <Row k="Breakout confirm" v={String(cfg.supertrendBreakoutConfirm ?? "—")} />
            <Row k="Max daily loss" v={cfgVal("maxDailyLoss")} />
            <Row k="SMC / ICT gate" v={String(cfg.intradayGateSmcIct === true || cfg.intradaySmcIctMode === true)} />
            <Row k="ICT profile" v={cfgVal("intradaySmcIctProfile")} />
            <Row k="Pick mode" v={cfgVal("intradaySmcPickMode")} />
            <Row k="Require MSS" v={String(cfg.intradaySmcRequireMss === true)} />
            <Row k="Require retrace" v={String(cfg.intradaySmcRequireRetrace === true)} />
            <Row k="Require CHoCH" v={String(cfg.intradaySmcRequireChoch === true)} />
            <Row k="Min R:R" v={cfgVal("intradaySmcMinRr")} />
            <Row k="Require BOS" v={String(cfg.intradaySmcRequireBos === true)} />
            <Row k="Require confirm" v={String(cfg.intradaySmcRequireConfirm === true)} />
            <Row k="Kill-zone" v={cfgVal("intradaySmcKillzoneMode")} />
            <Row k="HTF strictness" v={cfgVal("intradaySmcHtfStrictness")} />
            <Row k="HTF bias mode" v={cfgVal("intradaySmcHtfBiasMode")} />
            <Row k="Engine materialized" v={cfg._intradayEngineMaterialized === true ? "yes" : "no"} />
            {(cfg.intradayGateSmcIct === true || cfg.intradaySmcIctMode === true) &&
            String(cfg.intradaySmcIctProfile ?? "").toLowerCase() === "balanced" ? (
              <div className="col-span-2 rounded bg-amber-50 px-2 py-1 text-[10px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                Ran with <b>balanced</b> ICT (MSS + retrace, ~1/day) — not the tuned{" "}
                <b>sweep / per_signal</b> audit preset (CHoCH + London/NY). Apply <b>BNB 15m SMC/ICT</b> in Trading, then re-run.
              </div>
            ) : null}
          </div>
          {showCfgJson && (
            <pre className="mt-2 max-h-60 overflow-auto rounded bg-slate-100 p-2 text-[10px] dark:bg-slate-950">
              {JSON.stringify(run.configSnapshot, null, 2)}
            </pre>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-400">
          <span className="font-semibold uppercase tracking-wide text-slate-500">Strategy config used</span>
          <p className="mt-1">
            No config snapshot on this run (common for runs created before config_snapshot was saved, or if detail load
            failed). Queue a new backtest to capture the full strategy + intraday panel settings used by the engine.
          </p>
        </div>
      )}
    </div>
  );
}

function PortfolioPerCoinTable({
  run,
  trades,
  initialCapital,
}: {
  run: BacktestRunSummary;
  trades: BacktestTrade[];
  initialCapital: number;
}) {
  const fromMetrics = run.metrics?.portfolio?.perCoin;
  const symbols =
    run.symbols?.length ? run.symbols : [...new Set(trades.map((t) => t.symbol).filter(Boolean))];

  const rows = symbols.map((sym) => {
    const symTrades = trades.filter((t) => t.symbol === sym);
    const m = fromMetrics?.[sym];
    const net = m?.netPnl ?? symTrades.reduce((s, t) => s + Number(t.netPnl), 0);
    const n = m?.trades ?? symTrades.length;
    const wins = m?.wins ?? symTrades.filter((t) => Number(t.netPnl) > 0).length;
    const wr = m?.winRate ?? (n ? (wins / n) * 100 : 0);
    const retPct = initialCapital > 0 ? (net / initialCapital) * 100 : 0;
    return { sym, n, wr, net, retPct };
  });

  return (
    <table className="w-full text-[11px]">
      <thead>
        <tr className="text-left text-slate-500">
          <th className="pb-1">Coin</th>
          <th className="pb-1 text-right">Trades</th>
          <th className="pb-1 text-right">WR%</th>
          <th className="pb-1 text-right">Net PnL</th>
          <th className="pb-1 text-right">Contrib%</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.sym} className="border-t border-slate-100 dark:border-slate-800">
            <td className="py-1 font-mono font-semibold">{String(r.sym).replace("USDT", "")}</td>
            <td className="py-1 text-right font-mono">{r.n}</td>
            <td className="py-1 text-right font-mono">{r.wr.toFixed(1)}</td>
            <td className={`py-1 text-right font-mono ${r.net >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
              {r.net.toFixed(2)}
            </td>
            <td className="py-1 text-right font-mono text-slate-500">{r.retPct.toFixed(1)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Shows which indicator gates were ON/OFF in the config snapshot used for this run. */
function GateStatusCard({ cfg }: { cfg: Record<string, unknown> }) {
  const gates = [
    {
      label: "Intelligence gate",
      active: cfg.intelligenceGateEnabled === true,
      key: "intelligenceGateEnabled",
    },
    {
      label: "Market decision",
      active: !!(cfg.marketDecision && typeof cfg.marketDecision === "object" && (cfg.marketDecision as Record<string,unknown>).enabled === true),
      key: "marketDecision.enabled",
    },
    {
      label: "Move quality",
      active: cfg.supertrendMoveQualityGate === true,
      key: "supertrendMoveQualityGate",
    },
    {
      label: "Signal strength",
      active: cfg.signalStrengthGatesTrades === true,
      key: "signalStrengthGatesTrades",
    },
    {
      label: "Breakout confirm",
      active: cfg.supertrendBreakoutConfirm === true,
      key: "supertrendBreakoutConfirm",
    },
  ];
  const anyOn = gates.some((g) => g.active);
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 dark:border-slate-800 dark:bg-slate-900/40">
      <div className="pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Active entry gates</div>
      {!anyOn && (
        <div className="mb-1 rounded bg-amber-50 px-2 py-1 text-[10px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          All entry gates are off in the saved config used for this run — enable them in Trading strategy settings (Save),
          then run again for trade-filtering behavior.
        </div>
      )}
      <div className="space-y-0.5">
        {gates.map((g) => (
          <div key={g.key} className="flex items-center justify-between">
            <span className="text-[11px] text-slate-500">{g.label}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${g.active ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-400"}`}>
              {g.active ? "ON" : "OFF"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GateReplaySummary({ run }: { run: BacktestRunSummary }) {
  const g = run.metrics?.gateReplay;
  if (!g) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900/40">
        No run-level gate replay counters are available for this run.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
      <MiniStat label="Evaluated" value={String(g.evaluated)} />
      <MiniStat label="Pass" value={String(g.pass)} />
      <MiniStat label="Vetoed" value={String(g.vetoed)} />
      <MiniStat label="Size-scaled" value={String(g.sizeScaled)} />
      <MiniStat label="Avg score" value={g.avgIntelScore != null ? g.avgIntelScore.toFixed(1) : "—"} />
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="font-mono text-sm font-semibold">{value}</div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 dark:border-slate-800 dark:bg-slate-900/40">
      <div className="pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Row({ k, v, bold }: { k: string; v: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-500">{k}</span>
      <span className={`font-mono ${bold ? "font-bold" : ""}`}>{v}</span>
    </div>
  );
}

function fmtMs(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
