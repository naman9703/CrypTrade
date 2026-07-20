/**
 * Left-side tier labels aligned to trailing lock price lines on the trade chart.
 */
import { useEffect, useState } from "react";
import type { IChartApi, ISeriesApi } from "lightweight-charts";
import type { ChartPriceLineSpec } from "./backtestChartOverlays";

type LabelRow = { label: string; color: string; top: number };

type Props = {
  chart: IChartApi | null;
  series: ISeriesApi<"Candlestick"> | null;
  tiers: ChartPriceLineSpec[];
  visible: boolean;
  /** Bump when chart instance is (re)created so we re-subscribe. */
  chartRev?: number;
};

export function TrailTierLeftLabels({ chart, series, tiers, visible, chartRev = 0 }: Props) {
  const [labels, setLabels] = useState<LabelRow[]>([]);

  useEffect(() => {
    if (!visible || !chart || !series || !tiers.length) {
      setLabels([]);
      return;
    }

    const update = () => {
      const next: LabelRow[] = [];
      for (const t of tiers) {
        const y = series.priceToCoordinate(t.price);
        if (y == null || !Number.isFinite(y)) continue;
        next.push({ label: t.title, color: t.color, top: y });
      }
      next.sort((a, b) => a.top - b.top);
      setLabels(next);
    };

    update();
    chart.timeScale().subscribeVisibleLogicalRangeChange(update);
    const onResize = () => update();
    window.addEventListener("resize", onResize);

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(update);
      window.removeEventListener("resize", onResize);
    };
  }, [chart, series, tiers, visible, chartRev]);

  if (!visible || !labels.length) return null;

  return (
    <div className="pointer-events-none absolute inset-y-0 left-0 z-10 flex w-11 flex-col">
      {labels.map((row) => (
        <div
          key={row.label}
          className="absolute left-1 whitespace-nowrap rounded bg-slate-950/75 px-1 py-0.5 font-mono text-[10px] font-bold leading-none backdrop-blur-sm"
          style={{
            top: row.top,
            transform: "translateY(-50%)",
            color: row.color,
          }}
        >
          {row.label}
        </div>
      ))}
    </div>
  );
}
