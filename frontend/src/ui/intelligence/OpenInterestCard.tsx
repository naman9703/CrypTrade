import { LayerCard } from "./LayerCard";
import type { OpenInterestData } from "../../types/intelligence";

interface Props {
  data: OpenInterestData | null;
}

function pctColor(v: number) {
  if (v > 5)  return "#16a34a";
  if (v > 0)  return "#65a30d";
  if (v > -5) return "#ea580c";
  return "#dc2626";
}

function fmtB(v: number) {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${v.toFixed(0)}`;
}

export function OpenInterestCard({ data }: Props) {
  if (!data) return <LayerCard title="Open Interest" status="loading" />;

  const lsColor  = data.longShortRatio > 1 ? "#16a34a" : "#dc2626";
  const longPct  = (data.longShortRatio / (data.longShortRatio + 1)) * 100;

  return (
    <LayerCard title="Open Interest">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-2xl font-bold tabular-nums text-slate-100">{fmtB(data.usdt)}</span>
      </div>

      {/* 4h / 24h change */}
      <div className="mb-2 grid grid-cols-2 gap-2">
        <div className="rounded bg-slate-800 p-1.5 text-center">
          <p className="text-[9px] uppercase text-slate-500">4h Δ</p>
          <p className="text-sm font-semibold" style={{ color: pctColor(data.change4hPct) }}>
            {data.change4hPct >= 0 ? "+" : ""}{data.change4hPct.toFixed(2)}%
          </p>
        </div>
        <div className="rounded bg-slate-800 p-1.5 text-center">
          <p className="text-[9px] uppercase text-slate-500">24h Δ</p>
          <p className="text-sm font-semibold" style={{ color: pctColor(data.change24hPct) }}>
            {data.change24hPct >= 0 ? "+" : ""}{data.change24hPct.toFixed(2)}%
          </p>
        </div>
      </div>

      {/* Long / Short bar */}
      <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Long / Short Ratio</p>
      <div className="flex h-2 w-full overflow-hidden rounded-full">
        <div className="h-full bg-emerald-600/70 transition-all" style={{ width: `${longPct}%` }} />
        <div className="h-full bg-red-600/70 transition-all"     style={{ width: `${100 - longPct}%` }} />
      </div>
      <div className="mt-0.5 flex justify-between text-[10px]">
        <span className="text-emerald-400">Longs</span>
        <span style={{ color: lsColor }}>{data.longShortRatio.toFixed(2)}×</span>
        <span className="text-red-400">Shorts</span>
      </div>
    </LayerCard>
  );
}
