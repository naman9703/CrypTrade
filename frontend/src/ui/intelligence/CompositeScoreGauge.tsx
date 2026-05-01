import type { CompositeData } from "../../types/intelligence";

interface Props {
  composite: CompositeData;
}

function zoneColor(score: number): string {
  if (score >= 80) return "#16a34a";
  if (score >= 60) return "#65a30d";
  if (score >= 40) return "#64748b";
  if (score >= 20) return "#ea580c";
  return "#dc2626";
}

function scoreToAngle(score: number): number {
  // Semicircle: 0=left (180deg) → 100=right (360deg)
  return 180 + (score / 100) * 180;
}

function polarToXY(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const s = polarToXY(cx, cy, r, startDeg);
  const e = polarToXY(cx, cy, r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`;
}

const ZONES = [
  { from: 0,  to: 20,  color: "#dc2626" },
  { from: 20, to: 40,  color: "#ea580c" },
  { from: 40, to: 60,  color: "#64748b" },
  { from: 60, to: 80,  color: "#65a30d" },
  { from: 80, to: 100, color: "#16a34a" },
];

function sizeLabel(mult: number) {
  if (mult >= 1.5) return { text: "INCREASE SIZE", color: "#16a34a" };
  if (mult >= 0.9) return { text: "STANDARD SIZE", color: "#65a30d" };
  if (mult >= 0.5) return { text: "REDUCE SIZE",   color: "#ea580c" };
  return { text: "MINIMAL SIZE", color: "#dc2626" };
}

export function CompositeScoreGauge({ composite }: Props) {
  const cx = 110, cy = 110, r = 80;
  const score   = composite.composite;
  const color   = zoneColor(score);
  const needleAngle = scoreToAngle(score);
  const needle  = polarToXY(cx, cy, r - 8, needleAngle);
  const sl      = sizeLabel(composite.sizeMultiplier);

  return (
    <div className="flex flex-col items-center py-2">
      <svg width={220} height={130} viewBox="0 0 220 130">
        {/* Background arc */}
        <path
          d={arcPath(cx, cy, r, 180, 360)}
          fill="none"
          stroke="#1e293b"
          strokeWidth={16}
          strokeLinecap="round"
        />
        {/* Zone arcs */}
        {ZONES.map((z) => (
          <path
            key={z.from}
            d={arcPath(cx, cy, r, 180 + (z.from / 100) * 180, 180 + (z.to / 100) * 180)}
            fill="none"
            stroke={z.color}
            strokeWidth={16}
            strokeLinecap="butt"
            opacity={0.25}
          />
        ))}
        {/* Active arc */}
        {score > 0 && (
          <path
            d={arcPath(cx, cy, r, 180, scoreToAngle(score))}
            fill="none"
            stroke={color}
            strokeWidth={16}
            strokeLinecap="round"
            style={{ transition: "stroke-dashoffset 1s ease" }}
          />
        )}
        {/* Needle */}
        <line x1={cx} y1={cy} x2={needle.x} y2={needle.y} stroke={color} strokeWidth={2} strokeLinecap="round" />
        {/* Center dot */}
        <circle cx={cx} cy={cy} r={5} fill={color} />
        {/* Score */}
        <text x={cx} y={cy - 18} textAnchor="middle" fill="#f1f5f9" fontSize={28} fontWeight="bold" fontFamily="monospace">
          {score}
        </text>
        {/* Bias label */}
        <text x={cx} y={cy - 4} textAnchor="middle" fill={color} fontSize={9} letterSpacing={1} fontWeight="600" style={{ textTransform: "uppercase" }}>
          {composite.bias.replace(/_/g, " ")}
        </text>
      </svg>

      {/* Stat pills */}
      <div className="flex gap-3">
        <div className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1 text-xs text-slate-300">
          Confidence <span className="font-bold text-white">{composite.confidence}%</span>
        </div>
        <div className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1 text-xs text-slate-300">
          Size <span className="font-bold" style={{ color }}>{composite.sizeMultiplier.toFixed(2)}×</span>
        </div>
      </div>

      {/* Size interpretation */}
      <p className="mt-1.5 text-[10px] font-bold uppercase tracking-widest" style={{ color: sl.color }}>
        {sl.text}
      </p>
    </div>
  );
}
