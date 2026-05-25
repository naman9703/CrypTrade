/**
 * Promote a completed backtest into a real `bot_instances` row pointing at a
 * newly-created `strategy_versions` snapshot (with `promoted_from` lineage).
 *
 * Hard-coded gates:
 *   trades >= 50, win rate >= 55%, profit factor >= 1.5,
 *   max drawdown <= 15%, sharpe >= 1.0
 *   AND non-zero taker fee (zero-fee mode disables Promote)
 *
 * `ignoreThresholds` exists for advanced users but is logged server-side.
 */
import { useState } from "react";
import { api } from "../../api/client";
import type { BacktestRunSummary } from "../../types/backtest";

type Props = {
  run: BacktestRunSummary;
  onClose: () => void;
  onSuccess: () => void | Promise<void>;
};

const MODES = [
  ["paper", "Paper"],
  ["demo_api", "Demo API"],
  ["testnet", "Testnet"],
  ["live", "Live"],
] as const;

export function PromoteToInstanceModal({ run, onClose, onSuccess }: Props) {
  const [modeSlug, setModeSlug] = useState<string>("paper");
  const [label, setLabel] = useState<string>(`from BT ${run.id.slice(0, 8)}`);
  const [capitalMode, setCapitalMode] = useState<"FIXED" | "PCT">("FIXED");
  const [capitalUsdt, setCapitalUsdt] = useState<number>(1000);
  const [capitalPct, setCapitalPct] = useState<number>(10);
  const [ignoreThresholds, setIgnoreThresholds] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    setSubmitting(true);
    try {
      const res = await api.promoteBacktestRun(run.id, {
        modeSlug,
        label,
        capitalMode,
        capitalUsdt: capitalMode === "FIXED" ? capitalUsdt : undefined,
        capitalPct: capitalMode === "PCT" ? capitalPct : undefined,
        ignoreThresholds,
      });
      if (!res?.ok) throw new Error(res?.message || res?.error || "promote_failed");
      await onSuccess();
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e ?? "error");
      setErr(m);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-xl dark:border-slate-800 dark:bg-slate-950">
        <div className="flex items-center justify-between pb-2">
          <div className="text-base font-semibold">Promote backtest to instance</div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">
            ✕
          </button>
        </div>
        <div className="space-y-2 text-xs">
          <div>
            <span className="block pb-0.5 text-[10px] uppercase tracking-wide text-slate-500">Trading mode</span>
            <select
              value={modeSlug}
              onChange={(e) => setModeSlug(e.target.value)}
              className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
            >
              {MODES.map(([slug, label]) => (
                <option key={slug} value={slug}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <span className="block pb-0.5 text-[10px] uppercase tracking-wide text-slate-500">Label</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="block pb-0.5 text-[10px] uppercase tracking-wide text-slate-500">Capital mode</span>
              <select
                value={capitalMode}
                onChange={(e) => setCapitalMode(e.target.value as "FIXED" | "PCT")}
                className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
              >
                <option value="FIXED">Fixed USDT</option>
                <option value="PCT">% of wallet</option>
              </select>
            </div>
            <div>
              <span className="block pb-0.5 text-[10px] uppercase tracking-wide text-slate-500">
                {capitalMode === "FIXED" ? "USDT" : "% of available"}
              </span>
              {capitalMode === "FIXED" ? (
                <input
                  type="number"
                  value={capitalUsdt}
                  onChange={(e) => setCapitalUsdt(Number(e.target.value))}
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
                />
              ) : (
                <input
                  type="number"
                  value={capitalPct}
                  onChange={(e) => setCapitalPct(Number(e.target.value))}
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
                />
              )}
            </div>
          </div>
          <label className="flex items-center gap-1 pt-1 text-[11px]">
            <input
              type="checkbox"
              checked={ignoreThresholds}
              onChange={(e) => setIgnoreThresholds(e.target.checked)}
            />
            Override promotion thresholds (logged)
          </label>
          {err && (
            <div className="rounded bg-rose-50 px-2 py-1 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
              {err}
            </div>
          )}
          <div className="pt-2 text-right">
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-60"
            >
              {submitting ? "Promoting…" : "Promote"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
