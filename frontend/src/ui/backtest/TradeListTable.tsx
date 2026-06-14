/**
 * Trade list for backtest results.
 * - compact: #, Side, entry/exit price, Net, Reason (below trade chart)
 * - detailed: full columns for the Trades tab
 */
import { computeTradePriceRr, formatTradeRr } from "../../lib/backtestTradeRr";
import type { BacktestTrade } from "../../types/backtest";

type Props = {
  trades: BacktestTrade[];
  /** From run config; used to estimate margin on legacy runs missing `marginUsdt`. */
  futuresLeverage?: number;
  variant?: "compact" | "detailed";
  selectedTradeNumber?: number | null;
  onSelectTrade?: (trade: BacktestTrade | null) => void;
};

function marginForTrade(t: BacktestTrade, lev: number): number | null {
  if (t.marginUsdt != null && Number.isFinite(t.marginUsdt)) return t.marginUsdt;
  const ep = Number(t.entryPrice);
  const qty = Number(t.qty);
  if (!Number.isFinite(ep) || !Number.isFinite(qty) || ep <= 0 || qty <= 0) return null;
  const notional = Math.abs(qty) * ep;
  return lev > 0 ? notional / lev : notional;
}

function fmtPrice(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v >= 1000 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toFixed(6);
}

export function TradeListTable({
  trades,
  futuresLeverage = 5,
  variant = "compact",
  selectedTradeNumber = null,
  onSelectTrade,
}: Props) {
  if (!trades.length) return <div className="py-8 text-center text-sm text-slate-500">No trades.</div>;

  const lev = Math.max(1, Number(futuresLeverage) || 5);
  const showCoinCol = trades.some((t) => t.symbol != null && String(t.symbol).trim() !== "");

  if (variant === "compact") {
    return (
      <div className="max-h-[50vh] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-500 dark:bg-slate-900">
            <tr>
              <th className="px-2 py-1.5">#</th>
              {showCoinCol ? <th className="px-2 py-1.5">Coin</th> : null}
              <th className="px-2 py-1.5">Side</th>
              <th className="px-2 py-1.5">Entry (UTC)</th>
              <th className="px-2 py-1.5">Entry (price)</th>
              <th className="px-2 py-1.5">Exit (price)</th>
              <th className="px-2 py-1.5 text-right">Net</th>
              <th className="px-2 py-1.5 text-right" title="Reward ÷ risk (entry → exit vs entry → initial SL)">
                RR
              </th>
              <th className="px-2 py-1.5">Reason</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => {
              const sign = t.netPnl >= 0 ? "text-emerald-600" : "text-rose-600";
              const rr = computeTradePriceRr(t);
              const selected = selectedTradeNumber === t.tradeNumber;
              return (
                <tr
                  key={t.tradeNumber}
                  className={`border-t border-slate-100 dark:border-slate-800 ${
                    onSelectTrade ? "cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900/60" : ""
                  } ${selected ? "bg-sky-50 dark:bg-sky-950/40" : ""}`}
                  onClick={() => onSelectTrade?.(selected ? null : t)}
                >
                  <td className="px-2 py-1 font-mono">{t.tradeNumber}</td>
                  {showCoinCol ? (
                    <td className="px-2 py-1 font-mono text-[10px] font-semibold text-sky-700 dark:text-sky-300">
                      {t.symbol?.replace("USDT", "") ?? "—"}
                    </td>
                  ) : null}
                  <td
                    className={`px-2 py-1 font-semibold ${t.direction === "BUY" ? "text-emerald-600" : "text-rose-600"}`}
                  >
                    {t.direction}
                  </td>
                  <td className="px-2 py-1 font-mono text-[10px] text-slate-600 dark:text-slate-400">
                    {fmtTsShort(t.entryTs)}
                  </td>
                  <td className="px-2 py-1 font-mono" title={fmtTs(t.entryTs)}>
                    {fmtPrice(t.entryPrice)}
                  </td>
                  <td className="px-2 py-1 font-mono" title={fmtTs(t.exitTs)}>
                    {fmtPrice(t.exitPrice)}
                  </td>
                  <td className={`px-2 py-1 text-right font-mono font-semibold ${sign}`}>{t.netPnl.toFixed(2)}</td>
                  <td className={`px-2 py-1 text-right font-mono ${rrClass(rr)}`}>{formatTradeRr(rr)}</td>
                  <td className="px-2 py-1 text-[11px]">{t.exitReason ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="max-h-[60vh] overflow-y-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-500 dark:bg-slate-900">
          <tr>
            <th className="px-2 py-1.5">#</th>
            {showCoinCol ? <th className="px-2 py-1.5">Coin</th> : null}
            <th className="px-2 py-1.5">Side</th>
            <th className="px-2 py-1.5">Entry</th>
            <th className="px-2 py-1.5">Exit (UTC)</th>
            <th className="px-2 py-1.5">Bars</th>
            <th className="px-2 py-1.5" title="Initial margin at entry (notional ÷ leverage)">
              Margin
            </th>
            <th className="px-2 py-1.5" title="Wallet equity used to size this trade (compounds with PnL)">
              Equity
            </th>
            <th className="px-2 py-1.5">Gross</th>
            <th className="px-2 py-1.5">Funding</th>
            <th className="px-2 py-1.5">Net</th>
            <th className="px-2 py-1.5 text-right" title="Reward ÷ risk (entry → exit vs entry → initial SL)">
              RR
            </th>
            <th className="px-2 py-1.5">MAE %</th>
            <th className="px-2 py-1.5">MFE %</th>
            <th className="px-2 py-1.5">Reason</th>
            <th className="px-2 py-1.5">Trail tier</th>
            <th className="px-2 py-1.5">Gate</th>
            <th className="px-2 py-1.5" title="Structural risk at entry (TREND_HTF_ST)">
              Structure
            </th>
            <th className="px-2 py-1.5">Pattern</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => {
            const sign = t.netPnl >= 0 ? "text-emerald-600" : "text-rose-600";
            const margin = marginForTrade(t, lev);
            const rr = computeTradePriceRr(t);
            const eq = t.entryQuality;
            const selected = selectedTradeNumber === t.tradeNumber;
            return (
              <tr
                key={t.tradeNumber}
                className={`border-t border-slate-100 dark:border-slate-800 ${
                  onSelectTrade ? "cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900/60" : ""
                } ${selected ? "bg-sky-50 dark:bg-sky-950/40" : ""}`}
                onClick={() => onSelectTrade?.(selected ? null : t)}
              >
                <td className="px-2 py-1 font-mono">{t.tradeNumber}</td>
                {showCoinCol ? (
                  <td className="px-2 py-1 font-mono text-[10px] font-semibold text-sky-700 dark:text-sky-300">
                    {t.symbol?.replace("USDT", "") ?? "—"}
                  </td>
                ) : null}
                <td className={`px-2 py-1 font-semibold ${t.direction === "BUY" ? "text-emerald-600" : "text-rose-600"}`}>
                  {t.direction}
                </td>
                <td className="px-2 py-1 font-mono text-[11px]">{fmtTs(t.entryTs)}</td>
                <td className="px-2 py-1 font-mono text-[11px]">{fmtTs(t.exitTs)}</td>
                <td className="px-2 py-1 text-right">{t.barsHeld}</td>
                <td className="px-2 py-1 text-right font-mono text-slate-700 dark:text-slate-300">
                  {margin != null ? margin.toFixed(2) : "—"}
                </td>
                <td className="px-2 py-1 text-right font-mono text-slate-600 dark:text-slate-400">
                  {t.equityAtEntry != null ? t.equityAtEntry.toFixed(2) : "—"}
                </td>
                <td className="px-2 py-1 text-right font-mono">{t.grossPnl.toFixed(2)}</td>
                <td className="px-2 py-1 text-right font-mono text-slate-500">{t.fundingPaid.toFixed(2)}</td>
                <td className={`px-2 py-1 text-right font-mono font-semibold ${sign}`}>{t.netPnl.toFixed(2)}</td>
                <td className={`px-2 py-1 text-right font-mono ${rrClass(rr)}`}>{formatTradeRr(rr)}</td>
                <td className="px-2 py-1 text-right font-mono">{t.maePct != null ? t.maePct.toFixed(1) : "—"}</td>
                <td className="px-2 py-1 text-right font-mono">{t.mfePct != null ? t.mfePct.toFixed(1) : "—"}</td>
                <td className="px-2 py-1 text-[11px]">{t.exitReason ?? "—"}</td>
                <td className="px-2 py-1 text-[11px] font-mono">
                  {t.trailTierLabel != null ? (
                    <span className="rounded bg-sky-100 px-1 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
                      {t.trailTierLabel}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-2 py-1 text-[11px]">{t.gateAction ?? "—"}</td>
                <td className="px-2 py-1 text-[11px]">
                  {eq ? (
                    <span
                      className={`rounded px-1 font-mono text-[10px] ${structureClass(eq.structuralRisk)}`}
                      title={eq.flags?.join(", ") ?? ""}
                    >
                      {eq.structuralRisk}
                      {eq.wouldBlock ? " ⛔" : ""}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-2 py-1 font-mono text-[10px]">
                  {t.lossPattern && t.netPnl < 0 ? t.lossPattern : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function rrClass(rr: number | null): string {
  if (rr == null || !Number.isFinite(rr)) return "text-slate-400";
  if (rr > 0) return "text-emerald-600 dark:text-emerald-400";
  if (rr < 0) return "text-rose-600 dark:text-rose-400";
  return "text-slate-500";
}

function structureClass(risk: string): string {
  if (risk === "CHOP_ZONE") return "bg-amber-200 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200";
  if (risk === "TREND_OK") return "bg-emerald-200 text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-200";
  return "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
}

function fmtTs(s: string) {
  try {
    const d = new Date(s);
    return d.toLocaleString("en-GB", {
      timeZone: "UTC",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return s;
  }
}

/** Compact trade list — UTC so entries are not mistaken for same-bar pairs. */
function fmtTsShort(s: string) {
  try {
    const d = new Date(s);
    return d.toLocaleString("en-GB", {
      timeZone: "UTC",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return s;
  }
}
