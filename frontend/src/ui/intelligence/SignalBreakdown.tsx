import type { IntelligenceSignal } from "../../types/intelligence";

interface Props {
  bullish: IntelligenceSignal[];
  bearish: IntelligenceSignal[];
}

function SignalList({ signals, side }: { signals: IntelligenceSignal[]; side: "bull" | "bear" }) {
  const headerColor  = side === "bull" ? "text-emerald-400" : "text-red-400";
  const headerBorder = side === "bull" ? "border-emerald-700/50" : "border-red-700/50";
  const headerBg     = side === "bull" ? "bg-emerald-950/40"    : "bg-red-950/40";
  const label        = side === "bull" ? "Bullish Signals"       : "Bearish Signals";

  return (
    <div className="flex flex-1 flex-col">
      <div className={`mb-1.5 rounded px-2 py-1 ${headerBg} border ${headerBorder}`}>
        <p className={`text-[10px] font-bold uppercase tracking-wider ${headerColor}`}>{label}</p>
      </div>
      <div className="space-y-1">
        {signals.length === 0 ? (
          <p className="px-1 text-xs text-slate-600 dark:text-slate-500">No {side === "bull" ? "bullish" : "bearish"} signals</p>
        ) : (
          signals.map((s, i) => (
            <div key={i} className="flex items-start justify-between gap-2 px-1">
              <span className="text-[13px] font-semibold text-slate-800 dark:text-slate-200">{s.name}</span>
              <span className="shrink-0 text-[12px] text-slate-600 dark:text-slate-500">{s.detail}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function SignalBreakdown({ bullish, bearish }: Props) {
  return (
    <div className="flex gap-3">
      <SignalList signals={bullish} side="bull" />
      <SignalList signals={bearish} side="bear" />
    </div>
  );
}
