import { useMemo } from "react";
import { normalizeSym } from "../lib/symbolPriceSanity";
import { useAppStore } from "../ws/store";

function fmt(n: number, dp = 2) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return x.toFixed(dp);
}

function priceDp(p: number) {
  const x = Math.abs(Number(p));
  if (!Number.isFinite(x)) return 2;
  if (x < 0.01) return 6;
  if (x < 1) return 5;
  if (x < 100) return 4;
  return 2;
}

export function OrderBookPanel() {
  const depth = useAppStore((s) => s.depth);
  const chartDisplaySymbol = useAppStore((s) => s.chartDisplaySymbol);
  const botSymbol = useAppStore((s) => s.bot?.symbol);
  /** Match chart: multi-coin tab uses `chartDisplaySymbol`; `market.symbol` can lag one tick vs depth after focus changes. */
  const chartSymbolForBook = useMemo(() => {
    const d = chartDisplaySymbol ? String(chartDisplaySymbol).trim() : "";
    const b = String(botSymbol ?? "").trim();
    return d || b || "";
  }, [chartDisplaySymbol, botSymbol]);
  const symbol = depth?.symbol;
  const depthMismatch = Boolean(
    chartSymbolForBook &&
      symbol &&
      normalizeSym(chartSymbolForBook) !== normalizeSym(symbol),
  );

  const rows = useMemo(() => {
    const bids = (depth?.bids || []).slice(0, 12);
    const asks = (depth?.asks || []).slice(0, 12);
    const maxBidQty = Math.max(1e-9, ...bids.map((b) => Number(b[1] || 0)));
    const maxAskQty = Math.max(1e-9, ...asks.map((a) => Number(a[1] || 0)));
    return { bids, asks, maxBidQty, maxAskQty };
  }, [depth]);

  const showRows = !depthMismatch && rows.bids.length + rows.asks.length > 0;

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40">
      <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 px-3 py-2">
        <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">Order book</div>
        <div className="text-[11px] text-slate-600 dark:text-slate-500">
          {symbol ?? (chartSymbolForBook || "—")}
        </div>
      </div>
      {depthMismatch ? (
        <div className="px-3 py-2 text-[11px] text-amber-200/90">
          Depth catching up ({symbol ?? "—"} book vs chart {chartSymbolForBook})…
        </div>
      ) : !showRows && chartSymbolForBook && normalizeSym(symbol ?? "") === normalizeSym(chartSymbolForBook) ? (
        <div className="px-3 py-2 text-[11px] text-slate-600 dark:text-slate-500">Loading {chartSymbolForBook} depth…</div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 p-3 text-xs">
        <div>
          <div className="mb-1 text-[11px] font-semibold text-slate-600 dark:text-slate-400">Bids</div>
          <div className="grid gap-1">
            {!showRows ? (
              <div className="text-[11px] text-slate-600 dark:text-slate-500">
                {depthMismatch ? "—" : "Waiting for depth…"}
              </div>
            ) : (
              rows.bids.map(([p, q]) => (
                <div key={`b-${p}`} className="relative overflow-hidden rounded-md border border-slate-200 dark:border-slate-900 bg-slate-50 dark:bg-slate-950 px-2 py-1">
                  <div
                    className="pointer-events-none absolute inset-y-0 left-0 bg-emerald-500/10"
                    style={{ width: `${Math.min(100, (Number(q) / rows.maxBidQty) * 100)}%` }}
                  />
                  <div className="relative flex items-center justify-between">
                    <div className="font-semibold text-emerald-300">{fmt(p, priceDp(Number(p)))}</div>
                    <div className="text-slate-700 dark:text-slate-300">{fmt(q, 6)}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div>
          <div className="mb-1 text-[11px] font-semibold text-slate-600 dark:text-slate-400">Asks</div>
          <div className="grid gap-1">
            {!showRows ? (
              <div className="text-[11px] text-slate-600 dark:text-slate-500">
                {depthMismatch ? "—" : "Waiting for depth…"}
              </div>
            ) : (
              rows.asks.map(([p, q]) => (
                <div key={`a-${p}`} className="relative overflow-hidden rounded-md border border-slate-200 dark:border-slate-900 bg-slate-50 dark:bg-slate-950 px-2 py-1">
                  <div
                    className="pointer-events-none absolute inset-y-0 left-0 bg-rose-500/10"
                    style={{ width: `${Math.min(100, (Number(q) / rows.maxAskQty) * 100)}%` }}
                  />
                  <div className="relative flex items-center justify-between">
                    <div className="font-semibold text-rose-300">{fmt(p, priceDp(Number(p)))}</div>
                    <div className="text-slate-700 dark:text-slate-300">{fmt(q, 6)}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

