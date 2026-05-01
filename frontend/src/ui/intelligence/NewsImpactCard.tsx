import { LayerCard } from "./LayerCard";
import type { NewsImpactData } from "../../types/intelligence";

interface Props {
  data: NewsImpactData | null | undefined;
}

function sentimentColor(s: number) {
  if (s >= 0.35) return "#34d399";
  if (s <= -0.35) return "#fb7185";
  return "#94a3b8";
}

export function NewsImpactCard({ data }: Props) {
  if (!data || typeof data.sentiment !== "number" || !Number.isFinite(data.sentiment)) {
    return (
      <LayerCard
        title="News impact (macro)"
        status="unavailable"
        note="Uses FINNHUB_API_KEY for crypto headlines plus AI service /news_impact_score heuristic."
      />
    );
  }

  const s = data.sentiment;
  const pct = Math.round(((s + 1) / 2) * 100);
  const col = sentimentColor(s);

  return (
    <LayerCard title="News impact">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-3xl font-bold tabular-nums" style={{ color: col }}>
          {s >= 0 ? "+" : ""}
          {s.toFixed(2)}
        </span>
        <span className="text-xs text-slate-500">−1 bearish → +1 bullish · bar {pct}%</span>
      </div>
      {data.summary ? <p className="mb-2 text-[11px] leading-snug text-slate-400">{data.summary}</p> : null}
      {data.headlineSample?.length ? (
        <ul className="list-inside list-disc space-y-0.5 text-[10px] text-slate-500">
          {data.headlineSample.slice(0, 4).map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      ) : null}
      {data.updatedAt ? (
        <p className="mt-2 text-[9px] text-slate-600">Updated {new Date(data.updatedAt).toLocaleString()}</p>
      ) : null}
    </LayerCard>
  );
}
