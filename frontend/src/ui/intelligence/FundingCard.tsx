import { LayerCard } from "./LayerCard";
import type { FundingData } from "../../types/intelligence";

interface Props {
  data:   FundingData | null;
  symbol: string;
}

function fmtRate(r: number) {
  return `${(r * 100).toFixed(4)}%`;
}

function timeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return "Soon";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function FundingCard({ data }: Props) {
  if (!data) return <LayerCard title="Funding Rate" status="loading" />;

  const isExtreme = Math.abs(data.zscore) > 2;
  const rateColor = isExtreme
    ? data.zscore > 0 ? "#dc2626" : "#16a34a"
    : "#94a3b8";
  const barPct  = Math.min(100, Math.max(0, ((data.zscore + 3) / 6) * 100));
  const barColor = data.zscore >= 0 ? "#dc2626" : "#16a34a";

  return (
    <LayerCard title="Funding Rate">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-2xl font-bold tabular-nums" style={{ color: rateColor }}>
          {fmtRate(data.current)}
        </span>
        <span className="text-xs text-slate-500">current</span>
      </div>

      {/* Z-score bar */}
      <div className="mb-2">
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
          <div
            className="absolute top-0 h-full rounded-full transition-all duration-700"
            style={{ left: `${Math.min(barPct, 50)}%`, width: `${Math.abs(barPct - 50)}%`, backgroundColor: barColor }}
          />
        </div>
        <div className="mt-0.5 flex justify-between text-[9px] text-slate-600">
          <span>−3σ</span>
          <span className="text-slate-400">{data.zscore.toFixed(2)}σ</span>
          <span>+3σ</span>
        </div>
      </div>

      <div className="space-y-1 text-xs">
        <div className="flex justify-between">
          <span className="text-slate-500">30d avg</span>
          <span className="text-slate-300">{fmtRate(data.avg30d)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Next funding</span>
          <span className="text-slate-300">{data.nextTime ? timeUntil(String(data.nextTime)) : "—"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Predicted</span>
          <span className="text-slate-300">{fmtRate(data.predicted)}</span>
        </div>
      </div>

      {isExtreme && (
        <p className={`mt-2 rounded px-2 py-1 text-[11px] ${data.zscore > 2 ? "bg-red-950/50 text-red-300" : "bg-emerald-950/50 text-emerald-300"}`}>
          {data.zscore > 2
            ? "Crowded longs — historically precedes price drop"
            : "Crowded shorts — squeeze risk elevated"}
        </p>
      )}
    </LayerCard>
  );
}
