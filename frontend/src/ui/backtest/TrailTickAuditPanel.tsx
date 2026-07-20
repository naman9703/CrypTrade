import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { effectiveBacktestBotCfg } from "../../lib/backtestEffectiveCfg";
import type { BacktestRunSummary, TrailTickAuditResult } from "../../types/backtest";
import { useAppStore } from "../../ws/store";

type Props = {
  run: BacktestRunSummary;
};

type Estimate = {
  trailingEnabled?: boolean;
  tradeCount?: number;
  replayableCount?: number;
  holdHours?: number;
  aggTradeDays?: number;
  estimatedTicks?: number;
  etaSec?: number;
  recommendBackground?: boolean;
};

function trailingEnabledInCfg(bot: Record<string, unknown>): boolean {
  const isFutures = String(bot.marketMode ?? bot.market ?? "").toUpperCase() === "FUTURES";
  const mode = String(bot.futuresTrailingStopMode ?? "SUPERTREND").toUpperCase();
  return bot.trailingStopLossAuto === true && isFutures && mode !== "OFF";
}

export function TrailTickAuditPanel({ run }: Props) {
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [audit, setAudit] = useState<TrailTickAuditResult | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<"hybrid" | "mark_1m_ohlc" | "aggTrade_proxy">("mark_1m_ohlc");
  const [progressPct, setProgressPct] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const wsProgress = useAppStore((s) => s.trailTickAuditProgress[run.id]);

  const bot = useMemo(
    () => effectiveBacktestBotCfg(run.configSnapshot, run.instanceOperationalSnapshot),
    [run.configSnapshot, run.instanceOperationalSnapshot],
  );
  const trailingOn = trailingEnabledInCfg(bot);

  const loadAudit = useCallback(async () => {
    try {
      const res = await api.getTrailTickAudit(run.id);
      const a = (res?.audit ?? null) as TrailTickAuditResult | null;
      if (a && typeof a === "object") setAudit(a);
      setRunning(res?.running === true || a?.status === "running");
      if (a?.status === "done" || a?.status === "failed") {
        setRunning(false);
        setProgressPct(a.status === "done" ? 100 : null);
      }
    } catch {
      /* ignore */
    }
  }, [run.id]);

  useEffect(() => {
    setEstimate(null);
    setAudit(null);
    setErr(null);
    setProgressPct(null);
    setRunning(false);
    if (!trailingOn || run.status !== "done") return;
    void api.getTrailTickAuditEstimate(run.id).then((res) => {
      if (res?.estimate) setEstimate(res.estimate as Estimate);
    }).catch(() => {});
    void loadAudit();
  }, [run.id, run.status, trailingOn, loadAudit]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      void loadAudit();
    }, 2000);
    return () => clearInterval(t);
  }, [running, loadAudit]);

  useEffect(() => {
    if (!wsProgress) return;
    if (wsProgress.progressPct != null) setProgressPct(wsProgress.progressPct);
    if (wsProgress.status === "done") {
      setRunning(false);
      setProgressPct(100);
      void loadAudit();
    } else if (wsProgress.status === "failed") {
      setRunning(false);
      if (wsProgress.error) setErr(wsProgress.error);
      void loadAudit();
    } else if (wsProgress.status === "running") {
      setRunning(true);
    }
  }, [wsProgress, loadAudit]);

  async function startAudit(force = false) {
    setErr(null);
    setRunning(true);
    setProgressPct(0);
    try {
      const res = await api.runTrailTickAudit(run.id, { mode, force });
      if (res?.inline && res?.result) {
        setAudit(res.result as TrailTickAuditResult);
        setRunning(false);
        setProgressPct(100);
        return;
      }
      if (res?.started) {
        void loadAudit();
        return;
      }
      setRunning(false);
      await loadAudit();
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e ?? "error");
      setErr(m);
      setRunning(false);
    }
  }

  if (!trailingOn) {
    return (
      <div className="text-sm text-slate-500">
        Trailing was off for this run — tick replay audit applies only when{" "}
        <code className="font-mono">trailingStopLossAuto</code> is enabled on futures.
      </div>
    );
  }

  if (run.status !== "done") {
    return <div className="text-sm text-slate-500">Available when the backtest run completes.</div>;
  }

  const verdict = audit?.verdict;
  const perTrade = audit?.perTrade ?? [];

  return (
    <div className="space-y-3 text-xs">
      <div className="rounded border border-amber-200/80 bg-amber-50/80 px-3 py-2 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
        Replays <strong>1m mark micro trailing</strong> — the same engine path as the backtest runner when mark
        klines are loaded. Use mode <strong>hybrid</strong> only to compare live aggTrade tick trailing (expect gap).
      </div>

      {estimate && (
        <div className="text-slate-600 dark:text-slate-400">
          ~{estimate.replayableCount ?? 0} replayable trades · ~{estimate.estimatedTicks?.toLocaleString() ?? "—"}{" "}
          ticks · {estimate.aggTradeDays ?? 0} aggTrade day(s) · est. {estimate.etaSec ?? "—"}s
          {estimate.recommendBackground ? " (background recommended)" : ""}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-slate-500">
          Mode
          <select
            className="rounded border border-slate-200 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
            disabled={running}
          >
            <option value="mark_1m_ohlc">1m mark micro (backtest-aligned)</option>
            <option value="hybrid">Hybrid aggTrade + mark (live-style)</option>
            <option value="aggTrade_proxy">aggTrade price proxy</option>
          </select>
        </label>
        <button
          type="button"
          disabled={running}
          onClick={() => startAudit(false)}
          className="rounded bg-violet-600 px-3 py-1 font-semibold text-white hover:bg-violet-500 disabled:opacity-60"
        >
          {running ? "Running…" : audit?.status === "done" ? "Re-run tick audit" : "Run trailing tick audit"}
        </button>
        {estimate?.recommendBackground && !running && (
          <button
            type="button"
            onClick={() => startAudit(true)}
            className="rounded border border-slate-300 px-2 py-1 text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300"
          >
            Force full tick replay
          </button>
        )}
      </div>

      {running && (
        <div className="space-y-1">
          <div className="h-2 overflow-hidden rounded bg-slate-200 dark:bg-slate-800">
            <div
              className="h-full bg-violet-500 transition-all"
              style={{ width: `${progressPct ?? 30}%` }}
            />
          </div>
          <div className="text-slate-500">Fetching ticks → replay → compare…</div>
        </div>
      )}

      {err && (
        <div className="rounded bg-rose-50 px-2 py-1 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          {err}
        </div>
      )}

      {audit?.status === "failed" && (
        <div className="rounded bg-rose-50 px-2 py-1 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          Audit failed: {audit.error ?? "unknown"}
        </div>
      )}

      {verdict && audit?.status === "done" && (
        <div className="rounded-xl border border-violet-200 bg-violet-50/50 p-3 dark:border-violet-900/50 dark:bg-violet-950/20">
          <div className="text-lg font-semibold text-violet-800 dark:text-violet-200">
            Trailing parity: {verdict.parityPct}%
          </div>
          <div className="mt-1 text-slate-600 dark:text-slate-400">
            Exit reason match {verdict.exitReasonMatchPct}% · tier match {verdict.trailTierMatchPct}% · aggregate
            PnL delta {verdict.netPnlDeltaPct}%
            {verdict.medianExitTimeDeltaMs != null
              ? ` · median exit time Δ ${(verdict.medianExitTimeDeltaMs / 60_000).toFixed(1)}m`
              : ""}
          </div>
        </div>
      )}

      {verdict && audit?.status === "done" && (
        <table className="w-full">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-slate-500">
              <th className="px-2 py-1 text-left">Metric</th>
              <th className="px-2 py-1 text-right">Value</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["Exit reason match %", verdict.exitReasonMatchPct],
              ["Trail tier match %", verdict.trailTierMatchPct],
              ["Median exit time delta (ms)", verdict.medianExitTimeDeltaMs],
              ["Net PnL delta %", verdict.netPnlDeltaPct],
              ["Replayable trades", verdict.replayableCount],
              ["Compared trades", verdict.comparedCount],
              ["Skipped (non-trail exits)", verdict.skippedCount],
            ].map(([label, val]) => (
              <tr key={String(label)} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-2 py-1">{label}</td>
                <td className="px-2 py-1 text-right font-mono">{val ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {perTrade.length > 0 && audit?.status === "done" && (
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Per trade</div>
          <table className="w-full">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-slate-500">
                <th className="px-2 py-1 text-left">#</th>
                <th className="px-2 py-1 text-left">BT exit</th>
                <th className="px-2 py-1 text-left">Tick exit</th>
                <th className="px-2 py-1 text-right">Match</th>
              </tr>
            </thead>
            <tbody>
              {perTrade.map((t) => (
                <Fragment key={t.tradeNumber}>
                  <tr
                    className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900/40"
                    onClick={() =>
                      setExpanded(expanded === t.tradeNumber ? null : t.tradeNumber)
                    }
                  >
                    <td className="px-2 py-1 font-mono">{t.tradeNumber}</td>
                    <td className="px-2 py-1">
                      {t.replaySkipped ? `skip (${t.skipReason ?? "—"})` : t.backtest?.exitReason ?? "—"}
                    </td>
                    <td className="px-2 py-1">
                      {t.replaySkipped ? "—" : t.replay?.exitReason ?? (t.replay?.noExitInWindow ? "no exit" : "—")}
                    </td>
                    <td className="px-2 py-1 text-right">
                      {t.replaySkipped ? "—" : t.match ? "✓" : "≠"}
                    </td>
                  </tr>
                  {expanded === t.tradeNumber && !t.replaySkipped && (
                    <tr className="bg-slate-50/80 dark:bg-slate-900/30">
                      <td colSpan={4} className="px-3 py-2 font-mono text-[10px] text-slate-600 dark:text-slate-400">
                        BT tier {t.backtest?.trailTierLabel ?? t.backtest?.trailStep ?? "—"} → tick{" "}
                        {t.replay?.trailTierLabel ?? t.replay?.trailStep ?? "—"}
                        {t.exitTimeDeltaMs != null ? ` · Δt ${t.exitTimeDeltaMs}ms` : ""}
                        {t.exitPriceDeltaPct != null ? ` · Δpx ${t.exitPriceDeltaPct.toFixed(3)}%` : ""}
                        {t.netPnlDelta != null ? ` · Δpnl ${t.netPnlDelta.toFixed(2)}` : ""}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
