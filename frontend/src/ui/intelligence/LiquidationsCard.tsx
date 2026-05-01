import { LayerCard } from "./LayerCard";
import type { LiquidationData } from "../../types/intelligence";

interface LProps {
  data: LiquidationData | null | undefined;
}

function fmtUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0";
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(2)}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(2)}M`;
  if (usd >= 1e3) return `$${(usd / 1e3).toFixed(0)}K`;
  return `$${usd.toFixed(0)}`;
}

function intensityBadge(intensity: LiquidationData["intensity"]): { label: string; color: string } {
  switch (intensity) {
    case "extreme":
      return { label: "Extreme", color: "#ef4444" };
    case "high":
      return { label: "High", color: "#f97316" };
    case "moderate":
      return { label: "Moderate", color: "#eab308" };
    default:
      return { label: "Low", color: "#64748b" };
  }
}

function intensityHint(intensity: LiquidationData["intensity"]): string {
  switch (intensity) {
    case "extreme":
      return "Extreme cascade — high volatility risk.";
    case "high":
      return "Active cascade — directional bias may form.";
    case "moderate":
      return "Elevated activity — watch for acceleration.";
    default:
      return "Calm — typical liquidation flow.";
  }
}

export function LiquidationsCard({ data }: LProps) {
  if (!data) {
    return (
      <LayerCard
        title="Liquidations (4h)"
        status="unavailable"
        note="No snapshot yet. Open Market Intelligence after the backend has run briefly, or confirm /api/intelligence/:symbol returns data."
      />
    );
  }

  const hasActivity =
    (Number.isFinite(data.totalUsd) && data.totalUsd > 0) ||
    (Number.isFinite(data.count) && data.count > 0);

  if (!hasActivity) {
    return (
      <LayerCard
        title="Liquidations (4h)"
        status="unavailable"
        note="Rolling 4h window has no USD-M forced liquidations for this symbol yet (quiet market or first server start — data fills after Binance publishes forceOrder events)."
      />
    );
  }

  const longPct = data.totalUsd > 0 ? (data.longUsd / data.totalUsd) * 100 : 50;
  const shortPct = 100 - longPct;
  const badge = intensityBadge(data.intensity);
  const accent =
    data.dominance === "longs"
      ? "text-rose-400 ring-rose-500/30"
      : data.dominance === "shorts"
        ? "text-emerald-400 ring-emerald-500/30"
        : "text-slate-400 ring-slate-600/30";

  return (
    <LayerCard title="Liquidations (4h)" badge={badge.label} badgeColor={badge.color}>
      <p className={`mb-2 rounded-md px-2 py-1 text-[10px] ring-1 ${accent}`}>{intensityHint(data.intensity)}</p>
      <p className="mb-2 text-[10px] uppercase tracking-wide text-slate-500">Longs vs shorts (USD notionals · Binance USD-M)</p>
      <div className="flex h-2 w-full overflow-hidden rounded-full">
        <div
          className="h-full bg-rose-500/80 transition-all"
          style={{ width: `${longPct}%` }}
          title="Long liquidations (forced sells)"
        />
        <div
          className="h-full bg-emerald-500/80 transition-all"
          style={{ width: `${shortPct}%` }}
          title="Short liquidations (forced buys)"
        />
      </div>
      <div className="mt-1 flex justify-between gap-2 text-[10px] text-slate-400">
        <span className="truncate">Longs {fmtUsd(data.longUsd)}</span>
        <span className="truncate">Shorts {fmtUsd(data.shortUsd)}</span>
      </div>
      <dl className="mt-2 space-y-1 text-xs">
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500">Total</dt>
          <dd className="font-mono text-slate-200">{fmtUsd(data.totalUsd)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500">Orders</dt>
          <dd className="font-mono text-slate-300">{data.count}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500">Window</dt>
          <dd className="font-mono text-slate-300">{data.windowHours}h</dd>
        </div>
      </dl>
    </LayerCard>
  );
}
