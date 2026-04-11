import { useEffect, useMemo, useState } from "react";
import { useThemeStore } from "../themeStore";
import { RestCandleTile } from "./MultiChartGrid";

function uniqPositionSymbols(positions: any[] | undefined): string[] {
  const rows = Array.isArray(positions) ? positions : [];
  const u = new Set<string>();
  for (const p of rows) {
    const s = String(p?.symbol || "").toUpperCase().trim();
    if (s) u.add(s);
  }
  return [...u];
}

function notionalUsd(sym: string, positions: any[] | undefined): number {
  const rows = (Array.isArray(positions) ? positions : []).filter(
    (p) => String(p?.symbol || "").toUpperCase() === sym,
  );
  return rows.reduce((a, p) => {
    const q = Number(p?.qty ?? 0);
    const px = Number(p?.markPrice ?? p?.entryPrice ?? 0);
    return a + Math.abs(q * px);
  }, 0);
}

/**
 * Two REST mini charts per row for open-position symbols; carousel when more than two.
 */
export function PositionMiniChartsRow({
  positions,
  mainSymbol,
  onPickSymbol,
}: {
  positions: any[] | undefined;
  /** Highlight mini tile when it matches the main chart symbol. */
  mainSymbol: string;
  onPickSymbol: (sym: string) => void;
}) {
  const mainU = String(mainSymbol || "").toUpperCase();
  const theme = useThemeStore((s) => s.theme);
  const dark = theme === "dark";

  const sorted = useMemo(() => {
    const syms = uniqPositionSymbols(positions);
    return [...syms].sort((a, b) => notionalUsd(b, positions) - notionalUsd(a, positions));
  }, [positions]);

  const [start, setStart] = useState(0);
  const total = sorted.length;
  const maxStart = Math.max(0, total - 2);

  useEffect(() => {
    const m = Math.max(0, total - 2);
    if (start > m) setStart(m);
  }, [start, total]);

  if (total === 0) return null;

  const slice = sorted.slice(start, start + 2);

  return (
    <div className="w-full rounded-md border border-slate-200/90 dark:border-slate-800/80 bg-slate-50/80 dark:bg-slate-950/40 px-2 py-2">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-500">
          Open positions · tap for full chart
        </div>
        {total > 2 ? (
          <div className="flex items-center gap-1 text-[11px] text-slate-600 dark:text-slate-400">
            <button
              type="button"
              className="rounded border border-slate-300 px-2 py-0.5 font-semibold hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:hover:bg-slate-900"
              disabled={start <= 0}
              onClick={() => setStart((s) => Math.max(0, s - 1))}
              aria-label="Previous position charts"
            >
              ‹
            </button>
            <span className="tabular-nums">
              {start + 1}–{Math.min(start + 2, total)} / {total}
            </span>
            <button
              type="button"
              className="rounded border border-slate-300 px-2 py-0.5 font-semibold hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:hover:bg-slate-900"
              disabled={start >= maxStart}
              onClick={() => setStart((s) => Math.min(maxStart, s + 1))}
              aria-label="Next position charts"
            >
              ›
            </button>
          </div>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {slice.map((sym) => (
          <div
            key={`${sym}-${start}`}
            className={sym === mainU ? "rounded-lg ring-2 ring-sky-500/35" : ""}
          >
            <RestCandleTile symbol={sym} dark={dark} onSelect={() => onPickSymbol(sym)} />
          </div>
        ))}
      </div>
    </div>
  );
}
