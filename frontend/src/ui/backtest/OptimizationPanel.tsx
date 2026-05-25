/**
 * Parameter sweep launcher + results viewer.
 *  - Launch box: pick parameter ranges (e.g. period 7..21, multiplier 2.0..4.0 step 0.5).
 *  - Status: progress per child run.
 *  - Heatmap: 2-param Sharpe (canvas) when grid has 2 keys; 1D line otherwise.
 *  - Walk-forward: not yet rendered as bar chart in v1; surfaced via `walkForward`
 *    payload and per-run `train/test` metric in `metrics.walkForward` (filled in by phase 8).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import type {
  BacktestOptimizationRun,
  BacktestOptimizationSummary,
  BacktestRunSummary,
} from "../../types/backtest";

type Props = {
  runs: BacktestRunSummary[];
  onSelectRun: (id: string) => void;
};

export function OptimizationPanel({ runs, onSelectRun }: Props) {
  const seedRun = runs[0];
  const [strategyVersionId, setStrategyVersionId] = useState<string>(seedRun?.strategyVersionId ?? "");
  const [symbol, setSymbol] = useState<string>(seedRun?.symbol ?? "BTCUSDT");
  const [timeframe, setTimeframe] = useState<string>(seedRun?.timeframe ?? "15m");
  const [from, setFrom] = useState<string>(() => defaultFrom());
  const [to, setTo] = useState<string>(() => defaultTo());
  const [periodFrom, setPeriodFrom] = useState<number>(7);
  const [periodTo, setPeriodTo] = useState<number>(15);
  const [periodStep, setPeriodStep] = useState<number>(2);
  const [multFrom, setMultFrom] = useState<number>(2);
  const [multTo, setMultTo] = useState<number>(4);
  const [multStep, setMultStep] = useState<number>(0.5);
  const [walkForwardOn, setWalkForwardOn] = useState<boolean>(true);
  const [trainPct, setTrainPct] = useState<number>(0.7);
  const [pending, setPending] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [optimizationId, setOptimizationId] = useState<string | null>(null);
  const [opt, setOpt] = useState<BacktestOptimizationSummary | null>(null);
  const [optRuns, setOptRuns] = useState<BacktestOptimizationRun[]>([]);

  useEffect(() => {
    if (!optimizationId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const r = await api.getOptimization(optimizationId);
        if (cancelled) return;
        setOpt((r?.optimization ?? null) as BacktestOptimizationSummary | null);
        setOptRuns(((r?.runs ?? []) as BacktestOptimizationRun[]) ?? []);
      } catch {
        /* ignore */
      }
      if (!cancelled) timer = setTimeout(tick, 3000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer != null) clearTimeout(timer);
    };
  }, [optimizationId]);

  async function launch() {
    setErr(null);
    setPending(true);
    try {
      if (!strategyVersionId) throw new Error("strategy_version_required");
      const periods = makeRange(periodFrom, periodTo, periodStep, "int");
      const mults = makeRange(multFrom, multTo, multStep, "float");
      if (!periods.length || !mults.length) throw new Error("invalid_grid");
      const res = await api.startOptimization({
        strategyVersionId,
        symbol,
        timeframe,
        from,
        to,
        startingUsdt: 10_000,
        paramGrid: { period: periods, multiplier: mults },
        walkForward: walkForwardOn ? { trainPct } : undefined,
      });
      if (!res?.ok || !res.optimizationId) throw new Error("optimization_failed");
      setOptimizationId(res.optimizationId);
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e ?? "error");
      setErr(m);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3 text-xs dark:border-slate-800 dark:bg-slate-950/60">
      <div className="text-sm font-semibold">Walk-forward optimization</div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Field label="Strategy version">
          <input
            value={strategyVersionId}
            onChange={(e) => setStrategyVersionId(e.target.value)}
            placeholder="uuid"
            className="input"
          />
        </Field>
        <Field label="Symbol">
          <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} className="input" />
        </Field>
        <Field label="Timeframe">
          <input value={timeframe} onChange={(e) => setTimeframe(e.target.value)} className="input" />
        </Field>
        <Field label="Train pct">
          <input
            type="number"
            step="0.05"
            min={0.1}
            max={0.9}
            value={trainPct}
            onChange={(e) => setTrainPct(Number(e.target.value))}
            disabled={!walkForwardOn}
            className="input"
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Field label="From">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input" />
        </Field>
        <Field label="To">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input" />
        </Field>
        <Field label="Walk-forward">
          <input
            type="checkbox"
            checked={walkForwardOn}
            onChange={(e) => setWalkForwardOn(e.target.checked)}
          />
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Period from">
          <input type="number" value={periodFrom} onChange={(e) => setPeriodFrom(Number(e.target.value))} className="input" />
        </Field>
        <Field label="Period to">
          <input type="number" value={periodTo} onChange={(e) => setPeriodTo(Number(e.target.value))} className="input" />
        </Field>
        <Field label="Step">
          <input type="number" value={periodStep} onChange={(e) => setPeriodStep(Number(e.target.value))} className="input" />
        </Field>
        <Field label="Multiplier from">
          <input type="number" step="0.1" value={multFrom} onChange={(e) => setMultFrom(Number(e.target.value))} className="input" />
        </Field>
        <Field label="Multiplier to">
          <input type="number" step="0.1" value={multTo} onChange={(e) => setMultTo(Number(e.target.value))} className="input" />
        </Field>
        <Field label="Step">
          <input type="number" step="0.1" value={multStep} onChange={(e) => setMultStep(Number(e.target.value))} className="input" />
        </Field>
      </div>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={launch}
          disabled={pending}
          className="rounded bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-60"
        >
          {pending ? "Queuing…" : "Run sweep"}
        </button>
        {err && <div className="rounded bg-rose-50 px-2 py-1 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{err}</div>}
      </div>

      {opt && (
        <div className="space-y-3 pt-2">
          <div className="flex items-center justify-between text-[11px]">
            <div>
              {opt.symbol} · {opt.timeframe} · {opt.nCompleted} / {opt.nRuns} done
            </div>
            <div className="text-slate-500">id: <span className="font-mono">{opt.id.slice(0, 8)}</span></div>
          </div>

          <Heatmap runs={optRuns} onSelect={onSelectRun} />
          <RunsTable runs={optRuns} onSelect={onSelectRun} bestRunId={opt.bestRunId} />
        </div>
      )}

      <style>{`
        .input { width: 100%; padding: 4px 6px; border-radius: 4px; border: 1px solid rgb(203 213 225); background: white; }
        .dark .input { background: rgb(15 23 42 / 0.6); border-color: rgb(51 65 85); color: rgb(226 232 240); }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block pb-0.5 text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function Heatmap({ runs, onSelect }: { runs: BacktestOptimizationRun[]; onSelect: (id: string) => void }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const points = useMemo(() => {
    return runs
      .filter((r) => r.status === "done")
      .map((r) => {
        const cfg = pickBot(r.configSnapshot);
        const period = Number(cfg?.supertrendPeriod);
        const mult = Number(cfg?.supertrendMultiplier);
        const sharpe = r.sharpeRatio != null ? Number(r.sharpeRatio) : null;
        return { period, mult, sharpe, runId: r.id };
      })
      .filter((p) => Number.isFinite(p.period) && Number.isFinite(p.mult) && p.sharpe != null);
  }, [runs]);

  useEffect(() => {
    if (!ref.current) return;
    const c = ref.current;
    const dpr = window.devicePixelRatio || 1;
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, c.clientWidth, c.clientHeight);
    if (!points.length) {
      ctx.fillStyle = "rgba(100, 116, 139, 0.7)";
      ctx.font = "12px system-ui";
      ctx.textAlign = "center";
      ctx.fillText("No completed runs yet", c.clientWidth / 2, c.clientHeight / 2);
      return;
    }
    const periods = [...new Set(points.map((p) => p.period))].sort((a, b) => a - b);
    const mults = [...new Set(points.map((p) => p.mult))].sort((a, b) => a - b);
    const w = c.clientWidth;
    const h = c.clientHeight;
    const padX = 32;
    const padY = 22;
    const cellW = (w - padX * 2) / periods.length;
    const cellH = (h - padY * 2) / mults.length;
    const sharpes = points.map((p) => p.sharpe!);
    const min = Math.min(...sharpes);
    const max = Math.max(...sharpes);
    const span = Math.max(1e-9, max - min);
    for (const p of points) {
      const x = padX + periods.indexOf(p.period) * cellW;
      const y = padY + (mults.length - 1 - mults.indexOf(p.mult)) * cellH;
      const v = (p.sharpe! - min) / span;
      ctx.fillStyle =
        p.sharpe! >= 0
          ? `rgba(16, 185, 129, ${0.2 + v * 0.6})`
          : `rgba(244, 63, 94, ${0.2 + (1 - v) * 0.6})`;
      ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
      ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
      ctx.font = "10px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(p.sharpe!.toFixed(2), x + cellW / 2, y + cellH / 2 + 3);
    }
    ctx.fillStyle = "rgba(100, 116, 139, 0.85)";
    ctx.font = "10px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("period →", w / 2, h - 4);
    ctx.save();
    ctx.translate(8, h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("multiplier →", 0, 0);
    ctx.restore();
  }, [points]);

  function onClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!ref.current || !points.length) return;
    const rect = ref.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const periods = [...new Set(points.map((p) => p.period))].sort((a, b) => a - b);
    const mults = [...new Set(points.map((p) => p.mult))].sort((a, b) => a - b);
    const padX = 32;
    const padY = 22;
    const cellW = (rect.width - padX * 2) / periods.length;
    const cellH = (rect.height - padY * 2) / mults.length;
    const ix = Math.floor((x - padX) / cellW);
    const iy = mults.length - 1 - Math.floor((y - padY) / cellH);
    if (ix < 0 || ix >= periods.length || iy < 0 || iy >= mults.length) return;
    const p = points.find((q) => q.period === periods[ix] && q.mult === mults[iy]);
    if (p) onSelect(p.runId);
  }

  return (
    <div className="rounded border border-slate-200 dark:border-slate-800">
      <div className="px-2 py-1 text-[11px] font-semibold uppercase text-slate-500">Sharpe heatmap</div>
      <canvas ref={ref} onClick={onClick} className="h-[220px] w-full cursor-pointer" />
    </div>
  );
}

function RunsTable({
  runs,
  onSelect,
  bestRunId,
}: {
  runs: BacktestOptimizationRun[];
  onSelect: (id: string) => void;
  bestRunId: string | null;
}) {
  if (!runs.length) return null;
  return (
    <div className="max-h-[40vh] overflow-y-auto rounded border border-slate-200 dark:border-slate-800">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-slate-50 text-left text-[10px] uppercase text-slate-500 dark:bg-slate-900">
          <tr>
            <th className="px-2 py-1">Run</th>
            <th className="px-2 py-1">Status</th>
            <th className="px-2 py-1 text-right">Trades</th>
            <th className="px-2 py-1 text-right">Win %</th>
            <th className="px-2 py-1 text-right">Net</th>
            <th className="px-2 py-1 text-right">Sharpe</th>
            <th className="px-2 py-1 text-right">DD %</th>
            <th className="px-2 py-1 text-right">WF train→test</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const wf = r.metrics?.walkForward;
            const trainSharpe = wf?.train?.sharpe ?? null;
            const testSharpe = wf?.test?.sharpe ?? null;
            const stable =
              trainSharpe != null && testSharpe != null && Math.sign(trainSharpe) === Math.sign(testSharpe);
            return (
              <tr
                key={r.id}
                onClick={() => onSelect(r.id)}
                className={`cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900 ${
                  r.id === bestRunId ? "bg-emerald-50 dark:bg-emerald-900/20" : ""
                }`}
              >
                <td className="px-2 py-1 font-mono text-[11px]">{r.label ?? r.id.slice(0, 8)}</td>
                <td className="px-2 py-1">{r.status}</td>
                <td className="px-2 py-1 text-right">{r.totalTrades}</td>
                <td className="px-2 py-1 text-right">
                  {r.winRatePct != null ? `${r.winRatePct.toFixed(1)}` : "—"}
                </td>
                <td className="px-2 py-1 text-right font-mono">
                  {r.totalPnlUsdt != null ? r.totalPnlUsdt.toFixed(2) : "—"}
                </td>
                <td className="px-2 py-1 text-right font-mono">
                  {r.sharpeRatio != null ? r.sharpeRatio.toFixed(2) : "—"}
                </td>
                <td className="px-2 py-1 text-right font-mono">
                  {r.maxDrawdownPct != null ? r.maxDrawdownPct.toFixed(2) : "—"}
                </td>
                <td
                  className={`px-2 py-1 text-right font-mono ${stable ? "text-emerald-600" : trainSharpe != null && testSharpe != null ? "text-rose-600" : "text-slate-400"}`}
                >
                  {trainSharpe != null && testSharpe != null
                    ? `${trainSharpe.toFixed(2)} → ${testSharpe.toFixed(2)}`
                    : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function pickBot(snapshot: Record<string, unknown> | null) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const root = snapshot as Record<string, unknown>;
  const bot = root.bot && typeof root.bot === "object" ? (root.bot as Record<string, unknown>) : root;
  return bot;
}

function makeRange(from: number, to: number, step: number, kind: "int" | "float") {
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(step) || step <= 0) return [];
  const out: number[] = [];
  for (let v = from; v <= to + 1e-9; v += step) {
    out.push(kind === "int" ? Math.round(v) : Number(v.toFixed(4)));
  }
  return out;
}

function defaultFrom() {
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  return d.toISOString().slice(0, 10);
}
function defaultTo() {
  return new Date().toISOString().slice(0, 10);
}
