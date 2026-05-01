import type { ReactNode } from "react";

interface LayerCardProps {
  title: string;
  badge?: string;
  badgeColor?: string;
  status?: "loading" | "unavailable" | "error";
  note?: string;
  children?: ReactNode;
}

export function LayerCard({ title, badge, badgeColor, status, note, children }: LayerCardProps) {
  if (status === "loading") {
    return (
      <div className="rounded-lg border border-slate-700/60 bg-slate-900 p-3">
        <div className="mb-3 h-4 w-24 animate-pulse rounded bg-slate-700" />
        <div className="space-y-2">
          <div className="h-3 w-full animate-pulse rounded bg-slate-800" />
          <div className="h-3 w-4/5 animate-pulse rounded bg-slate-800" />
          <div className="h-3 w-3/5 animate-pulse rounded bg-slate-800" />
        </div>
      </div>
    );
  }

  if (status === "unavailable" || status === "error") {
    return (
      <div className="rounded-lg border border-slate-700/40 bg-slate-900 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
        {note && <p className="mt-2 text-xs text-slate-600">{note}</p>}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-900 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</p>
        {badge && (
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
            style={{ backgroundColor: (badgeColor ?? "#334155") + "33", color: badgeColor ?? "#94a3b8" }}
          >
            {badge}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
