/**
 * Multi-coin picker for portfolio backtests.
 * Shows coverage per symbol for the selected date window; pin/select up to 10 coins.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";

const MAX_COINS = 10;
const MIN_COINS = 2;

type Props = {
  candidates: string[];
  selected: string[];
  timeframe: string;
  from: string;
  to: string;
  onChange: (symbols: string[]) => void;
};

function coverageClass(pct: number | null | undefined): string {
  if (pct == null) return "text-slate-400";
  if (pct >= 99) return "text-emerald-600 dark:text-emerald-400";
  if (pct >= 90) return "text-amber-600 dark:text-amber-400";
  return "text-rose-600 dark:text-rose-400";
}

export function MultiCoinSelector({ candidates, selected, timeframe, from, to, onChange }: Props) {
  const [coverageBySymbol, setCoverageBySymbol] = useState<
    Record<string, { coveragePct: number | null }>
  >({});
  const [loading, setLoading] = useState(false);

  const list = useMemo(() => {
    const merged = [...candidates];
    for (const s of selected) {
      if (!merged.includes(s)) merged.push(s);
    }
    return merged;
  }, [candidates, selected]);

  useEffect(() => {
    if (!list.length || !timeframe || !from || !to) return;
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      void api
        .getDataCoverageBatch({ symbols: list, timeframe, from, to })
        .then((d) => {
          if (cancelled) return;
          const raw = d?.coverageBySymbol ?? {};
          const next: Record<string, { coveragePct: number | null }> = {};
          for (const sym of list) {
            next[sym] = { coveragePct: raw[sym]?.coveragePct ?? null };
          }
          setCoverageBySymbol(next);
        })
        .catch(() => {
          if (!cancelled) setCoverageBySymbol({});
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [list.join(","), timeframe, from, to]);

  function toggle(sym: string) {
    const on = selected.includes(sym);
    if (on) {
      onChange(selected.filter((s) => s !== sym));
      return;
    }
    if (selected.length >= MAX_COINS) return;
    onChange([...selected, sym]);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        {selected.length === 0 ? (
          <span className="text-[10px] text-slate-500">Select at least {MIN_COINS} coins</span>
        ) : (
          selected.map((sym) => (
            <button
              key={sym}
              type="button"
              onClick={() => toggle(sym)}
              className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-800 dark:bg-sky-900/50 dark:text-sky-200"
              title="Click to remove"
            >
              {sym.replace("USDT", "")} ×
            </button>
          ))
        )}
        <span className="ml-auto text-[10px] text-slate-500">
          {selected.length}/{MAX_COINS} selected
        </span>
      </div>

      <div className="max-h-[220px] overflow-y-auto rounded border border-slate-200 dark:border-slate-700">
        <table className="w-full text-[11px]">
          <thead className="sticky top-0 bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-500 dark:bg-slate-900">
            <tr>
              <th className="px-2 py-1.5">Coin</th>
              <th className="px-2 py-1.5">Coverage</th>
              <th className="px-2 py-1.5 text-right">Select</th>
            </tr>
          </thead>
          <tbody>
            {list.map((sym) => {
              const pinned = selected.includes(sym);
              const cov = coverageBySymbol[sym]?.coveragePct;
              const atMax = !pinned && selected.length >= MAX_COINS;
              return (
                <tr
                  key={sym}
                  className={`border-t border-slate-100 dark:border-slate-800 ${
                    pinned ? "bg-sky-50/80 dark:bg-sky-950/30" : ""
                  }`}
                >
                  <td className="px-2 py-1 font-mono font-semibold">{sym}</td>
                  <td className={`px-2 py-1 font-mono ${coverageClass(cov)}`}>
                    {loading && cov == null ? "…" : cov != null ? `${cov.toFixed(1)}%` : "—"}
                  </td>
                  <td className="px-2 py-1 text-right">
                    <button
                      type="button"
                      disabled={atMax}
                      onClick={() => toggle(sym)}
                      className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                        pinned
                          ? "bg-sky-600 text-white"
                          : atMax
                            ? "cursor-not-allowed bg-slate-100 text-slate-400 dark:bg-slate-800"
                            : "border border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200"
                      }`}
                    >
                      {pinned ? "Pinned" : "Pin"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {selected.length > 0 && selected.length < MIN_COINS ? (
        <p className="text-[10px] text-amber-700 dark:text-amber-400">
          Select at least {MIN_COINS} coins for a portfolio backtest.
        </p>
      ) : null}
    </div>
  );
}
