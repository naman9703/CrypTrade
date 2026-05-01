import { LayerCard } from "./LayerCard";
import type { OnChainData } from "../../types/intelligence";

interface Props {
  data: OnChainData | null;
}

function takerImbalanceColor(v: number) {
  if (v > 12) return "#16a34a";
  if (v < -12) return "#dc2626";
  return "#64748b";
}

function cqUsdColor(v: number) {
  if (v > 50_000_000) return "#dc2626";
  if (v > 10_000_000) return "#ea580c";
  if (v < -50_000_000) return "#16a34a";
  if (v < -10_000_000) return "#65a30d";
  return "#64748b";
}

function takerColor(v: number) {
  if (v > 0.55) return "#16a34a";
  if (v > 0.48) return "#64748b";
  return "#dc2626";
}

function fmtUsdCompact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

export function OnChainCard({ data }: Props) {
  if (!data) return <LayerCard title="On-Chain / Flow" status="loading" />;

  const imbColor = takerImbalanceColor(data.takerFlowImbalancePct);
  const tColor = takerColor(data.takerBuyRatio);
  const takerPct = Math.min(100, Math.max(0, data.takerBuyRatio * 100));
  const cq = data.cryptoQuantNetflowUsd24h;

  return (
    <LayerCard title="On-Chain / Flow">
      {/* Taker buy ratio */}
      <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Taker buy ratio (Binance futures)</p>
      <div className="flex h-2 w-full overflow-hidden rounded-full">
        <div className="h-full bg-emerald-600/70 transition-all" style={{ width: `${takerPct}%` }} />
        <div className="h-full bg-red-600/70 transition-all" style={{ width: `${100 - takerPct}%` }} />
      </div>
      <div className="mt-0.5 flex justify-between text-[10px]">
        <span className="text-emerald-400">Buy</span>
        <span style={{ color: tColor }}>{(data.takerBuyRatio * 100).toFixed(1)}%</span>
        <span className="text-red-400">Sell</span>
      </div>

      <div className="mt-2.5 space-y-1.5 text-xs">
        <div className="flex justify-between gap-2">
          <span className="shrink text-slate-500">Taker imbalance (24× 1h)</span>
          <span style={{ color: imbColor }} className="font-semibold tabular-nums">
            {data.takerFlowImbalancePct >= 0 ? "+" : ""}
            {data.takerFlowImbalancePct.toFixed(2)}%
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Taker z-score</span>
          <span className="tabular-nums text-slate-300">{data.takerFlowZscore.toFixed(2)}σ</span>
        </div>
        {cq != null && Number.isFinite(cq) ? (
          <div className="flex justify-between gap-2 border-t border-slate-700/40 pt-2 dark:border-slate-700/40">
            <span className="shrink text-slate-500">CQ exchange netflow (~USD)</span>
            <span style={{ color: cqUsdColor(cq) }} className="font-semibold tabular-nums">
              {cq >= 0 ? "+" : ""}${fmtUsdCompact(cq)}
            </span>
          </div>
        ) : (
          <p className="border-t border-slate-700/40 pt-2 text-[10px] text-slate-500 dark:border-slate-700/40">
            CryptoQuant netflow appears when <code className="text-slate-400">CRYPTOQUANT_API_KEY</code> is set (BTC/ETH
            pairs).
          </p>
        )}
      </div>
    </LayerCard>
  );
}
