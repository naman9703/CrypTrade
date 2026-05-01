import { LayerCard } from "./LayerCard";
import type { ConfluenceData } from "../../types/intelligence";

interface Props {
  data: ConfluenceData | null;
}

const TF_ORDER = ["1m", "5m", "15m", "1h", "4h", "1d"];

function dirLabel(dir: "up" | "down" | null) {
  if (dir === "up")   return { label: "▲ UP",   color: "#16a34a" };
  if (dir === "down") return { label: "▼ DOWN", color: "#dc2626" };
  return { label: "— N/A", color: "#64748b" };
}

/** Confluence score is 0–100 (% of timeframes agreeing with 15m primary). */
function scoreColorPct(s: number) {
  if (s >= 70) return "#16a34a";
  if (s >= 55) return "#65a30d";
  if (s <= 30) return "#dc2626";
  if (s <= 45) return "#ea580c";
  return "#64748b";
}

export function ConfluenceCard({ data }: Props) {
  if (!data) return <LayerCard title="Timeframe Confluence" status="loading" />;

  const sc = data.score;
  const defined = data.defined ?? 0;
  const agreeing = data.agreeing ?? 0;
  const col = scoreColorPct(sc);

  const biasLabel =
    data.bias === "insufficient_data"
      ? "Gathering MTF data"
      : data.bias.replace(/_/g, " ");

  return (
    <LayerCard title="Timeframe Confluence">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex shrink-0 items-baseline gap-1">
          <span className="text-3xl font-bold tabular-nums" style={{ color: col }}>
            {sc}%
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">align</span>
        </div>
        <p className="max-w-[11rem] text-right text-[10px] text-slate-400 leading-snug">
          {defined > 0 ? (
            <>
              {agreeing}/{defined} TFs match 15m ·{" "}
              <span className="text-slate-500">Primary: {data.primaryDir ?? "—"}</span>
            </>
          ) : (
            <>
              {biasLabel}
              <br />
              <span className="text-slate-500">Primary: {data.primaryDir ?? "—"}</span>
            </>
          )}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        {TF_ORDER.map((tf) => {
          const d = (data.breakdown as Record<string, "up" | "down" | null>)[tf] ?? null;
          const { label, color } = dirLabel(d);
          const isActive = tf === "15m";
          return (
            <div
              key={tf}
              className={`rounded px-2 py-1.5 text-center ${isActive ? "ring-1 ring-slate-500" : ""}`}
              style={{ backgroundColor: color + "15" }}
            >
              <p className="text-[9px] uppercase text-slate-500">{tf}</p>
              <p className="text-xs font-semibold" style={{ color }}>
                {label}
              </p>
            </div>
          );
        })}
      </div>
    </LayerCard>
  );
}
