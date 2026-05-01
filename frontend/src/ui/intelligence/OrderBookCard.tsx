import { LayerCard } from "./LayerCard";
import type { OrderBookData } from "../../types/intelligence";

interface Props {
  data: OrderBookData | null;
}

function fmtB(v: number) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

export function OrderBookCard({ data }: Props) {
  if (!data) return <LayerCard title="Order Book Pressure" status="loading" />;

  const imb      = data.imbalanceRatio;
  const bidPct   = Math.min(100, Math.max(0, (1 + imb) * 50));
  const pColor   = imb > 0.05 ? "#16a34a" : imb < -0.05 ? "#dc2626" : "#64748b";
  const label    = imb > 0.1 ? "Strong bid support" : imb < -0.1 ? "Strong ask pressure" : "Balanced book";

  return (
    <LayerCard title="Order Book Pressure">
      {/* Imbalance bar */}
      <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Bid / Ask Imbalance</p>
      <div className="flex h-2 w-full overflow-hidden rounded-full">
        <div className="h-full bg-emerald-600/70 transition-all" style={{ width: `${bidPct}%` }} />
        <div className="h-full bg-red-600/70 transition-all"     style={{ width: `${100 - bidPct}%` }} />
      </div>
      <div className="mt-0.5 flex justify-between text-[10px]">
        <span className="text-emerald-400">Bids</span>
        <span style={{ color: pColor }}>{imb >= 0 ? "+" : ""}{(imb * 100).toFixed(1)}%</span>
        <span className="text-red-400">Asks</span>
      </div>

      <div className="mt-2.5 space-y-1.5 text-xs">
        <div className="flex justify-between">
          <span className="text-slate-500">Bid wall</span>
          <span className="text-emerald-400 font-semibold">{fmtB(data.bidWallUsdt)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Ask wall</span>
          <span className="text-red-400 font-semibold">{fmtB(data.askWallUsdt)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Pressure</span>
          <span style={{ color: pColor }} className="font-semibold">{data.pressure.replace(/_/g, " ")}</span>
        </div>
      </div>

      <p className="mt-2 text-[10px] italic text-slate-500">{label}</p>
    </LayerCard>
  );
}
