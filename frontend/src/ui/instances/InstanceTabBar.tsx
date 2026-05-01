import { clsx } from "clsx";
import type { BotInstance } from "../../types/instance";

type Props = {
  instances: BotInstance[];
  selectedId: string | null;
  activeTradingId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onDeleteTab: (inst: BotInstance) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
};

function statusDot(status: string) {
  const s = String(status).toLowerCase();
  if (s === "running") return "bg-emerald-500";
  if (s === "paused") return "bg-amber-400 ring-2 ring-amber-200 dark:ring-amber-700";
  if (s === "error") return "bg-rose-500";
  return "bg-slate-400";
}

export function InstanceTabBar({
  instances,
  selectedId,
  activeTradingId,
  onSelect,
  onAdd,
  onDeleteTab,
  collapsed,
  onToggleCollapse,
}: Props) {
  return (
    <div className="flex min-h-[40px] items-center gap-1 border-b border-slate-200 bg-slate-50/90 px-1 dark:border-slate-800 dark:bg-slate-900/80">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-hidden scrollbar-thin">
        {instances.map((inst) => {
          const sel = inst.id === selectedId;
          const label = inst.label || inst.id.slice(0, 8);
          const short = label.length > 18 ? `${label.slice(0, 16)}…` : label;
          return (
            <div
              key={inst.id}
              className={clsx(
                "group relative flex h-9 min-w-[120px] max-w-[200px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2 text-xs",
                sel
                  ? "border-slate-300 bg-white font-medium dark:border-slate-600 dark:bg-slate-950"
                  : "border-transparent bg-transparent text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800/80",
              )}
              onClick={() => onSelect(inst.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(inst.id);
                }
              }}
              role="tab"
              tabIndex={0}
              aria-selected={sel}
            >
              <span
                className={clsx("h-2 w-2 shrink-0 rounded-full", statusDot(inst.status))}
                title={String(inst.status).toLowerCase() === "paused" ? "paused ◐" : inst.status}
              />
              <span className="min-w-0 flex-1 truncate" title={label}>
                {short}
              </span>
              {inst.id === activeTradingId ? (
                <span className="shrink-0 text-[9px] uppercase text-sky-600 dark:text-sky-400" title="Active for trading">
                  ●
                </span>
              ) : null}
              <button
                type="button"
                className="absolute right-0.5 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-slate-500 hover:bg-slate-200 group-hover:flex dark:hover:bg-slate-700"
                aria-label="Remove tab"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteTab(inst);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-t-md border border-dashed border-slate-300 text-lg text-slate-500 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800"
          onClick={onAdd}
          title="New instance"
        >
          +
        </button>
      </div>
      <button
        type="button"
        className="ml-1 shrink-0 rounded p-1.5 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800"
        title={collapsed ? "Expand panel" : "Collapse panel"}
        onClick={onToggleCollapse}
      >
        {collapsed ? "∨" : "∧"}
      </button>
    </div>
  );
}
