/**
 * Clickable overlay legend — faded = hidden on chart, click to toggle.
 */
import type { ChartOverlayLayerId, OverlayToggleItem } from "./backtestChartOverlayLayers";

type Props = {
  items: OverlayToggleItem[];
  layers: Record<ChartOverlayLayerId, boolean>;
  onToggle: (id: ChartOverlayLayerId) => void;
  extraLines?: string[];
};

export function ChartOverlayLegend({ items, layers, onToggle, extraLines }: Props) {
  if (!items.length && !extraLines?.length) return null;

  return (
    <div className="flex flex-wrap gap-x-2 gap-y-1 border-t border-slate-100 px-3 py-1.5 dark:border-slate-800">
      <span className="w-full text-[9px] uppercase tracking-wide text-slate-400 dark:text-slate-500">
        Chart layers — click to show / hide
      </span>
      {items.map((item) => {
        const on = layers[item.id] !== false;
        return (
          <button
            key={item.id}
            type="button"
            title={on ? `Hide ${item.label}` : `Show ${item.label}`}
            onClick={() => onToggle(item.id)}
            className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] transition-colors hover:bg-slate-100 dark:hover:bg-slate-800 ${
              on
                ? "text-slate-700 dark:text-slate-300"
                : "text-slate-400 opacity-45 line-through dark:text-slate-600"
            }`}
          >
            <span className={`font-semibold ${on ? item.prefixClass : "text-slate-400"}`}>{item.prefix}</span>
            <span>{item.label}</span>
          </button>
        );
      })}
      {extraLines?.map((line) => (
        <span key={line} className="text-[10px] text-slate-500 dark:text-slate-500">
          {line}
        </span>
      ))}
    </div>
  );
}
