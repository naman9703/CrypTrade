/**
 * Strategy testing panel — runs the full validation battery on a completed run:
 * baseline reproducibility, purged walk-forward, Monte Carlo, parameter
 * sensitivity (±10/±20%), cost stress, black-swan stress (synthetic + real
 * crash windows), acceptance gates, live-fidelity score, A/B/C/F grade, and a
 * suggested config within standard safety limits.
 *
 * Progress is polled over REST (same pattern as OptimizationPanel) because the
 * battery runs many simulations and phases matter more than per-sim ticks.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import type {
  BacktestRunSummary,
  StrategyTestReport,
  StrategyTestSuggestion,
  StrategyTestSummary,
} from "../../types/backtest";

type Props = {
  runs: BacktestRunSummary[];
};

const PHASE_LABELS: Record<string, string> = {
  loading: "Loading data",
  baseline: "Baseline re-run",
  walk_forward: "Walk-forward folds",
  monte_carlo: "Monte Carlo",
  sensitivity: "Parameter sensitivity",
  cost_stress: "Cost stress",
  black_swan: "Black-swan stress",
  scoring: "Gates + fidelity scoring",
  suggestion: "Config suggestion sweep",
  persisting: "Saving report",
  done: "Done",
};

const fmt = (n: number | null | undefined, d = 1) =>
  n != null && Number.isFinite(Number(n)) ? Number(n).toFixed(d) : "—";

export function StrategyTestPanel({ runs }: Props) {
  const doneRuns = useMemo(() => runs.filter((r) => r.status === "done"), [runs]);
  const [seedRunId, setSeedRunId] = useState<string>("");
  const [tests, setTests] = useState<StrategyTestSummary[]>([]);
  const [activeTestId, setActiveTestId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StrategyTestSummary | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!seedRunId && doneRuns.length) setSeedRunId(doneRuns[0].id);
  }, [doneRuns, seedRunId]);

  const refreshList = useCallback(async () => {
    try {
      const res = await api.listStrategyTests(20);
      const list = (res?.tests ?? []) as StrategyTestSummary[];
      setTests(list);
      if (!activeTestId && list.length) setActiveTestId(list[0].id);
    } catch {
      /* ignore */
    }
  }, [activeTestId]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const activeSummary = useMemo(
    () => tests.find((t) => t.id === activeTestId) ?? null,
    [tests, activeTestId],
  );
  const isActive = activeSummary?.status === "queued" || activeSummary?.status === "running";

  /** Poll detail while running; fetch once when done. */
  useEffect(() => {
    if (!activeTestId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    const fetchDetail = async () => {
      try {
        const res = await api.getStrategyTest(activeTestId);
        if (!cancelled && res?.test) setDetail(res.test as StrategyTestSummary);
      } catch {
        /* ignore */
      }
    };
    void fetchDetail();
    const t = setInterval(() => {
      void fetchDetail();
      void refreshList();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [activeTestId, refreshList]);

  const start = async () => {
    if (!seedRunId) return;
    setStarting(true);
    setError(null);
    try {
      const res = await api.startStrategyTest(seedRunId);
      if (res?.testId) {
        setActiveTestId(res.testId);
        await refreshList();
      } else {
        setError(String(res?.error ?? "start_failed"));
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!activeTestId) return;
    try {
      await api.cancelStrategyTest(activeTestId);
      await refreshList();
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="space-y-3">
      {/* Launcher */}
      <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-950/60">
        <div className="mb-2 text-sm font-semibold">Strategy testing battery</div>
        <p className="mb-3 text-[11px] text-slate-500">
          Re-runs the seed run's exact strategy + config on the full available history, then stress-tests it:
          walk-forward, Monte Carlo, ±10–20% parameter shifts, fee/slippage shocks, flash crashes, liquidity
          dry-ups, and real crash windows. Produces an A–F grade, a 0–100 live-fidelity score, and the best
          config within standard safety limits.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[18rem] flex-1 flex-col gap-1 text-[11px] text-slate-500">
            Seed run (completed)
            <select
              value={seedRunId}
              onChange={(e) => setSeedRunId(e.target.value)}
              className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            >
              {doneRuns.length === 0 ? <option value="">No completed runs</option> : null}
              {doneRuns.map((r) => (
                <option key={r.id} value={r.id}>
                  {(r.label || r.engineType || "run").slice(0, 40)} · {r.symbol} · {r.timeframe} ·{" "}
                  {r.totalTrades ?? 0} trades · {r.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!seedRunId || starting || Boolean(isActive)}
            onClick={() => void start()}
            className="rounded bg-sky-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {starting ? "Starting…" : "Run full test"}
          </button>
        </div>
        {error ? <div className="mt-2 text-[11px] text-rose-600">{error}</div> : null}
        <p className="mt-2 text-[10px] text-slate-400">
          The battery runs 30–40 simulations on full history — expect 30–60+ minutes for long 15m windows.
        </p>
      </div>

      {/* Test history */}
      {tests.length > 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-950/60">
          <div className="mb-2 text-xs font-semibold text-slate-700 dark:text-slate-200">Previous tests</div>
          <div className="flex flex-wrap gap-1.5">
            {tests.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTestId(t.id)}
                className={`rounded border px-2 py-1 text-[10px] ${
                  t.id === activeTestId
                    ? "border-sky-400 bg-sky-50 text-sky-700 dark:border-sky-600 dark:bg-sky-900/30 dark:text-sky-200"
                    : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                }`}
              >
                {t.seedSymbol ?? "?"} · {t.seedTimeframe ?? "?"} ·{" "}
                {t.grade ? <GradeBadge grade={t.grade} small /> : t.status}
                {" · "}
                {new Date(t.createdAt).toLocaleDateString()}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Active test */}
      {detail ? (
        detail.status === "done" && detail.report ? (
          <TestReport test={detail} report={detail.report} suggestion={detail.suggestion ?? null} />
        ) : (
          <ProgressCard test={detail} onCancel={cancel} />
        )
      ) : (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">
          Select a completed run above and start a test, or pick a previous test.
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────────── progress ───────────────────────────────── */

function fmtDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Re-render every second so elapsed/ETA tick while a test runs. */
function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function ProgressCard({ test, onCancel }: { test: StrategyTestSummary; onCancel: () => void }) {
  const running = test.status === "queued" || test.status === "running";
  const now = useNowTick(running);

  const startedMs = test.startedAt ? new Date(test.startedAt).getTime() : null;
  const elapsedMs = running && startedMs != null ? Math.max(0, now - startedMs) : null;
  const pct = Number(test.progressPct) || 0;
  // Linear extrapolation from progress so far. Only shown once there is enough
  // signal (a few % and a few seconds) — early phases would wildly overshoot.
  const etaMs =
    elapsedMs != null && pct >= 3 && elapsedMs > 5_000 ? (elapsedMs * (100 - pct)) / pct : null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950/60">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold">
          Test {test.id.slice(0, 8)} · {test.seedSymbol} · {test.seedTimeframe}
        </div>
        {running ? (
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-rose-300 px-2 py-1 text-[11px] text-rose-600 hover:bg-rose-50 dark:border-rose-700 dark:hover:bg-rose-950/40"
          >
            Cancel
          </button>
        ) : null}
      </div>
      {running ? (
        <>
          <div className="mb-1 flex items-center justify-between text-[11px] text-slate-500">
            <span>
              Phase: {PHASE_LABELS[test.currentPhase ?? ""] ?? test.currentPhase ?? "queued"}
            </span>
            <span>{fmt(test.progressPct, 1)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded bg-slate-100 dark:bg-slate-800">
            <div
              className="h-full bg-sky-500 transition-all"
              style={{ width: `${Math.min(100, Math.max(1, test.progressPct))}%` }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between font-mono text-[11px] text-slate-500">
            <span>{elapsedMs != null ? `Elapsed ${fmtDuration(elapsedMs)}` : "Waiting in queue…"}</span>
            <span>
              {etaMs != null
                ? `~${fmtDuration(etaMs)} remaining`
                : elapsedMs != null
                  ? "Estimating time remaining…"
                  : ""}
            </span>
          </div>
        </>
      ) : test.status === "failed" ? (
        <div className="text-xs text-rose-600">Failed: {test.error ?? "unknown error"}</div>
      ) : (
        <div className="text-xs text-slate-500">Status: {test.status}</div>
      )}
    </div>
  );
}

/* ────────────────────────────────── report ───────────────────────────────── */

function GradeBadge({ grade, small = false }: { grade: string; small?: boolean }) {
  const color =
    grade === "A"
      ? "bg-emerald-600 text-white"
      : grade === "B"
        ? "bg-sky-600 text-white"
        : grade === "C"
          ? "bg-amber-500 text-white"
          : "bg-rose-600 text-white";
  return (
    <span
      className={`inline-flex items-center justify-center rounded font-bold ${color} ${
        small ? "h-4 w-4 text-[9px]" : "h-10 w-10 text-xl"
      }`}
    >
      {grade}
    </span>
  );
}

function Section({ title, children, subtitle }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-950/60">
      <div className="mb-1 text-xs font-semibold text-slate-700 dark:text-slate-200">{title}</div>
      {subtitle ? <p className="mb-2 text-[10px] text-slate-500">{subtitle}</p> : null}
      {children}
    </div>
  );
}

function pnlClass(v: number | null | undefined) {
  if (v == null || !Number.isFinite(Number(v))) return "text-slate-400";
  return Number(v) >= 0 ? "text-emerald-600" : "text-rose-600";
}

function TestReport({
  test,
  report,
  suggestion,
}: {
  test: StrategyTestSummary;
  report: StrategyTestReport;
  suggestion: StrategyTestSuggestion | null;
}) {
  const b = report.baseline?.metrics;
  return (
    <div className="space-y-3">
      {/* Verdict header */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950/60">
        <div className="flex flex-wrap items-center gap-4">
          <GradeBadge grade={report.grade.grade} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">
              {report.strategyKey} · {report.symbols.join(", ")} · {report.timeframe}
              {report.isPortfolio ? " · portfolio" : ""}
            </div>
            <ul className="mt-1 list-disc pl-4 text-[11px] text-slate-600 dark:text-slate-300">
              {report.grade.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
          <FidelityGauge score={report.fidelity.score} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4 lg:grid-cols-6">
          <Kpi label="Net return" v={`${fmt(b?.totalReturnPct)}%`} cls={pnlClass(b?.totalReturnPct)} />
          <Kpi label="Max DD" v={`${fmt(b?.maxDrawdownPct)}%`} />
          <Kpi label="Profit factor" v={fmt(b?.profitFactor, 2)} />
          <Kpi label="Sharpe" v={fmt(b?.sharpe, 2)} />
          <Kpi label="Calmar" v={fmt(b?.calmar, 2)} />
          <Kpi label="Trades" v={String(b?.totalTrades ?? "—")} />
        </div>
        <p className="mt-2 text-[10px] text-slate-500">
          Full-history window: {new Date(report.window.from).toISOString().slice(0, 10)} →{" "}
          {new Date(report.window.to).toISOString().slice(0, 10)} ({report.window.bars.toLocaleString()} bars) ·{" "}
          {report.window.note ? `${report.window.note} · ` : ""}
          {report.baseline.reproducibility.note}
        </p>
      </div>

      {/* Acceptance gates */}
      <Section
        title="Acceptance gates"
        subtitle="A strategy is only considered real when all four gates pass (same harness as the CLI validation scripts)."
      >
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {Object.entries(report.gates.gates).map(([key, g]) => (
            <div
              key={key}
              className={`rounded border px-2 py-1.5 text-[11px] ${
                g.pass
                  ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30"
                  : "border-rose-300 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/30"
              }`}
            >
              <div className="font-semibold">
                {g.pass ? "✓" : "✗"} {gateLabel(key)}
              </div>
              <div className="text-slate-600 dark:text-slate-300">
                {fmt(Number(g.value), 2)} (need {g.threshold})
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* Live-fidelity factors */}
      <Section
        title={`Live-trading fidelity — ${fmt(report.fidelity.score, 0)}/100`}
        subtitle="How closely the backtest result should resemble live trading with the same strategy + config. Higher = more trustworthy."
      >
        <table className="w-full text-[11px]">
          <tbody>
            {report.fidelity.factors.map((f) => (
              <tr key={f.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1 pr-2 font-medium">{f.label}</td>
                <td className="w-28 py-1 pr-2">
                  <div className="h-1.5 overflow-hidden rounded bg-slate-100 dark:bg-slate-800">
                    <div
                      className={`h-full ${f.score / f.max >= 0.7 ? "bg-emerald-500" : f.score / f.max >= 0.4 ? "bg-amber-500" : "bg-rose-500"}`}
                      style={{ width: `${(f.score / f.max) * 100}%` }}
                    />
                  </div>
                </td>
                <td className="w-14 py-1 pr-2 font-mono text-slate-500">
                  {fmt(f.score, 1)}/{f.max}
                </td>
                <td className="py-1 text-slate-500">{f.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* Walk-forward */}
      <Section
        title="Walk-forward (purged, 1-day embargo)"
        subtitle={report.walkForward.note ?? "Train on older bars, test on unseen future bars — catches overfit."}
      >
        <table className="w-full text-[11px]">
          <thead className="text-left text-[10px] uppercase text-slate-500">
            <tr>
              <th className="py-1 pr-2">Fold</th>
              <th className="py-1 pr-2">Train trades</th>
              <th className="py-1 pr-2">Train exp.</th>
              <th className="py-1 pr-2">Test trades</th>
              <th className="py-1 pr-2">Test return</th>
              <th className="py-1 pr-2">Test PF</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {report.walkForward.folds.map((f) => (
              <tr key={f.fold} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1 pr-2">{f.fold + 1}</td>
                <td className="py-1 pr-2">{f.train.trades}</td>
                <td className="py-1 pr-2">${fmt(f.train.expectancy, 2)}</td>
                <td className="py-1 pr-2">{f.test.trades}</td>
                <td className={`py-1 pr-2 ${pnlClass(f.test.returnPct)}`}>{fmt(f.test.returnPct)}%</td>
                <td className="py-1 pr-2">{fmt(f.test.profitFactor, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2 flex flex-wrap gap-4 text-[11px]">
          <span>
            Degradation:{" "}
            <b className={report.walkForward.degradationPct < 35 ? "text-emerald-600" : "text-rose-600"}>
              {fmt(report.walkForward.degradationPct)}%
            </b>{" "}
            (need &lt;35%)
          </span>
          <span>
            OOS sum return:{" "}
            <b className={pnlClass(report.walkForward.oosSumReturnPct)}>{fmt(report.walkForward.oosSumReturnPct)}%</b>
          </span>
        </div>
      </Section>

      {/* Monte Carlo */}
      <Section
        title={`Monte Carlo (${report.monteCarlo.paths.toLocaleString()} reshuffled paths)`}
        subtitle="Resamples the trade sequence to ask: was the result luck? The 5th percentile must stay positive."
      >
        {report.monteCarlo.insufficient ? (
          <div className="text-[11px] text-amber-600">
            Too few trades ({report.monteCarlo.rCount}) for a meaningful Monte Carlo — treat all stats with caution.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-3 lg:grid-cols-6">
            <Kpi label="p5 return" v={`${fmt(report.monteCarlo.p5ReturnPct)}%`} cls={pnlClass(report.monteCarlo.p5ReturnPct)} />
            <Kpi label="Median return" v={`${fmt(report.monteCarlo.p50ReturnPct)}%`} cls={pnlClass(report.monteCarlo.p50ReturnPct)} />
            <Kpi label="p95 return" v={`${fmt(report.monteCarlo.p95ReturnPct)}%`} />
            <Kpi label="Median max DD" v={`${fmt(report.monteCarlo.medianMaxDdPct)}%`} />
            <Kpi label="p95 max DD" v={`${fmt(report.monteCarlo.p95MaxDdPct)}%`} />
            <Kpi
              label="Risk of ruin"
              v={`${fmt(report.monteCarlo.riskOfRuinPct, 2)}%`}
              cls={report.monteCarlo.riskOfRuinPct < 1 ? "text-emerald-600" : "text-rose-600"}
            />
          </div>
        )}
      </Section>

      {/* Parameter sensitivity */}
      <Section
        title="Parameter sensitivity (±10% / ±20%)"
        subtitle='"What if your key parameter shifts?" — a real edge survives perturbation; an overfit one breaks.'
      >
        {report.sensitivity.params.length === 0 ? (
          <div className="text-[11px] text-slate-500">No perturbable numeric parameters found on this config.</div>
        ) : (
          <>
            <table className="w-full text-[11px]">
              <thead className="text-left text-[10px] uppercase text-slate-500">
                <tr>
                  <th className="py-1 pr-2">Parameter</th>
                  <th className="py-1 pr-2">Base</th>
                  <th className="py-1 pr-2">Shift</th>
                  <th className="py-1 pr-2">Value</th>
                  <th className="py-1 pr-2">Return</th>
                  <th className="py-1 pr-2">PF</th>
                  <th className="py-1 pr-2">Trades</th>
                  <th className="py-1 pr-2">Verdict</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {report.sensitivity.params.flatMap((p) =>
                  p.variants.map((v, i) => (
                    <tr key={`${p.key}-${v.delta}`} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="py-1 pr-2">{i === 0 ? p.key : ""}</td>
                      <td className="py-1 pr-2">{i === 0 ? p.base : ""}</td>
                      <td className="py-1 pr-2">{v.delta}</td>
                      <td className="py-1 pr-2">{fmt(v.value, Number.isInteger(v.value) ? 0 : 2)}</td>
                      <td className={`py-1 pr-2 ${pnlClass(v.returnPct)}`}>{fmt(v.returnPct)}%</td>
                      <td className="py-1 pr-2">{fmt(v.profitFactor, 2)}</td>
                      <td className="py-1 pr-2">{v.trades}</td>
                      <td className="py-1 pr-2">
                        {v.breaks ? (
                          <span className="rounded bg-rose-100 px-1.5 py-0.5 font-sans font-semibold text-rose-700 dark:bg-rose-900/50 dark:text-rose-300">
                            BREAKS
                          </span>
                        ) : v.noEffect ? (
                          <span
                            className="text-slate-400"
                            title="The engine clamps or ignores this value — the variant produced results identical to baseline and is excluded from the break rate."
                          >
                            no effect (clamped)
                          </span>
                        ) : (
                          <span className="text-emerald-600">stable</span>
                        )}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
            <div className="mt-2 text-[11px]">
              Break rate:{" "}
              <b className={Number(report.sensitivity.breakRatePct) <= 25 ? "text-emerald-600" : "text-rose-600"}>
                {fmt(report.sensitivity.breakRatePct, 0)}%
              </b>{" "}
              of {report.sensitivity.variantCount} perturbations —{" "}
              {report.sensitivity.stable ? "broad plateau (good)" : "overfit island (bad)"}
            </div>
          </>
        )}
      </Section>

      {/* Cost stress */}
      <Section
        title="Cost stress"
        subtitle="What if live execution is worse than modeled? Fee/slippage shocks reveal how much edge is real vs cost-fragile."
      >
        <table className="w-full text-[11px]">
          <thead className="text-left text-[10px] uppercase text-slate-500">
            <tr>
              <th className="py-1 pr-2">Scenario</th>
              <th className="py-1 pr-2">Return</th>
              <th className="py-1 pr-2">Δ vs base</th>
              <th className="py-1 pr-2">Trades</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {report.costStress.map((c) => (
              <tr key={c.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1 pr-2 font-sans">{c.label}</td>
                <td className={`py-1 pr-2 ${pnlClass(c.returnPct)}`}>{fmt(c.returnPct)}%</td>
                <td className={`py-1 pr-2 ${pnlClass(c.deltaVsBasePct)}`}>{fmt(c.deltaVsBasePct)}%</td>
                <td className="py-1 pr-2">{c.trades}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {report.feesOverGrossPct != null ? (
          <div className="mt-2 text-[11px] text-slate-600 dark:text-slate-300">
            Fees consume <b>{fmt(report.feesOverGrossPct, 0)}%</b> of gross PnL at baseline.
          </div>
        ) : null}
      </Section>

      {/* Black swan stress */}
      <Section
        title="Black-swan stress"
        subtitle='"What happens during a flash crash, a grinding bear, or when liquidity dries up?" Synthetic shocks + real crash windows where data exists.'
      >
        <table className="w-full text-[11px]">
          <thead className="text-left text-[10px] uppercase text-slate-500">
            <tr>
              <th className="py-1 pr-2">Scenario</th>
              <th className="py-1 pr-2">Type</th>
              <th className="py-1 pr-2">Return</th>
              <th className="py-1 pr-2">Max DD</th>
              <th className="py-1 pr-2">Trades</th>
              <th className="py-1 pr-2">Survived</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {report.stress.map((s) => (
              <tr key={s.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1 pr-2 font-sans">
                  {s.label}
                  {s.window ? <span className="text-slate-400"> ({s.window})</span> : null}
                </td>
                <td className="py-1 pr-2 font-sans text-slate-500">{s.kind}</td>
                {s.skipped ? (
                  <td colSpan={4} className="py-1 pr-2 font-sans text-slate-400">
                    Skipped — {s.reason}
                  </td>
                ) : (
                  <>
                    <td className={`py-1 pr-2 ${pnlClass(s.returnPct)}`}>{fmt(s.returnPct)}%</td>
                    <td className="py-1 pr-2">{fmt(s.maxDrawdownPct)}%</td>
                    <td className="py-1 pr-2">{s.trades ?? "—"}</td>
                    <td className="py-1 pr-2 font-sans">
                      {s.survived ? (
                        <span className="text-emerald-600">✓ yes</span>
                      ) : (
                        <span className="font-semibold text-rose-600">✗ NO</span>
                      )}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* Suggestion */}
      {suggestion ? <SuggestionCard suggestion={suggestion} /> : null}

      <p className="text-[10px] text-slate-400">
        Test {test.id.slice(0, 8)} · seed run {report.seedRunId.slice(0, 8)} · finished{" "}
        {test.finishedAt ? new Date(test.finishedAt).toLocaleString() : "—"}
      </p>
    </div>
  );
}

function gateLabel(key: string): string {
  switch (key) {
    case "oosPositive":
      return "OOS return > 0";
    case "mcP5Positive":
      return "MC p5 > 0";
    case "calmarOver1":
      return "Calmar > 1";
    case "wfDegradationOk":
      return "WF degradation";
    default:
      return key;
  }
}

function Kpi({ label, v, cls = "" }: { label: string; v: string; cls?: string }) {
  return (
    <div className="rounded border border-slate-100 px-2 py-1 dark:border-slate-800">
      <div className="text-[9px] uppercase text-slate-500">{label}</div>
      <div className={`font-mono text-xs font-semibold ${cls}`}>{v}</div>
    </div>
  );
}

function FidelityGauge({ score }: { score: number }) {
  const color = score >= 70 ? "text-emerald-600" : score >= 45 ? "text-amber-500" : "text-rose-600";
  return (
    <div className="text-center">
      <div className={`font-mono text-2xl font-bold ${color}`}>{Math.round(score)}</div>
      <div className="text-[9px] uppercase text-slate-500">live fidelity / 100</div>
    </div>
  );
}

function SuggestionCard({ suggestion }: { suggestion: StrategyTestSuggestion }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (label: string, obj: unknown) => {
    void navigator.clipboard.writeText(JSON.stringify(obj, null, 2)).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  return (
    <Section
      title="Suggested configuration"
      subtitle={`Max return within standard safety limits: max DD ≤ ${suggestion.safetyLimits.maxDrawdownPct}%, Monte Carlo p5 > ${suggestion.safetyLimits.mcP5ReturnPct}%, risk of ruin < ${suggestion.safetyLimits.riskOfRuinPct}%.`}
    >
      {suggestion.coinSuitability ? (
        <div
          className={`mb-3 rounded-lg border p-2 text-[11px] ${
            suggestion.coinSuitability === "PASS"
              ? "border-emerald-200 bg-emerald-50/60 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200"
              : suggestion.coinSuitability === "MARGINAL"
                ? "border-amber-200 bg-amber-50/60 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
                : "border-rose-200 bg-rose-50/60 text-rose-900 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200"
          }`}
        >
          Coin suitability: <b>{suggestion.coinSuitability}</b>
          {suggestion.recommendedSepMode ? (
            <span className="ml-2 text-slate-600 dark:text-slate-400">
              Recommended sep mode: <span className="font-mono">{suggestion.recommendedSepMode}</span>
            </span>
          ) : null}
          {suggestion.coinSuitability === "SKIP" ? (
            <span className="mt-1 block">Consider skipping this coin in the portfolio — do not chase more per-coin tuning.</span>
          ) : null}
        </div>
      ) : null}
      {suggestion.best ? (
        <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-900 dark:bg-emerald-950/30">
          <div className="mb-1 text-xs font-semibold text-emerald-800 dark:text-emerald-200">
            ★ {suggestion.best.label}
          </div>
          <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
            <Kpi label="Return" v={`${fmt(suggestion.best.metrics.totalReturnPct)}%`} cls="text-emerald-600" />
            <Kpi label="Max DD" v={`${fmt(suggestion.best.metrics.maxDrawdownPct)}%`} />
            <Kpi label="MC p5" v={`${fmt(suggestion.best.metrics.mcP5ReturnPct)}%`} />
            <Kpi label="Ruin risk" v={`${fmt(suggestion.best.metrics.riskOfRuinPct, 2)}%`} />
          </div>
          {Object.keys(suggestion.best.cfgPatch).length > 0 ? (
            <div className="mt-2 text-[11px]">
              Config changes vs seed:{" "}
              <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] dark:bg-slate-900">
                {JSON.stringify(suggestion.best.cfgPatch)}
              </code>
            </div>
          ) : (
            <div className="mt-2 text-[11px] text-slate-600 dark:text-slate-300">
              The seed config as tested is already the best safe candidate.
            </div>
          )}
        </div>
      ) : (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {suggestion.note ?? "No configuration satisfied the safety limits."}
        </div>
      )}

      <table className="w-full text-[11px]">
        <thead className="text-left text-[10px] uppercase text-slate-500">
          <tr>
            <th className="py-1 pr-2">Candidate</th>
            <th className="py-1 pr-2">Return</th>
            <th className="py-1 pr-2">Max DD</th>
            <th className="py-1 pr-2">MC p5</th>
            <th className="py-1 pr-2">Ruin</th>
            <th className="py-1 pr-2">Safe</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {suggestion.candidates.map((c) => (
            <tr key={c.label} className="border-t border-slate-100 dark:border-slate-800">
              <td className="py-1 pr-2 font-sans">{c.label}</td>
              <td className={`py-1 pr-2 ${pnlClass(c.totalReturnPct)}`}>{fmt(c.totalReturnPct)}%</td>
              <td className="py-1 pr-2">{fmt(c.maxDrawdownPct)}%</td>
              <td className={`py-1 pr-2 ${pnlClass(c.mcP5ReturnPct)}`}>{fmt(c.mcP5ReturnPct)}%</td>
              <td className="py-1 pr-2">{fmt(c.riskOfRuinPct, 2)}%</td>
              <td className="py-1 pr-2 font-sans">{c.withinLimits ? "✓" : "✗"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
        <div className="mb-1 text-[11px] font-semibold">Recommended instance safety overlay</div>
        <p className="mb-2 text-[10px] text-slate-500">
          Apply these operational limits on any live instance regardless of backtest results (SAFE_INTRADAY
          conventions: daily loss cap, kill switch, consecutive-loss pause).
        </p>
        <pre className="overflow-x-auto rounded bg-slate-50 p-2 font-mono text-[10px] dark:bg-slate-900">
          {JSON.stringify(suggestion.instanceConfig, null, 2)}
        </pre>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => copy("instance", suggestion.instanceConfig)}
            className="rounded border border-slate-300 px-2 py-1 text-[10px] hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800"
          >
            {copied === "instance" ? "Copied ✓" : "Copy instance config"}
          </button>
          {suggestion.best && Object.keys(suggestion.best.cfgPatch).length > 0 ? (
            <button
              type="button"
              onClick={() => copy("patch", suggestion.best?.cfgPatch)}
              className="rounded border border-slate-300 px-2 py-1 text-[10px] hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800"
            >
              {copied === "patch" ? "Copied ✓" : "Copy config patch"}
            </button>
          ) : null}
        </div>
      </div>
    </Section>
  );
}
