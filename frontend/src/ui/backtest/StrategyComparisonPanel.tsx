/**
 * Pick up to 3 completed runs, render a side-by-side metrics table and an
 * overlaid equity curve (colour-coded). Equity curves fetched lazily from
 * `/api/backtest/runs/:id/equity-curve`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ColorType, createChart, type LineData, type UTCTimestamp } from "lightweight-charts";

const IST_OFFSET_SEC = 5 * 3600 + 30 * 60;
const toIst = (utcSec: number) => utcSec + IST_OFFSET_SEC;
import { api } from "../../api/client";
import type { BacktestEquityPoint, BacktestRunSummary } from "../../types/backtest";
import { ChartErrorBoundary } from "../ChartErrorBoundary";

const COLORS = ["#0284c7", "#16a34a", "#dc2626"];

type Props = {
  runs: BacktestRunSummary[];
};

export function StrategyComparisonPanel({ runs }: Props) {
  const completed = useMemo(() => runs.filter((r) => r.status === "done"), [runs]);
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const [curves, setCurves] = useState<Record<string, BacktestEquityPoint[]>>({});

  function toggle(id: string) {
    setPickedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 3) return prev;
      return [...prev, id];
    });
  }

  useEffect(() => {
    const missing = pickedIds.filter((id) => !curves[id]);
    if (!missing.length) return;
    void (async () => {
      const next: Record<string, BacktestEquityPoint[]> = { ...curves };
      for (const id of missing) {
        try {
          const r = await api.getBacktestEquity(id);
          next[id] = (r?.points ?? []) as BacktestEquityPoint[];
        } catch {
          next[id] = [];
        }
      }
      setCurves(next);
    })();
  }, [pickedIds, curves]);

  const picked = useMemo(
    () => pickedIds.map((id) => runs.find((r) => r.id === id)).filter((x): x is BacktestRunSummary => !!x),
    [pickedIds, runs],
  );

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3 text-xs dark:border-slate-800 dark:bg-slate-950/60">
      <div className="text-sm font-semibold">Compare runs (up to 3)</div>
      <div className="flex flex-wrap gap-1">
        {completed.map((r) => {
          const idx = pickedIds.indexOf(r.id);
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => toggle(r.id)}
              className={`rounded border px-2 py-1 ${
                idx >= 0
                  ? "border-sky-400 bg-sky-50 dark:border-sky-700 dark:bg-sky-900/40"
                  : "border-slate-200 dark:border-slate-700"
              }`}
              style={idx >= 0 ? { borderColor: COLORS[idx] } : undefined}
              title={r.id}
            >
              {idx >= 0 && <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: COLORS[idx] }} />}
              {r.label || r.engineType || "Run"} · {r.symbol} · {r.timeframe}
            </button>
          );
        })}
      </div>
      {picked.length === 0 ? (
        <div className="py-6 text-center text-slate-500">Pick up to three completed runs to compare.</div>
      ) : (
        <>
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-2 py-1 text-left">Metric</th>
                {picked.map((r, i) => (
                  <th key={r.id} className="px-2 py-1 text-right" style={{ color: COLORS[i] }}>
                    {r.label || "Run"}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <Row label="Total return %" picked={picked} pick={(r) => r.metrics?.totalReturnPct ?? null} fmt="pct" />
              <Row label="Win rate" picked={picked} pick={(r) => (r.metrics ? r.metrics.winRate * 100 : null)} fmt="pct" />
              <Row label="Profit factor" picked={picked} pick={(r) => r.metrics?.profitFactor ?? null} fmt="raw" />
              <Row label="Sharpe" picked={picked} pick={(r) => r.metrics?.sharpe ?? null} fmt="raw" />
              <Row label="Max DD %" picked={picked} pick={(r) => r.metrics?.maxDrawdownPct ?? null} fmt="pct" />
              <Row label="Trades" picked={picked} pick={(r) => r.metrics?.totalTrades ?? null} fmt="int" />
            </tbody>
          </table>
          <ChartErrorBoundary>
            <OverlaidEquityCurve picked={picked} curves={curves} />
          </ChartErrorBoundary>
        </>
      )}
    </div>
  );
}

function Row({
  label,
  picked,
  pick,
  fmt,
}: {
  label: string;
  picked: BacktestRunSummary[];
  pick: (r: BacktestRunSummary) => number | null;
  fmt: "pct" | "raw" | "int";
}) {
  return (
    <tr className="border-t border-slate-100 dark:border-slate-800">
      <td className="px-2 py-1">{label}</td>
      {picked.map((r) => {
        const v = pick(r);
        return (
          <td key={r.id} className="px-2 py-1 text-right font-mono">
            {fmtVal(v, fmt)}
          </td>
        );
      })}
    </tr>
  );
}

function fmtVal(v: number | null, fmt: "pct" | "raw" | "int") {
  if (v == null || !Number.isFinite(v)) return "—";
  if (fmt === "pct") return `${v.toFixed(2)}%`;
  if (fmt === "int") return String(Math.round(v));
  return v.toFixed(3);
}

function OverlaidEquityCurve({
  picked,
  curves,
}: {
  picked: BacktestRunSummary[];
  curves: Record<string, BacktestEquityPoint[]>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#64748b",
      },
      grid: {
        horzLines: { color: "rgba(148, 163, 184, 0.2)" },
        vertLines: { color: "rgba(148, 163, 184, 0.1)" },
      },
      timeScale: { borderVisible: false, timeVisible: true },
      rightPriceScale: { borderVisible: false },
    });
    picked.forEach((r, idx) => {
      const points = curves[r.id] ?? [];
      if (!points.length) return;
      const series = chart.addLineSeries({ color: COLORS[idx], lineWidth: 2 });
      let lastT = 0;
      const data: LineData[] = [];
      for (const p of points) {
        let t = toIst(Math.floor(Number(p.ts) / 1000));
        if (t <= lastT) t = lastT + 1;
        lastT = t;
        data.push({ time: t as UTCTimestamp, value: Number(p.equity) });
      }
      series.setData(data);
    });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [picked, curves]);

  return <div ref={ref} className="h-[260px] w-full" />;
}
