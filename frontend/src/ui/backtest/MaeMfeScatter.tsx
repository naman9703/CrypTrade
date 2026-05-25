/**
 * MAE (max adverse excursion) vs MFE (max favourable excursion) scatter, expressed
 * as % moves against / for each trade. Wins are green dots; losses red. Helps
 * spot strategies that "could have won but stopped out early".
 */
import { useEffect, useRef } from "react";
import type { BacktestTrade } from "../../types/backtest";

export function MaeMfeScatter({ trades }: { trades: BacktestTrade[] }) {
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

    const points = trades
      .filter((t) => t.maePct != null && t.mfePct != null)
      .map((t) => ({ x: Math.abs(Number(t.maePct)), y: Math.abs(Number(t.mfePct)), win: Number(t.netPnl) > 0 }));
    if (!points.length) {
      ctx.fillStyle = "rgba(100, 116, 139, 0.7)";
      ctx.font = "12px system-ui";
      ctx.textAlign = "center";
      ctx.fillText("No MAE/MFE data", w / 2, h / 2);
      return;
    }
    const maxX = Math.max(...points.map((p) => p.x), 1);
    const maxY = Math.max(...points.map((p) => p.y), 1);
    const padX = 28;
    const padY = 16;
    const innerW = w - padX * 2;
    const innerH = h - padY * 2;
    ctx.strokeStyle = "rgba(148, 163, 184, 0.4)";
    ctx.strokeRect(padX, padY, innerW, innerH);
    ctx.beginPath();
    ctx.moveTo(padX, padY + innerH);
    ctx.lineTo(padX + innerW, padY);
    ctx.strokeStyle = "rgba(148, 163, 184, 0.3)";
    ctx.stroke();
    for (const p of points) {
      const px = padX + (p.x / maxX) * innerW;
      const py = padY + innerH - (p.y / maxY) * innerH;
      ctx.fillStyle = p.win ? "rgba(16, 185, 129, 0.7)" : "rgba(244, 63, 94, 0.7)";
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(100, 116, 139, 0.85)";
    ctx.font = "10px system-ui";
    ctx.textAlign = "left";
    ctx.fillText("MAE % (adverse)", padX, h - 2);
    ctx.textAlign = "right";
    ctx.fillText("MFE %", w - 4, padY + 8);
  }, [trades]);

  return (
    <div>
      <div className="pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">MAE vs MFE</div>
      <canvas ref={ref} className="h-[200px] w-full" />
    </div>
  );
}
