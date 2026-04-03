import { useEffect, useMemo, useRef } from "react";
import { createChart, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import { useAppStore } from "../ws/store";
import { OrderBookPanel } from "./OrderBookPanel";

export function ChartPanel() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<any>(null);

  const candles = useAppStore((s) => s.candles);
  const market = useAppStore((s) => s.market);

  const ohlc = useMemo(() => {
    const out: { time: UTCTimestamp; open: number; high: number; low: number; close: number }[] = [];
    for (const c of candles) {
      const ts = Number(c.ts);
      const t = Number.isFinite(ts) ? (Math.floor(ts / 1000) as UTCTimestamp) : null;
      const open = Number(c.open);
      const high = Number(c.high);
      const low = Number(c.low);
      const close = Number(c.close);
      if (t == null || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) continue;
      out.push({ time: t, open, high, low, close });
    }
    out.sort((a, b) => a.time - b.time);
    const dedup: typeof out = [];
    for (const bar of out) {
      if (dedup.length && dedup[dedup.length - 1].time === bar.time) dedup[dedup.length - 1] = bar;
      else dedup.push(bar);
    }
    return dedup;
  }, [candles]);

  useEffect(() => {
    if (!containerRef.current) return;
    if (chartRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: "#cbd5e1",
      },
      grid: {
        vertLines: { color: "rgba(148,163,184,0.12)" },
        horzLines: { color: "rgba(148,163,184,0.12)" },
      },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: "rgba(148,163,184,0.15)" },
      crosshair: { mode: 0 },
      handleScroll: true,
      handleScale: true,
    });

    const series = chart.addCandlestickSeries({
      upColor: "#34d399",
      downColor: "#fb7185",
      borderDownColor: "#fb7185",
      borderUpColor: "#34d399",
      wickDownColor: "#fb7185",
      wickUpColor: "#34d399",
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return;
      chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) return;
    if (!ohlc.length) return;
    try {
      seriesRef.current.setData(ohlc);
    } catch {
      // malformed feed should not white-screen the app
    }
  }, [ohlc]);

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">{market?.symbol ?? "—"}</div>
          <div className="text-xs text-slate-400">
            {market?.timeframe ?? "—"} · Regime: <span className="text-slate-200">{market?.regime?.type ?? "—"}</span>
          </div>
        </div>
        <div className="text-xs text-slate-400">
          Price:{" "}
          <span className="text-slate-100">
            {market?.candle?.close != null ? Number(market.candle.close).toFixed(2) : "—"}
          </span>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div ref={containerRef} className="h-[520px] w-full" />
        <OrderBookPanel />
      </div>
    </div>
  );
}

