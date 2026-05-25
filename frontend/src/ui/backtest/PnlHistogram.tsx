/**
 * Net-PnL histogram (canvas-rendered for speed). Buckets by absolute trade
 * PnL with negative trades coloured red, positive green.
 */
import { useEffect, useRef } from "react";
import type { BacktestTrade } from "../../types/backtest";

export function PnlHistogram({ trades }: { trades: BacktestTrade[] }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const c = ref.current;
    const dpr = window.devicePixelRatio || 1;
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const w = c.clientWidth;
    const h = c.clientHeight;
    ctx.clearRect(0, 0, w, h);

    if (!trades.length) {
      ctx.fillStyle = "rgba(100, 116, 139, 0.7)";
      ctx.font = "12px system-ui";
      ctx.textAlign = "center";
      ctx.fillText("No trades", w / 2, h / 2);
      return;
    }
    const values = trades.map((t) => Number(t.netPnl));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(1e-9, max - min);
    const bucketCount = Math.min(40, Math.max(8, Math.ceil(Math.sqrt(trades.length))));
    const bucketSize = span / bucketCount;
    const buckets = new Array(bucketCount).fill(0);
    for (const v of values) {
      const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((v - min) / bucketSize)));
      buckets[idx]++;
    }
    const peak = Math.max(...buckets) || 1;
    const padX = 28;
    const padY = 14;
    const innerW = w - padX * 2;
    const innerH = h - padY * 2;
    const colW = innerW / bucketCount;
    for (let i = 0; i < bucketCount; i++) {
      const v = min + bucketSize * (i + 0.5);
      const barH = (buckets[i] / peak) * innerH;
      const x = padX + i * colW;
      const y = padY + innerH - barH;
      ctx.fillStyle = v >= 0 ? "rgba(16, 185, 129, 0.7)" : "rgba(244, 63, 94, 0.7)";
      ctx.fillRect(x + 1, y, Math.max(1, colW - 2), barH);
    }
    ctx.strokeStyle = "rgba(148, 163, 184, 0.4)";
    ctx.beginPath();
    const zeroX = padX + ((0 - min) / span) * innerW;
    if (zeroX >= padX && zeroX <= w - padX) {
      ctx.moveTo(zeroX, padY);
      ctx.lineTo(zeroX, padY + innerH);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(100, 116, 139, 0.8)";
    ctx.font = "10px system-ui";
    ctx.textAlign = "left";
    ctx.fillText(min.toFixed(1), padX, h - 2);
    ctx.textAlign = "right";
    ctx.fillText(max.toFixed(1), w - padX, h - 2);
  }, [trades]);
  return (
    <div>
      <div className="pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">PnL distribution</div>
      <canvas ref={ref} className="h-[200px] w-full" />
    </div>
  );
}
