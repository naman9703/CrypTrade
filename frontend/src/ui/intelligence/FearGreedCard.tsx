import { LayerCard } from "./LayerCard";
import type { FearGreedData } from "../../types/intelligence";

interface Props {
  data: FearGreedData | null;
}

function fgColor(v: number): string {
  if (v <= 24) return "#dc2626";
  if (v <= 44) return "#ea580c";
  if (v <= 55) return "#64748b";
  if (v <= 74) return "#65a30d";
  return "#16a34a";
}

const ZONES = ["Ext Fear", "Fear", "Neutral", "Greed", "Ext Greed"];

export function FearGreedCard({ data }: Props) {
  if (!data) return <LayerCard title="Fear & Greed" status="loading" />;

  const color = fgColor(data.value);
  const pct   = data.value;

  return (
    <LayerCard title="Fear & Greed">
      <div className="flex items-end gap-3">
        <span className="text-4xl font-bold tabular-nums leading-none" style={{ color }}>{data.value}</span>
        <div className="pb-0.5">
          <p className="text-xs text-slate-400">{data.label}</p>
          <span className={`text-xs font-semibold ${data.change24h >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {data.change24h >= 0 ? "↑" : "↓"} {Math.abs(data.change24h)} (24h)
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <div className="mt-1 flex justify-between">
        {ZONES.map((z) => (
          <span key={z} className="text-[9px] text-slate-600">{z}</span>
        ))}
      </div>
    </LayerCard>
  );
}
