import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";

const MAX = 10;
const SYMBOLS_CACHE_KEY = "universe_tradable_symbols_v1";
const SEARCH_DEBOUNCE_MS = 280;

type Props = {
  open: boolean;
  initialSymbols: string[];
  onClose: () => void;
  onSave: (symbols: string[]) => void | Promise<void>;
};

function readSymbolsCache(): string[] | null {
  try {
    const raw = sessionStorage.getItem(SYMBOLS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((s) => String(s || "").toUpperCase()).filter(Boolean) : null;
  } catch {
    return null;
  }
}

function writeSymbolsCache(symbols: string[]) {
  try {
    sessionStorage.setItem(SYMBOLS_CACHE_KEY, JSON.stringify(symbols.slice(0, 2000)));
  } catch {
    // ignore quota errors
  }
}

function normalizeQuerySymbol(q: string): string | null {
  const raw = String(q || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!raw) return null;
  const sym = raw.endsWith("USDT") ? raw : `${raw}USDT`;
  return /^[A-Z0-9]{2,16}USDT$/.test(sym) ? sym : null;
}

export function UniverseCustomCoinsModal({ open, initialSymbols, onClose, onSave }: Props) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [allSymbols, setAllSymbols] = useState<string[] | null>(() => readSymbolsCache());
  const [searchResults, setSearchResults] = useState<string[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const searchSeqRef = useRef(0);

  const initialKey = initialSymbols.join("\n");

  useEffect(() => {
    if (!open) return;
    setSelected([...new Set(initialSymbols.map((s) => String(s || "").trim().toUpperCase()))].slice(0, MAX));
    setSearch("");
    setSearchResults(null);
    setLoadErr(null);
    const cached = readSymbolsCache();
    if (cached?.length) setAllSymbols(cached);

    let cancelled = false;
    (async () => {
      try {
        const r = await api.universeSymbols();
        if (cancelled) return;
        if (r?.ok && Array.isArray(r.symbols) && r.symbols.length) {
          setAllSymbols(r.symbols);
          writeSymbolsCache(r.symbols);
          setLoadErr(null);
        } else if (!cached?.length) {
          setLoadErr(String(r?.error || "symbols_unavailable"));
        }
      } catch (e) {
        if (!cancelled && !cached?.length) setLoadErr(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, initialKey]);

  const q = search.trim().toUpperCase();
  const manualSymbol = useMemo(() => normalizeQuerySymbol(search), [search]);

  useEffect(() => {
    if (!open || !q) {
      setSearchResults(null);
      setSearchBusy(false);
      return;
    }

    const cached = allSymbols;
    if (cached?.length) {
      const local = cached.filter((s) => {
        const su = s.toUpperCase();
        const base = su.endsWith("USDT") ? su.slice(0, -4) : su;
        return su.includes(q) || base.includes(q);
      });
      setSearchResults(local);
      setSearchBusy(false);
      return;
    }

    const seq = ++searchSeqRef.current;
    setSearchBusy(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const r = await api.universeSymbols({ q });
          if (searchSeqRef.current !== seq) return;
          if (r?.ok && Array.isArray(r.symbols)) {
            setSearchResults(r.symbols);
            setLoadErr(null);
          } else {
            setSearchResults([]);
            if (!manualSymbol) setLoadErr(String(r?.error || "symbols_unavailable"));
          }
        } catch (e) {
          if (searchSeqRef.current !== seq) return;
          setSearchResults([]);
          if (!manualSymbol) setLoadErr(String(e));
        } finally {
          if (searchSeqRef.current === seq) setSearchBusy(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [open, q, allSymbols, manualSymbol]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    if (!q) return allSymbols ?? [];
    return searchResults ?? [];
  }, [allSymbols, q, searchResults]);

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

  const showManualAdd =
    manualSymbol != null && !selectedSet.has(manualSymbol) && selected.length < MAX;

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
              {showManualAdd ? (
                <button
                  type="button"
                  className="mb-2 flex w-full items-center justify-between rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1.5 font-mono text-emerald-900 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100 dark:hover:bg-emerald-950/60"
                  onClick={() => addSymbol(manualSymbol)}
                >
                  <span>Add {manualSymbol}</span>
                  <span className="text-[10px] font-semibold">manual</span>
                </button>
              ) : null}
              {loadErr && !q ? (
                <div className="text-amber-700 dark:text-amber-400">
                  {loadErr}
                  <div className="mt-1 text-[10px] text-slate-500">Type a symbol above (e.g. BTC) to add manually.</div>
                </div>
              ) : !q ? (
                <div className="text-slate-500">
                  {allSymbols == null
                    ? "Loading symbol index in background…"
                    : `Search ${allSymbols.length} tradable symbols, or type a base (e.g. BTC).`}
                </div>
              ) : searchBusy ? (
                <div className="text-slate-500">Searching…</div>
              ) : filtered.length === 0 ? (
                <div className="text-slate-500">
                  {loadErr ? (
                    <>
                      <span className="text-amber-700 dark:text-amber-400">{loadErr}</span>
                      {showManualAdd ? null : (
                        <span> — try a full symbol like BTCUSDT, or retry in a moment.</span>
                      )}
                    </>
                  ) : (
                    "No matches"
                  )}
                </div>
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
