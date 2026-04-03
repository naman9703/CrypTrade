import { useMemo } from "react";
import { useAppStore } from "../ws/store";

function fmt(n: number, dp = 2) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return x.toFixed(dp);
}

export function OrderBookPanel() {
  const depth = useAppStore((s) => s.depth);
  const symbol = depth?.symbol;

  const rows = useMemo(() => {
    const bids = (depth?.bids || []).slice(0, 12);
    const asks = (depth?.asks || []).slice(0, 12);
    const maxBidQty = Math.max(1e-9, ...bids.map((b) => Number(b[1] || 0)));
    const maxAskQty = Math.max(1e-9, ...asks.map((a) => Number(a[1] || 0)));
    return { bids, asks, maxBidQty, maxAskQty };
  }, [depth]);

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <div className="text-xs font-semibold text-slate-200">Order book</div>
        <div className="text-[11px] text-slate-500">{symbol ?? "—"}</div>
      </div>

      <div className="grid grid-cols-2 gap-2 p-3 text-xs">
        <div>
          <div className="mb-1 text-[11px] font-semibold text-slate-400">Bids</div>
          <div className="grid gap-1">
            {rows.bids.length === 0 ? (
              <div className="text-[11px] text-slate-500">Waiting for depth…</div>
            ) : (
              rows.bids.map(([p, q]) => (
                <div key={`b-${p}`} className="relative overflow-hidden rounded-md border border-slate-900 bg-slate-950 px-2 py-1">
                  <div
                    className="pointer-events-none absolute inset-y-0 left-0 bg-emerald-500/10"
                    style={{ width: `${Math.min(100, (Number(q) / rows.maxBidQty) * 100)}%` }}
                  />
                  <div className="relative flex items-center justify-between">
                    <div className="font-semibold text-emerald-300">{fmt(p, 2)}</div>
                    <div className="text-slate-300">{fmt(q, 6)}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div>
          <div className="mb-1 text-[11px] font-semibold text-slate-400">Asks</div>
          <div className="grid gap-1">
            {rows.asks.length === 0 ? (
              <div className="text-[11px] text-slate-500">Waiting for depth…</div>
            ) : (
              rows.asks.map(([p, q]) => (
                <div key={`a-${p}`} className="relative overflow-hidden rounded-md border border-slate-900 bg-slate-950 px-2 py-1">
                  <div
                    className="pointer-events-none absolute inset-y-0 left-0 bg-rose-500/10"
                    style={{ width: `${Math.min(100, (Number(q) / rows.maxAskQty) * 100)}%` }}
                  />
                  <div className="relative flex items-center justify-between">
                    <div className="font-semibold text-rose-300">{fmt(p, 2)}</div>
                    <div className="text-slate-300">{fmt(q, 6)}</div>
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

