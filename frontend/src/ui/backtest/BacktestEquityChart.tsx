/**
 * Lightweight chart wrapping `lightweight-charts` for the backtest equity / drawdown
 * series. Kept self-contained (the existing analytics chart consumes a different shape).
 */
import { useEffect, useRef } from "react";
import { ColorType, createChart, type LineData, type UTCTimestamp } from "lightweight-charts";
import type { BacktestEquityPoint } from "../../types/backtest";

const IST_OFFSET_SEC = 5 * 3600 + 30 * 60;
const toIst = (utcSec: number) => utcSec + IST_OFFSET_SEC;

type Props = {
  points: BacktestEquityPoint[];
  kind: "equity" | "drawdown";
};

export function BacktestEquityChart({ points, kind }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        // lightweight-charts does not accept CSS4 space-separated rgb(); use hex or rgb(r,g,b).
        textColor: "#64748b",
      },
      grid: {
        horzLines: { color: "rgba(148, 163, 184, 0.2)" },
        vertLines: { color: "rgba(148, 163, 184, 0.1)" },
      },
      timeScale: { borderVisible: false, timeVisible: true },
      rightPriceScale: { borderVisible: false },
      handleScale: false,
      handleScroll: false,
    });
    const series =
      kind === "equity"
        ? chart.addAreaSeries({ lineColor: "#0284c7", topColor: "rgba(14,165,233,0.4)", bottomColor: "rgba(14,165,233,0)" })
        : chart.addAreaSeries({ lineColor: "#dc2626", topColor: "rgba(239,68,68,0.4)", bottomColor: "rgba(239,68,68,0)" });
    let lastT = 0;
    const data: LineData[] = [];
    for (const p of points) {
      let t = toIst(Math.floor(Number(p.ts) / 1000));
      if (t <= lastT) t = lastT + 1;
      lastT = t;
      const v = kind === "equity" ? Number(p.equity) : -Math.abs(Number(p.drawdownPct));
      if (Number.isFinite(v)) data.push({ time: t as UTCTimestamp, value: v });
    }
    series.setData(data);
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points, kind]);

  if (!points.length) return <div className="py-8 text-center text-sm text-slate-500">No equity data</div>;
  return <div ref={ref} className="h-[280px] w-full" />;
}
