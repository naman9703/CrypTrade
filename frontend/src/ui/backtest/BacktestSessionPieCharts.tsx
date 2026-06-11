/**
 * Per-session win/loss pies for the selected backtest (entry time UTC).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import { breakdownTradesBySession, type SessionTradeBreakdown } from "../../lib/backtestSessionStats";
import type { BacktestRunSummary, BacktestTrade } from "../../types/backtest";

type Props = {
  run: BacktestRunSummary | null;
};

function drawPie(
  canvas: HTMLCanvasElement,
  breakdown: SessionTradeBreakdown,
  dark: boolean,
) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  const { total, wins, losses, breakeven, winPct, lossPct, breakevenPct } = breakdown;
  const cx = w / 2;
  const cy = h / 2 - 4;
  const r = Math.min(w, h) * 0.36;

  if (total === 0) {
    ctx.fillStyle = dark ? "rgba(148, 163, 184, 0.5)" : "rgba(100, 116, 139, 0.7)";
    ctx.font = "11px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("No trades", cx, cy);
    return;
  }

  const segments: { pct: number; color: string }[] = [];
  if (wins > 0) segments.push({ pct: winPct, color: dark ? "rgba(52, 211, 153, 0.85)" : "rgba(16, 185, 129, 0.85)" });
  if (losses > 0) segments.push({ pct: lossPct, color: dark ? "rgba(251, 113, 133, 0.85)" : "rgba(244, 63, 94, 0.85)" });
  if (breakeven > 0) {
    segments.push({
      pct: breakevenPct,
      color: dark ? "rgba(148, 163, 184, 0.75)" : "rgba(148, 163, 184, 0.85)",
    });
  }

  let start = -Math.PI / 2;
  for (const seg of segments) {
    const sweep = (seg.pct / 100) * Math.PI * 2;
    if (sweep <= 0) continue;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, start, start + sweep);
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();
    start += sweep;
  }

  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.52, 0, Math.PI * 2);
  ctx.fillStyle = dark ? "rgb(2, 6, 23)" : "rgb(255, 255, 255)";
  ctx.fill();

  ctx.fillStyle = dark ? "rgb(226, 232, 240)" : "rgb(15, 23, 42)";
  ctx.font = "600 13px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(String(total), cx, cy + 1);
  ctx.font = "10px system-ui";
  ctx.fillStyle = dark ? "rgba(148, 163, 184, 0.9)" : "rgba(100, 116, 139, 0.9)";
  ctx.fillText("trades", cx, cy + 14);
}

function SessionPieCard({
  breakdown,
  dark,
}: {
  breakdown: SessionTradeBreakdown;
  dark: boolean;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    drawPie(ref.current, breakdown, dark);
  }, [breakdown, dark]);

  const { session, total, wins, losses, breakeven, winPct, lossPct, netPnlUsdt } = breakdown;
  const pnlTone =
    netPnlUsdt > 0 ? "text-emerald-600 dark:text-emerald-400" : netPnlUsdt < 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-500";

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-2 dark:border-slate-700 dark:bg-slate-900/40">
      <div className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">{session.label}</div>
      <div className="text-[10px] text-slate-500">{session.subtitle}</div>
      <canvas ref={ref} className="mx-auto mt-1 h-[120px] w-full max-w-[160px]" />
      {total > 0 ? (
        <div className="mt-1 space-y-0.5 text-[10px]">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
              Wins
            </span>
            <span className="font-mono tabular-nums">
              {wins} ({winPct.toFixed(0)}%)
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-rose-700 dark:text-rose-400">
              <span className="inline-block h-2 w-2 rounded-full bg-rose-500" />
              Losses
            </span>
            <span className="font-mono tabular-nums">
              {losses} ({lossPct.toFixed(0)}%)
            </span>
          </div>
          {breakeven > 0 ? (
            <div className="flex items-center justify-between gap-2 text-slate-500">
              <span className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-full bg-slate-400" />
                Flat
              </span>
              <span className="font-mono tabular-nums">{breakeven}</span>
            </div>
          ) : null}
          <div className={`flex items-center justify-between gap-2 border-t border-slate-200 pt-1 font-mono tabular-nums dark:border-slate-700 ${pnlTone}`}>
            <span className="text-slate-500">Net PnL</span>
            <span>
              {netPnlUsdt >= 0 ? "+" : ""}
              {netPnlUsdt.toFixed(2)} USDT
            </span>
          </div>
        </div>
      ) : (
        <p className="mt-1 text-center text-[10px] text-slate-500">No entries in this window</p>
      )}
    </div>
  );
}

function useDocDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const el = document.documentElement;
    const sync = () => setDark(el.classList.contains("dark"));
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

export function BacktestSessionPieCharts({ run }: Props) {
  const dark = useDocDark();
  const [trades, setTrades] = useState<BacktestTrade[] | null>(null);
  const [loading, setLoading] = useState(false);

  const runReady = run?.status === "done";

  useEffect(() => {
    if (!run?.id || !runReady) {
      setTrades(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const tr = await api.getBacktestTrades(run.id, { limit: 5000 });
        if (cancelled) return;
        setTrades((tr?.trades ?? []) as BacktestTrade[]);
      } catch {
        if (!cancelled) setTrades([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [run?.id, runReady]);

  const breakdowns = useMemo(
    () => (trades ? breakdownTradesBySession(trades) : null),
    [trades],
  );

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-950/60">
      <div className="text-sm font-semibold">Session breakdown</div>
      <p className="mt-0.5 text-[10px] leading-snug text-slate-500">
        Win vs loss share by entry time (UTC). A trade can appear in overlapping sessions (e.g. London/NY overlap).
      </p>

      {!run ? (
        <p className="mt-3 text-center text-xs text-slate-500">Select a completed backtest to see session pies.</p>
      ) : !runReady ? (
        <p className="mt-3 text-center text-xs text-slate-500">
          Available when the run finishes ({run.status}).
        </p>
      ) : loading || breakdowns == null ? (
        <p className="mt-3 text-center text-xs text-slate-500">Loading trades…</p>
      ) : trades!.length === 0 ? (
        <p className="mt-3 text-center text-xs text-slate-500">No trades in this run.</p>
      ) : (
        <>
          <div className="mt-2 truncate text-[10px] text-slate-500" title={run.label ?? undefined}>
            {run.label || run.symbol} · {run.timeframe} · {trades!.length} trade legs
          </div>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {breakdowns.map((b) => (
              <SessionPieCard key={b.session.id} breakdown={b} dark={dark} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
