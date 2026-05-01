import { useEffect, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  createChart,
  type LineData,
  type UTCTimestamp,
} from "lightweight-charts";
import type { EquityCurvePoint } from "../../types/performance";

type Props = {
  points: EquityCurvePoint[];
  dark?: boolean;
};

function buildSeriesData(
  points: EquityCurvePoint[],
): { equity: LineData[]; dd: LineData[]; aligned: Array<{ t: number; p: EquityCurvePoint }> } {
  let lastT = 0;
  const equity: LineData[] = [];
  const dd: LineData[] = [];
  const aligned: Array<{ t: number; p: EquityCurvePoint }> = [];
  for (const p of points) {
    const ts = new Date(p.closedAt).getTime();
    if (!Number.isFinite(ts)) continue;
    let t = Math.floor(ts / 1000);
    if (t <= lastT) t = lastT + 1;
    lastT = t;
    aligned.push({ t, p });
    equity.push({ time: t as UTCTimestamp, value: p.runningEquity });
    dd.push({ time: t as UTCTimestamp, value: -Math.abs(p.drawdownPct) });
  }
  return { equity, dd, aligned };
}

export function EquityCurveChart({ points, dark = false }: Props) {
  const equityRef = useRef<HTMLDivElement | null>(null);
  const ddRef = useRef<HTMLDivElement | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    const elE = equityRef.current;
    const elD = ddRef.current;
    if (!elE || !elD) return;

    const { equity, dd, times } = buildSeriesData(points);

    const grid = dark
      ? { vertLines: { color: "rgba(148,163,184,0.15)" }, horzLines: { color: "rgba(148,163,184,0.15)" } }
      : { vertLines: { color: "rgba(15,23,42,0.08)" }, horzLines: { color: "rgba(15,23,42,0.08)" } };
    const text = dark ? "#e2e8f0" : "#0f172a";
    const bg = dark ? "#0f172a" : "#ffffff";

    const chartE = createChart(elE, {
      height: 220,
      layout: {
        background: { type: ColorType.Solid, color: bg },
        textColor: text,
      },
      grid,
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
    });
    const lineE = chartE.addLineSeries({
      color: "#0ea5e9",
      lineWidth: 2,
    });

    const chartD = createChart(elD, {
      height: 140,
      layout: {
        background: { type: ColorType.Solid, color: bg },
        textColor: text,
      },
      grid,
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
    });
    const areaD = chartD.addAreaSeries({
      lineColor: "rgba(244,63,94,0.9)",
      topColor: "rgba(244,63,94,0.35)",
      bottomColor: "rgba(244,63,94,0.02)",
      lineWidth: 1,
    });

    lineE.setData(equity);
    areaD.setData(dd);
    chartE.timeScale().fitContent();
    chartD.timeScale().fitContent();

    chartE.subscribeCrosshairMove((param) => {
      const t = param.time;
      if (t == null) {
        setHint(null);
        return;
      }
      const ti = typeof t === "number" ? t : Number(t);
      const raw = param.seriesData.get(lineE) as { value?: number } | undefined;
      const v = raw?.value;
      const idx = aligned.findIndex((a) => a.t === ti);
      const p = idx >= 0 ? aligned[idx]?.p : null;
      if (p && v != null && Number.isFinite(v)) {
        const pnlStr = p.netPnl >= 0 ? `+$${p.netPnl.toFixed(2)}` : `−$${Math.abs(p.netPnl).toFixed(2)}`;
        const d = new Date(p.closedAt);
        const dateStr = Number.isFinite(d.getTime()) ? d.toLocaleString() : p.closedAt;
        setHint(
          `${dateStr} · ${p.symbol} ${p.direction} · PnL ${pnlStr} · Equity $${v.toFixed(2)} · DD ${p.drawdownPct.toFixed(2)}%`,
        );
      } else if (v != null && Number.isFinite(v)) {
        setHint(`Equity $${v.toFixed(2)}`);
      } else {
        setHint(null);
      }
    });

    const ro = new ResizeObserver(() => {
      chartE.applyOptions({ width: elE.clientWidth });
      chartD.applyOptions({ width: elD.clientWidth });
    });
    ro.observe(elE);
    ro.observe(elD);
    chartE.applyOptions({ width: elE.clientWidth });
    chartD.applyOptions({ width: elD.clientWidth });

    return () => {
      ro.disconnect();
      chartE.remove();
      chartD.remove();
    };
  }, [points, dark]);

  if (!points.length) {
    return <p className="text-xs text-slate-500">No closed trades — equity curve appears after the first close.</p>;
  }

  return (
    <div className="space-y-2">
      {hint ? (
        <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px] text-slate-800 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-200">
          {hint}
        </div>
      ) : null}
      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase text-slate-500">Equity</div>
        <div ref={equityRef} className="w-full overflow-hidden rounded border border-slate-200 dark:border-slate-700" />
      </div>
      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase text-slate-500">Drawdown (%)</div>
        <div ref={ddRef} className="w-full overflow-hidden rounded border border-slate-200 dark:border-slate-700" />
      </div>
    </div>
  );
}
