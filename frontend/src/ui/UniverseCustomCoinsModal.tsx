import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";

const MAX = 10;

type Props = {
  open: boolean;
  initialSymbols: string[];
  onClose: () => void;
  onSave: (symbols: string[]) => void | Promise<void>;
};

export function UniverseCustomCoinsModal({ open, initialSymbols, onClose, onSave }: Props) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [allSymbols, setAllSymbols] = useState<string[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const initialKey = initialSymbols.join("\n");

  useEffect(() => {
    if (!open) return;
    setSelected([...new Set(initialSymbols.map((s) => String(s || "").trim().toUpperCase()))].slice(0, MAX));
    setSearch("");
    setLoadErr(null);
    let cancelled = false;
    (async () => {
      setAllSymbols(null);
      try {
        const r = await api.universeSymbols();
        if (cancelled) return;
        if (r?.ok && Array.isArray(r.symbols)) setAllSymbols(r.symbols);
        else setLoadErr(String(r?.error || "symbols_unavailable"));
      } catch (e) {
        if (!cancelled) setLoadErr(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, initialKey]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const q = search.trim().toUpperCase();
  const filtered = useMemo(() => {
    if (!allSymbols) return [];
    if (!q) return allSymbols;
    return allSymbols.filter((s) => {
      const su = s.toUpperCase();
      const base = su.endsWith("USDT") ? su.slice(0, -4) : su;
      return su.includes(q) || base.includes(q);
    });
  }, [allSymbols, q]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  if (!open) return null;

  const addSymbol = (sym: string) => {
    const u = String(sym || "").toUpperCase();
    if (!u || selectedSet.has(u)) return;
    if (selected.length >= MAX) return;
    setSelected([...selected, u]);
  };

  const removeSymbol = (sym: string) => {
    const u = String(sym || "").toUpperCase();
    setSelected(selected.filter((x) => x !== u));
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave([...selected]);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-950"
        role="dialog"
        aria-modal="true"
        aria-labelledby="universe-custom-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <h2 id="universe-custom-title" className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Custom coin base (max {MAX})
          </h2>
          <button
            type="button"
            className="rounded-md px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-900"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-4 md:grid-cols-2">
          <div className="flex min-h-0 flex-col rounded-lg border border-slate-200 dark:border-slate-800">
            <div className="border-b border-slate-200 p-2 dark:border-slate-800">
              <input
                type="search"
                className="w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm text-slate-900 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
                placeholder="Search symbol or base (e.g. BTC)…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className="max-h-[min(52vh,420px)] overflow-auto p-2 text-xs">
              {loadErr ? (
                <div className="text-amber-700 dark:text-amber-400">{loadErr}</div>
              ) : allSymbols == null ? (
                <div className="text-slate-500">Loading tradable symbols…</div>
              ) : filtered.length === 0 ? (
                <div className="text-slate-500">No matches</div>
              ) : (
                <ul className="space-y-0.5">
                  {filtered.slice(0, 800).map((sym) => {
                    const dis = selectedSet.has(sym) || (selected.length >= MAX && !selectedSet.has(sym));
                    return (
                      <li key={sym}>
                        <button
                          type="button"
                          disabled={dis}
                          className="flex w-full items-center justify-between rounded px-2 py-1 text-left font-mono text-slate-800 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-200 dark:hover:bg-slate-900"
                          onClick={() => addSymbol(sym)}
                        >
                          <span>{sym}</span>
                          {selectedSet.has(sym) ? (
                            <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">added</span>
                          ) : selected.length >= MAX ? (
                            <span className="text-[10px] text-slate-500">full</span>
                          ) : (
                            <span className="text-[10px] text-slate-500">add</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {filtered.length > 800 ? (
                <div className="mt-2 text-[10px] text-slate-500">Refine search — showing first 800 matches.</div>
              ) : null}
            </div>
          </div>

          <div className="flex min-h-0 flex-col rounded-lg border border-slate-200 dark:border-slate-800">
            <div className="border-b border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 dark:border-slate-800 dark:text-slate-300">
              Selected ({selected.length}/{MAX})
            </div>
            <div className="max-h-[min(52vh,420px)] flex-1 overflow-auto p-2">
              {selected.length === 0 ? (
                <div className="text-xs text-slate-500">Choose up to {MAX} coins for the custom universe.</div>
              ) : (
                <ul className="space-y-1">
                  {selected.map((sym) => (
                    <li
                      key={sym}
                      className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 dark:border-slate-800 dark:bg-slate-900/60"
                    >
                      <span className="font-mono text-xs text-slate-900 dark:text-slate-100">{sym}</span>
                      <button
                        type="button"
                        className="rounded px-2 py-0.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-950/50"
                        onClick={() => removeSymbol(sym)}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-800">
          <button
            type="button"
            className="rounded-md border border-slate-300 bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save to trading config"}
          </button>
        </div>
      </div>
    </div>
  );
}
