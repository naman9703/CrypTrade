import { LayerCard } from "./LayerCard";
import type { VolatilityData } from "../../types/intelligence";

interface Props {
  data: VolatilityData | null;
}

function regimeColor(r: string) {
  switch (r) {
    case "low":          return "#16a34a";
    case "normal":       return "#64748b";
    case "elevated":     return "#ea580c";
    case "extreme":      return "#dc2626";
    case "strong_trend": return "#65a30d";
    case "trending":     return "#16a34a";
    case "choppy":       return "#94a3b8";
    default:             return "#94a3b8";
  }
}

function RegimePill({ label, value }: { label: string; value: string }) {
  const color = regimeColor(value);
  return (
    <div className="rounded bg-slate-800 px-2 py-1.5">
      <p className="text-[9px] uppercase text-slate-500">{label}</p>
      <p className="text-xs font-bold capitalize" style={{ color }}>
        {value.replace(/_/g, " ")}
      </p>
    </div>
  );
}

export function VolatilityCard({ data }: Props) {
  if (!data) return <LayerCard title="Volatility & Regime" status="loading" />;

  const rv = data.realisedVol24h;
  const rvOk = rv != null && Number.isFinite(Number(rv));
  /** Backend returns annualized realised vol as percent points (e.g. 52 = 52%); do not multiply by 100 again. */
  const rvDisp = rvOk ? `${Number(rv).toFixed(2)}%` : "—";

  const volColor =
    data.volRegime === "unknown"
      ? "#64748b"
      : data.volRegime === "extreme"
        ? "#dc2626"
        : data.volRegime === "elevated"
          ? "#ea580c"
          : data.volRegime === "low"
            ? "#16a34a"
            : "#64748b";

  return (
    <LayerCard title="Volatility & Regime">
      <div className="mb-3 flex items-baseline gap-2">
        <span className="text-3xl font-bold tabular-nums" style={{ color: volColor }}>
          {rvDisp}
        </span>
        <span className="text-xs text-slate-500">annualized (from ~24× 1h)</span>
      </div>
      {!rvOk ? (
        <p className="mb-2 text-[10px] text-slate-500">
          Need at least 24 closed 1h bars (filled automatically from Binance public klines with confluence refresh).
        </p>
      ) : null}

      <div className="grid grid-cols-3 gap-1.5">
        <RegimePill label="Vol regime" value={data.volRegime} />
        <RegimePill label="ADX regime" value={data.adxRegime} />
        <RegimePill label="Combined" value={data.combined} />
      </div>

      {(data.impliedVolAnnualPct != null && Number.isFinite(Number(data.impliedVolAnnualPct))) ||
      (data.ivRvRatio != null && Number.isFinite(Number(data.ivRvRatio))) ? (
        <div className="mt-3 space-y-1 border-t border-slate-700/40 pt-2 dark:border-slate-700/40">
          <p className="text-[10px] uppercase tracking-wide text-slate-500">Options-implied vs realised</p>
          <div className="flex flex-wrap gap-2 text-xs text-slate-300">
            {data.impliedVolAnnualPct != null && Number.isFinite(Number(data.impliedVolAnnualPct)) ? (
              <span>
                ATM IV (ann.):{" "}
                <strong className="tabular-nums text-slate-100">{Number(data.impliedVolAnnualPct).toFixed(2)}%</strong>
              </span>
            ) : (
              <span className="text-slate-500">ATM IV: — (needs Deribit-eligible symbol)</span>
            )}
            {data.ivRvRatio != null && Number.isFinite(Number(data.ivRvRatio)) ? (
              <span>
                IV/RV:{" "}
                <strong className="tabular-nums text-slate-100">{Number(data.ivRvRatio).toFixed(2)}</strong>
              </span>
            ) : null}
            {data.ivRelativeRegime && data.ivRelativeRegime !== "unknown" ? (
              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] capitalize text-slate-400">
                {String(data.ivRelativeRegime).replace(/_/g, " ")}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </LayerCard>
  );
}
