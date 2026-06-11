/**
 * LIQ + S/R setup explanation for a selected backtest trade — the checklist of which
 * confluences fired + a plain-English, step-by-step "why this trade was placed".
 * Rendered below the chart so each result can be studied on its own.
 */
import type { BacktestTrade } from "../../types/backtest";
import type { BacktestLiqContext } from "./backtestChartOverlays";
import type { SmcChartMarkup } from "./smcChartMarkup";

const TECH_LABELS: Record<string, string> = {
  sr_htf_zone: "HTF S/R zone",
  liq_sweep: "Liquidity sweep",
  sr_bos: "BOS (structure shift)",
  sr_confirm: "Confirmation candle",
  vol: "Volume expansion",
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

function fmt(n: number | null | undefined, d?: number): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  const digits = d ?? (v >= 100 ? 2 : 4);
  return v.toFixed(digits);
}

/** Plain-English justification of why the trade was placed + how it resolved. */
function buildExplanation(trade: BacktestTrade, liq: BacktestLiqContext | null): string[] {
  const side = trade.direction === "SELL" ? "SELL" : "BUY";
  const dir = side === "BUY" ? "LONG" : "SHORT";
  const lt = String(liq?.levelType ?? "level").toUpperCase();
  const isSupport = side === "BUY";
  const level = Number(liq?.level ?? 0);
  const wick = Number(liq?.sweepWick ?? 0);
  const opposing = Number(liq?.opposingLevel ?? 0);
  const tp1 = Number(liq?.tp1Price ?? 0);
  const rr = Number(liq?.rr ?? 0);
  const tech = (liq?.techniques ?? []) as string[];
  const has = (t: string) => tech.includes(t);
  const ext =
    level > 0 && wick > 0 ? ((side === "BUY" ? level - wick : wick - level) / level) * 100 : null;
  const entry = Number(trade.entryPrice);
  const sl = trade.slPrice;
  const risk = entry > 0 && sl != null ? (Math.abs(entry - sl) / entry) * 100 : null;
  const won = (trade.netPnl ?? 0) > 0;
  const acctPct =
    trade.equityAtEntry && trade.equityAtEntry > 0 ? (trade.netPnl / trade.equityAtEntry) * 100 : null;

  const steps: string[] = [];
  steps.push(
    `S/R context (direction driver) — price reached an HTF ${isSupport ? "SUPPORT" : "RESISTANCE"} zone at ${lt} ${fmt(level)}. The strategy fades sweeps at zones: ${isSupport ? "longs are taken at support" : "shorts are taken at resistance"}, which set this ${dir}.`,
  );
  steps.push(
    `Liquidity sweep — price wicked ${isSupport ? "below" : "above"} ${lt} ${fmt(level)} to ${fmt(wick)}${ext != null ? ` (${ext.toFixed(2)}% beyond)` : ""}, grabbing ${isSupport ? "sell-side stops below" : "buy-side stops above"}, then CLOSED back through the level → the breakout failed (stop-hunt).`,
  );
  if (has("sr_bos")) {
    steps.push(
      `Structure shift (BOS) — after the reclaim, market structure broke ${isSupport ? "up" : "down"}, confirming control flipped to ${isSupport ? "buyers" : "sellers"}.`,
    );
  }
  if (has("sr_confirm")) {
    steps.push(`Confirmation candle — a ${isSupport ? "bullish" : "bearish"} confirmation close validated the reversal before entry.`);
  }
  if (has("vol")) {
    steps.push(`Volume — the sweep/confirmation printed on expanding volume (the volume gate passed), i.e. real participation rather than a thin wick.`);
  }
  steps.push(
    `Entry & risk — entered ${dir} at ${fmt(entry)}; stop just ${isSupport ? "below" : "above"} the sweep wick at ${fmt(sl)}${risk != null ? ` (risk ≈ ${risk.toFixed(2)}% of price)` : ""}.${tp1 > 0 ? ` TP1 at 1R (${fmt(tp1)}, partial + stop→breakeven);` : ""} final TP at the opposing pool ${fmt(opposing)} → ${fmt(trade.tpPrice)}${rr > 0 ? ` (setup R:R ${rr.toFixed(2)}, R-capped)` : ""}.`,
  );
  steps.push(
    `Outcome — ${won ? "WIN" : "LOSS"}: exited at ${fmt(trade.exitPrice)} via ${trade.exitReason ?? "—"} after ${trade.barsHeld} bars for ${won ? "+" : ""}$${fmt(trade.netPnl, 2)}${acctPct != null ? ` (${acctPct.toFixed(2)}% of account)` : ""}.`,
  );
  return steps;
}

export function LiquidityTradeSetupPanel({ trade, markup }: Props) {
  const liq = (trade.liqContext ?? null) as BacktestLiqContext | null;
  const techniques = (liq?.techniques ?? []) as string[];
  const levelType = String(liq?.levelType ?? markup?.sweep.levelType ?? "—").toUpperCase();
  const side = trade.direction === "SELL" ? "SELL" : "BUY";
  const isSupport = side === "BUY";
  const won = (trade.netPnl ?? 0) > 0;

  const checklist = [
    { key: "sr_htf_zone", label: "HTF S/R zone", on: techniques.includes("sr_htf_zone") },
    { key: "liq_sweep", label: "Liquidity sweep + reclaim", on: markup != null && markup.sweep.level > 0 },
    { key: "sr_bos", label: "BOS / structure shift", on: techniques.includes("sr_bos") },
    { key: "sr_confirm", label: "Confirmation candle", on: techniques.includes("sr_confirm") },
    { key: "vol", label: "Volume expansion", on: techniques.includes("vol") },
  ];

  const steps = buildExplanation(trade, liq);

  return (
    <div className="border-t border-teal-200/60 bg-teal-50/40 px-3 py-2.5 dark:border-teal-900/40 dark:bg-teal-950/20">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[11px] font-semibold text-teal-900 dark:text-teal-200">
          Trade #{trade.tradeNumber} · {side} {levelType} sweep · LIQ + S/R setup
        </span>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
            won
              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
              : "bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300"
          }`}
        >
          {won ? "WIN" : "LOSS"} {trade.netPnl >= 0 ? "+" : ""}
          {fmt(trade.netPnl, 2)}
        </span>
        {trade.entryReason ? (
          <span className="rounded bg-teal-200/60 px-1.5 py-0.5 font-mono text-[10px] text-teal-900 dark:bg-teal-900/50 dark:text-teal-100">
            {trade.entryReason}
          </span>
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

      <div className="mt-2 grid gap-1 text-[10px] text-slate-600 dark:text-slate-400 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <span className={`font-semibold ${isSupport ? "text-teal-600 dark:text-teal-400" : "text-orange-600 dark:text-orange-400"}`}>
            {isSupport ? "Support" : "Resistance"}
          </span>{" "}
          {levelType} @ {fmt(liq?.level)}
        </div>
        <div>
          <span className="font-semibold text-rose-600 dark:text-rose-400">Sweep wick</span> {fmt(liq?.sweepWick)}
        </div>
        <div>
          <span className="font-semibold text-purple-600 dark:text-purple-400">Target pool</span> {fmt(liq?.opposingLevel)}
        </div>
        <div>
          <span className="font-semibold text-sky-600 dark:text-sky-400">Entry</span> {fmt(trade.entryPrice)}
          {trade.slPrice != null ? ` · SL ${fmt(trade.slPrice)}` : ""}
          {liq?.tp1Price != null ? ` · TP1 ${fmt(liq.tp1Price)}` : ""}
          {trade.tpPrice != null ? ` · TP ${fmt(trade.tpPrice)}` : ""}
        </div>
        {techniques.length > 0 && (
          <div className="sm:col-span-2 lg:col-span-4">
            <span className="font-semibold text-slate-500">Techniques:</span>{" "}
            {techniques.map((t) => TECH_LABELS[t] ?? t).join(" · ")}
          </div>
        )}
      </div>

      <div className="mt-2.5">
        <p className="mb-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200">Why this trade was placed</p>
        <ol className="ml-4 list-decimal space-y-1 text-[11px] leading-relaxed text-slate-700 dark:text-slate-300">
          {steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}
