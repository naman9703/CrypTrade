/**
 * SMC/ICT setup checklist for a selected backtest trade — shows which gates/techniques fired.
 */
import type { BacktestTrade } from "../../types/backtest";
import type { BacktestLiqContext } from "./backtestChartOverlays";
import { activeBracketPrice } from "./backtestChartTime";
import type { SmcChartMarkup } from "./smcChartMarkup";

const TECH_LABELS: Record<string, string> = {
  smc_ict: "SMC/ICT gate",
  liq_sweep: "Liquidity sweep",
  smc_choch: "CHoCH",
  smc_mss: "MSS (displacement)",
  smc_bos: "BOS",
  smc_fvg: "FVG retrace",
  smc_ob: "Order block",
  smc_retrace: "FVG/OB retrace",
  pdh: "Prev day high",
  pdl: "Prev day low",
  pwh: "Prev week high",
  pwl: "Prev week low",
  session_high: "Session high",
  session_low: "Session low",
};

type Props = {
  trade: BacktestTrade;
  markup: SmcChartMarkup | null;
};

function fmtPrice(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v >= 100 ? v.toFixed(2) : v.toFixed(4);
}

export function SmcTradeSetupPanel({ trade, markup }: Props) {
  const liq = (trade.liqContext ?? null) as BacktestLiqContext | null;
  const meta = liq?.smcMeta ?? null;
  const techniques = liq?.techniques ?? [];
  const levelType = String(meta?.levelType ?? liq?.levelType ?? markup?.sweep.levelType ?? "—");

  const checklist = [
    { key: "sweep", label: "Liquidity sweep + reclaim", on: markup != null && markup.sweep.level > 0 },
    { key: "choch", label: "CHoCH", on: techniques.includes("smc_choch") || markup?.events.some((e) => e.kind === "choch") },
    { key: "mss", label: "MSS / BOS", on: techniques.some((t) => t === "smc_mss" || t === "smc_bos") || markup?.bos != null },
    { key: "fvg", label: "Fair value gap", on: techniques.includes("smc_fvg") || markup?.fvg != null },
    { key: "ob", label: "Order block", on: techniques.includes("smc_ob") || markup?.ob != null },
    { key: "retrace", label: "Retrace into zone", on: techniques.includes("smc_retrace") },
  ];

  return (
    <div className="border-b border-violet-200/60 bg-violet-50/50 px-3 py-2 dark:border-violet-900/40 dark:bg-violet-950/20">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[11px] font-semibold text-violet-900 dark:text-violet-200">
          Trade #{trade.tradeNumber} · SMC/ICT setup
        </span>
        {trade.entryReason ? (
          <span className="rounded bg-violet-200/60 px-1.5 py-0.5 font-mono text-[10px] text-violet-900 dark:bg-violet-900/50 dark:text-violet-100">
            {trade.entryReason}
          </span>
        ) : null}
        {meta?.killzone ? (
          <span className="text-[10px] text-slate-600 dark:text-slate-400">Kill-zone: {String(meta.killzone)}</span>
        ) : null}
        {meta?.ictProfile ? (
          <span className="text-[10px] text-slate-600 dark:text-slate-400">Profile: {String(meta.ictProfile)}</span>
        ) : null}
      </div>

      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {checklist.map((c) => (
          <span
            key={c.key}
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              c.on
                ? "bg-emerald-100 font-medium text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
                : "bg-slate-100 text-slate-400 line-through dark:bg-slate-900 dark:text-slate-600"
            }`}
          >
            {c.label}
          </span>
        ))}
      </div>

      <div className="mt-2 grid gap-1 text-[10px] text-slate-600 dark:text-slate-400 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <span className="font-semibold text-pink-600 dark:text-pink-400">Sweep</span> {levelType} @ {fmtPrice(markup?.sweep.level ?? liq?.level)}
          {markup?.sweep.wick ? ` · wick ${fmtPrice(markup.sweep.wick)}` : ""}
        </div>
        <div>
          <span className="font-semibold text-purple-600 dark:text-purple-400">Target pool</span>{" "}
          {fmtPrice(liq?.opposingLevel)}
        </div>
        <div>
          <span className="font-semibold text-sky-600 dark:text-sky-400">Entry</span> {fmtPrice(trade.entryPrice)}
          {activeBracketPrice(trade.slPrice) != null ? ` · SL ${fmtPrice(activeBracketPrice(trade.slPrice)!)}` : ""}
          {activeBracketPrice(trade.tpPrice) != null ? ` · TP ${fmtPrice(activeBracketPrice(trade.tpPrice)!)}` : ""}
          {activeBracketPrice(liq?.tp1Price) != null ? ` · TP1 ${fmtPrice(activeBracketPrice(liq?.tp1Price)!)}` : ""}
        </div>
        {techniques.length > 0 && (
          <div className="sm:col-span-2 lg:col-span-3">
            <span className="font-semibold text-slate-500">Techniques:</span>{" "}
            {techniques.map((t) => TECH_LABELS[t] ?? t).join(" · ")}
          </div>
        )}
      </div>
    </div>
  );
}
