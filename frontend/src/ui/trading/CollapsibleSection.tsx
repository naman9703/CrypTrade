import { useState, type ReactNode } from "react";
import { clsx } from "clsx";

export function CollapsibleSection({
  title,
  summary,
  defaultOpen = true,
  badge,
  children,
  className,
}: {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  badge?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className={clsx(
        "rounded-lg border border-slate-200 bg-white/60 dark:border-slate-800 dark:bg-slate-950/30",
        className,
      )}
    >
      <button
        type="button"
        className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">{title}</span>
            {badge}
          </div>
          {summary && !open ? (
            <p className="mt-0.5 truncate text-[10px] text-slate-500 dark:text-slate-400">{summary}</p>
          ) : null}
        </div>
        <span className="shrink-0 text-[10px] text-slate-500">{open ? "▼" : "▶"}</span>
      </button>
      {open ? (
        <div className="border-t border-slate-200 px-3 pb-3 pt-2 dark:border-slate-800">{children}</div>
      ) : null}
    </div>
  );
}

export function GateEffectiveBadge({ effective }: { effective: boolean }) {
  return (
    <span
      className={clsx(
        "rounded px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide",
        effective
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
          : "bg-slate-500/15 text-slate-600 dark:text-slate-400",
      )}
    >
      {effective ? "Effective" : "Inactive"}
    </span>
  );
}
