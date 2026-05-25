/**
 * Side-by-side comparison of "intelligence gate ON vs OFF". When a run was
 * queued with `gate_mode = 'approx'`, we render a small button to spawn a
 * shadow run with `gate_mode = 'off'` and identical config — letting the
 * user see whether the gate was actually adding value.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import type { BacktestRunSummary } from "../../types/backtest";

type Props = {
  run: BacktestRunSummary;
};

export function WithVsWithoutGatePanel({ run }: Props) {
  const [shadow, setShadow] = useState<BacktestRunSummary | null>(null);
  const [pending, setPending] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const isApprox = run.gateMode === "approx";

  useEffect(() => {
    setShadow(null);
  }, [run.id]);

  async function spawnShadow() {
    setErr(null);
    setPending(true);
    try {
      const res = await api.createBacktestRun({
        strategyVersionId: run.strategyVersionId ?? "",
        botInstanceId: run.botInstanceId ?? undefined,
        symbol: run.symbol,
        timeframe: run.timeframe,
        from: run.startDate,
        to: run.endDate,
        startingUsdt: run.initialCapital,
        gateMode: "off",
        label: `shadow:gate-off ${run.id.slice(0, 8)}`,
        costModel: (run.costModel as Record<string, unknown>) ?? undefined,
      });
      if (!res?.ok || !res.runId) throw new Error(res?.error || "create_failed");
      pollUntilDone(res.runId).catch(() => {
        /* ignore */
      });
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e ?? "error");
      setErr(m);
    } finally {
      setPending(false);
    }
  }

  async function pollUntilDone(runId: string) {
    for (let i = 0; i < 600; i++) {
      try {
        const r = await api.getBacktestRun(runId);
        const row = (r?.run ?? null) as BacktestRunSummary | null;
        if (row && (row.status === "done" || row.status === "failed" || row.status === "cancelled")) {
          setShadow(row);
          return;
        }
      } catch {
        /* keep polling */
      }
      await new Promise((rs) => setTimeout(rs, 2000));
    }
  }

  const left = run;
  const right = shadow;
  const compare = useMemo(() => {
    if (!right) return null;
    return [
      ["Total return %", left.metrics?.totalReturnPct ?? null, right.metrics?.totalReturnPct ?? null, "pct"],
      ["Win rate", left.metrics ? left.metrics.winRate * 100 : null, right.metrics ? right.metrics.winRate * 100 : null, "pct"],
      ["Profit factor", left.metrics?.profitFactor ?? null, right.metrics?.profitFactor ?? null, "raw"],
      ["Sharpe", left.metrics?.sharpe ?? null, right.metrics?.sharpe ?? null, "raw"],
      ["Max DD %", left.metrics?.maxDrawdownPct ?? null, right.metrics?.maxDrawdownPct ?? null, "pct"],
      ["Trades", left.metrics?.totalTrades ?? null, right.metrics?.totalTrades ?? null, "int"],
    ] as Array<[string, number | null, number | null, "pct" | "raw" | "int"]>;
  }, [left, right]);

  if (!isApprox) {
    return (
      <div className="text-sm text-slate-500">
        Run was executed with the intelligence gate <strong>off</strong>. Spawn a new run with{" "}
        <code className="font-mono">gateMode=approx</code> to see the comparison.
      </div>
    );
  }

  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-slate-500">
          Compare this <strong>gate=approx</strong> run with an identical <strong>gate=off</strong> shadow run on the
          same data.
        </div>
        <button
          type="button"
          onClick={spawnShadow}
          disabled={pending}
          className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-60"
        >
          {pending ? "Queuing…" : right ? "Re-run shadow" : "Run gate=off shadow"}
        </button>
      </div>
      {err && <div className="rounded bg-rose-50 px-2 py-1 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{err}</div>}
      {compare && (
        <table className="w-full">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-slate-500">
              <th className="px-2 py-1 text-left">Metric</th>
              <th className="px-2 py-1 text-right">Gate ON</th>
              <th className="px-2 py-1 text-right">Gate OFF</th>
              <th className="px-2 py-1 text-right">Δ</th>
            </tr>
          </thead>
          <tbody>
            {compare.map(([label, a, b, fmt]) => (
              <tr key={label} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-2 py-1">{label}</td>
                <td className="px-2 py-1 text-right font-mono">{fmtVal(a, fmt)}</td>
                <td className="px-2 py-1 text-right font-mono">{fmtVal(b, fmt)}</td>
                <td
                  className={`px-2 py-1 text-right font-mono ${a != null && b != null ? (a - b >= 0 ? "text-emerald-600" : "text-rose-600") : ""}`}
                >
                  {a != null && b != null ? fmtVal(a - b, fmt) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function fmtVal(v: number | null, fmt: "pct" | "raw" | "int") {
  if (v == null || !Number.isFinite(v)) return "—";
  if (fmt === "pct") return `${v.toFixed(2)}%`;
  if (fmt === "int") return String(Math.round(v));
  return v.toFixed(3);
}
