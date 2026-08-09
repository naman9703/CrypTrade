/**
 * Train Supertrend XGBoost from a completed ST backtest run, inspect OOS metrics /
 * importance, then queue a gated re-sim (Layer 3 confirmation — not a new signal).
 */
import { useMemo, useState } from "react";
import { api } from "../../api/client";
import { effectiveBacktestBotCfg } from "../../lib/backtestEffectiveCfg";
import type { BacktestRunSummary, BacktestTrade } from "../../types/backtest";

type SplitMetrics = {
  n?: number;
  kept?: number;
  keep_n?: number;
  keep_frac?: number | null;
  wr?: number | null;
  mean_r?: number | null;
  pf?: number | null;
};

type TrainMeta = {
  threshold?: number;
  model_kind?: string;
  trained_at?: string;
  trained_rows?: number;
  train_end_ts?: number | null;
  feature_importance?: Array<{ feature: string; importance: number }>;
  splits?: { train?: SplitMetrics; validation?: SplitMetrics; oos?: SplitMetrics };
  baseline_splits?: { oos?: SplitMetrics };
  freq_ok_val?: boolean;
  oos_pf_ge_1?: boolean;
  oos_mean_r_positive?: boolean;
  source_run_id?: string;
};

type Props = {
  run: BacktestRunSummary;
  trades: BacktestTrade[] | null;
  onQueued?: (runId: string) => void;
};

function isSupertrendFamily(run: BacktestRunSummary): boolean {
  const bot = effectiveBacktestBotCfg(run.configSnapshot, run.instanceOperationalSnapshot);
  const strat = String(bot.manualStrategy ?? run.engineType ?? "").toUpperCase();
  return (
    strat === "SUPERTREND" ||
    strat === "SUPERTREND_ELITE" ||
    strat === "UNIFIED_ELITE" ||
    strat.includes("SUPERTREND")
  );
}

function fmt(n: unknown, d = 2): string {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(d) : "—";
}

function Chip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
        ok
          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
          : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
      }`}
    >
      {label}
    </span>
  );
}

export function SupertrendXgbPanel({ run, trades, onQueued }: Props) {
  const [busy, setBusy] = useState<"train" | "apply" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [meta, setMeta] = useState<TrainMeta | null>(null);
  const [canApply, setCanApply] = useState(false);
  const [queuedId, setQueuedId] = useState<string | null>(null);

  const eligible = useMemo(() => {
    if (run.status !== "done") return false;
    return isSupertrendFamily(run);
  }, [run]);

  const nTrades = trades?.length ?? run.metrics?.totalTrades ?? 0;
  const softWarn = nTrades > 0 && nTrades < 200;
  const tooFew = nTrades > 0 && nTrades < 80;

  if (!eligible) return null;

  async function train() {
    setErr(null);
    setBusy("train");
    try {
      const res = await api.trainSupertrendXgb(run.id);
      if (!res?.ok) throw new Error(res?.error || "train_failed");
      setMeta((res.meta as TrainMeta) ?? null);
      setCanApply(Boolean(res.canApply));
    } catch (e: unknown) {
      let msg = e instanceof Error ? e.message : String(e ?? "train_failed");
      if (/^not found$/i.test(msg.trim()) || /http_404/i.test(msg)) {
        msg =
          "Train API not found (404). Rebuild/restart the backend that serves :8000 (Docker: docker compose up -d --build app ai). Vite proxies to 127.0.0.1:8000.";
      }
      setErr(msg);
    } finally {
      setBusy(null);
    }
  }

  async function applyGate() {
    setErr(null);
    setBusy("apply");
    try {
      const thr = meta?.threshold;
      const res = await api.applySupertrendXgb(run.id, thr != null ? { threshold: thr } : undefined);
      if (!res?.ok || !res.runId) throw new Error(res?.error || "apply_failed");
      setQueuedId(res.runId);
      onQueued?.(res.runId);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e ?? "apply_failed"));
    } finally {
      setBusy(null);
    }
  }

  const oos = meta?.splits?.oos;
  const baseOos = meta?.baseline_splits?.oos;
  const topImp = (meta?.feature_importance ?? []).slice(0, 8);

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-950/60">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-semibold text-slate-800 dark:text-slate-100">Supertrend XGBoost gate</div>
          <p className="mt-0.5 text-[10px] text-slate-500">
            Train a Layer-3 quality gate on entry-time features from this run (time-split 60/20/20). Not live-deployable
            until OOS gates pass. After Apply, compare trade count and{" "}
            <code className="font-mono">metrics.stXgbReplay</code> (pass/veto/failOpen) — identical N to baseline usually
            means the gate never scored (AI URL / fail-open).
          </p>
        </div>
        <button
          type="button"
          onClick={train}
          disabled={busy != null || tooFew}
          className="rounded bg-violet-600 px-3 py-1 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
        >
          {busy === "train" ? "Training…" : "Train XGBoost"}
        </button>
      </div>

      {tooFew && (
        <div className="mt-2 text-[10px] text-amber-700 dark:text-amber-300">
          Need ≥80 trades to train (have {nTrades}). Soft target ≥200 for stable importance.
        </div>
      )}
      {!tooFew && softWarn && (
        <div className="mt-2 text-[10px] text-amber-700 dark:text-amber-300">
          Only {nTrades} trades — results may be noisy (prefer ≥200).
        </div>
      )}

      {err && (
        <div className="mt-2 rounded bg-rose-50 px-2 py-1 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          {err}
        </div>
      )}

      {meta && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-1.5">
            <Chip ok={Boolean(meta.freq_ok_val)} label="freq_ok (≥50% val)" />
            <Chip ok={Boolean(meta.oos_pf_ge_1)} label="oos_pf_ge_1" />
            <Chip ok={Boolean(meta.oos_mean_r_positive)} label="oos_mean_r>0" />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div>
              <div className="text-[10px] uppercase text-slate-500">Threshold</div>
              <div className="font-mono font-semibold">{fmt(meta.threshold, 2)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-slate-500">OOS n (kept)</div>
              <div className="font-mono">
                {oos?.kept ?? oos?.keep_n ?? "—"} / {oos?.n ?? "—"}
                {baseOos?.n != null ? (
                  <span className="text-slate-500"> (base {baseOos.n})</span>
                ) : null}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-slate-500">OOS WR / mean R</div>
              <div className="font-mono">
                {oos?.wr != null ? `${(Number(oos.wr) * 100).toFixed(0)}%` : "—"} / {fmt(oos?.mean_r)}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-slate-500">OOS PF</div>
              <div className="font-mono">{fmt(oos?.pf)}</div>
            </div>
          </div>
          {topImp.length > 0 && (
            <div>
              <div className="text-[10px] uppercase text-slate-500">Top feature importance</div>
              <ul className="mt-1 grid gap-0.5 sm:grid-cols-2">
                {topImp.map((row) => (
                  <li key={row.feature} className="flex justify-between gap-2 font-mono text-[10px]">
                    <span className="truncate text-slate-600 dark:text-slate-300">{row.feature}</span>
                    <span>{fmt(row.importance, 3)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={applyGate}
              disabled={busy != null || !canApply}
              className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
              title={!canApply ? "Train must succeed with freq_ok on validation" : undefined}
            >
              {busy === "apply" ? "Queuing…" : "Apply gate & re-backtest"}
            </button>
            {queuedId && (
              <span className="font-mono text-[10px] text-slate-500">
                Queued gated run <span className="text-sky-600 dark:text-sky-400">{queuedId.slice(0, 8)}</span>
              </span>
            )}
            {meta.model_kind && (
              <span className="text-[10px] text-slate-500">
                {meta.model_kind} · trained {meta.trained_rows ?? "?"} rows
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
