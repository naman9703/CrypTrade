import { LayerCard } from "./LayerCard";
import type { OptionsData } from "../../types/intelligence";

interface Props {
  data:   OptionsData | null;
  symbol: string;
}

const BTC_ETH = ["BTCUSDT", "ETHUSDT"];

export function OptionsCard({ data, symbol }: Props) {
  if (!BTC_ETH.includes(symbol.toUpperCase())) {
    return (
      <LayerCard title="Options" status="unavailable" note="BTC/ETH only — options data not available for this symbol." />
    );
  }
  if (!data) return <LayerCard title="Options" status="loading" />;

  const distColor  = data.maxPainDistance < 0 ? "#dc2626" : "#16a34a";
  const pcColor    = data.putCallRatio > 0.7 ? "#dc2626" : data.putCallRatio < 0.4 ? "#16a34a" : "#94a3b8";
  const putPct     = Math.min(100, (data.putCallRatio / (data.putCallRatio + 1)) * 100);

  return (
    <LayerCard title="Options">
      {/* Max Pain */}
      <div className="mb-2">
        <p className="text-[10px] uppercase tracking-wide text-slate-500">Max Pain</p>
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-bold tabular-nums text-slate-100">
            ${data.maxPain.toLocaleString()}
          </span>
          <span className="text-xs font-semibold" style={{ color: distColor }}>
            {data.maxPainDistance >= 0 ? "+" : ""}{data.maxPainDistance.toFixed(1)}%
          </span>
        </div>
        <p className="text-[10px] text-slate-500">
          {data.maxPainDistance < 0 ? "Price above max pain — bearish magnet" : "Price below max pain — bullish magnet"}
        </p>
      </div>

      {/* Put/Call */}
      <div className="mb-2">
        <p className="text-[10px] uppercase tracking-wide text-slate-500">Put / Call Ratio</p>
        <div className="mt-1 flex h-2 w-full overflow-hidden rounded-full">
          <div className="h-full bg-red-600/70 transition-all" style={{ width: `${putPct}%` }} />
          <div className="h-full bg-emerald-600/70 transition-all" style={{ width: `${100 - putPct}%` }} />
        </div>
        <div className="mt-0.5 flex justify-between text-[10px]">
          <span className="text-red-400">Puts</span>
          <span style={{ color: pcColor }}>{data.putCallRatio.toFixed(2)}</span>
          <span className="text-emerald-400">Calls</span>
        </div>
      </div>

      <div className="space-y-1 text-xs">
        <div className="flex justify-between">
          <span className="text-slate-500">GEX Regime</span>
          <span className={data.gex > 0 ? "text-emerald-400" : "text-red-400"}>
            {data.gex > 0 ? "+" : "−"} {data.gexRegime.replace(/_/g, " ")}
          </span>
        </div>
        {data.impliedVol != null && (
          <div className="flex justify-between">
            <span className="text-slate-500">ATM IV</span>
            <span className="text-slate-300">{(data.impliedVol * 100).toFixed(1)}%</span>
          </div>
        )}
      </div>
    </LayerCard>
  );
}
