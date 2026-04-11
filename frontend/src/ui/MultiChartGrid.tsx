import { ColorType, createChart, type IChartApi, type ISeriesApi } from "lightweight-charts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { useThemeStore } from "../themeStore";
import { useAppStore } from "../ws/store";

const GRID_PAGE_LS = "trading-multi-chart-page-v1";
const GRID_SORT_LS = "trading-multi-chart-sort-v1";
const TILE_H = 180;
const POLL_MS = 15_000;

export type ChartGridSort =
  | "UNREALIZED_PNL_DESC"
  | "UNREALIZED_PNL_ASC"
  | "NOTIONAL_DESC"
  | "NOTIONAL_ASC"
  | "RECENT_TRADE"
  | "SYMBOL_ASC";

function loadLs(key: string, fallback: string) {
  try {
    const v = localStorage.getItem(key);
    return v || fallback;
  } catch {
    return fallback;
  }
}

function saveLs(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}

function sortPinnedSymbols(
  symbols: string[],
  sort: ChartGridSort,
  positions: any[] | undefined,
  trades: any[] | undefined,
): string[] {
  const uniq = [...new Set(symbols.map((s) => String(s || "").toUpperCase()).filter(Boolean))];
  const posRows = Array.isArray(positions) ? positions : [];
  const pnl = (sym: string) => {
    const rows = posRows.filter((p) => String(p?.symbol || "").toUpperCase() === sym);
    return rows.reduce((a, p) => a + Number(p?.unrealizedPnl ?? p?.unrealizedPnL ?? 0), 0);
  };
  const notional = (sym: string) => {
    const rows = posRows.filter((p) => String(p?.symbol || "").toUpperCase() === sym);
    return rows.reduce((a, p) => {
      const q = Number(p?.qty ?? 0);
      const px = Number(p?.markPrice ?? p?.entryPrice ?? 0);
      return a + Math.abs(q * px);
    }, 0);
  };
  const lastTradeTs = (sym: string) => {
    const t = (Array.isArray(trades) ? trades : []).filter((x) => String(x?.symbol || "").toUpperCase() === sym);
    let max = 0;
    for (const o of t) {
      const ts = Date.parse(String(o?.ts ?? o?.openedAt ?? "")) || Number(o?.ts ?? 0);
      if (Number.isFinite(ts) && ts > max) max = ts;
    }
    return max;
  };
  const arr = [...uniq];
  switch (sort) {
    case "UNREALIZED_PNL_DESC":
      return arr.sort((a, b) => pnl(b) - pnl(a));
    case "UNREALIZED_PNL_ASC":
      return arr.sort((a, b) => pnl(a) - pnl(b));
    case "NOTIONAL_DESC":
      return arr.sort((a, b) => notional(b) - notional(a));
    case "NOTIONAL_ASC":
      return arr.sort((a, b) => notional(a) - notional(b));
    case "RECENT_TRADE":
      return arr.sort((a, b) => lastTradeTs(b) - lastTradeTs(a));
    case "SYMBOL_ASC":
    default:
      return arr.sort((a, b) => a.localeCompare(b));
  }
}

export function RestCandleTile({
  symbol,
  dark,
  pollMs = POLL_MS,
  onSelect,
}: {
  symbol: string;
  dark: boolean;
  pollMs?: number;
  /** When set, tile is clickable (e.g. promote to main chart). */
  onSelect?: (symbol: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  const load = useCallback(async () => {
    const sym = String(symbol || "").toUpperCase();
    if (!sym) return;
    try {
      const r = await api.marketCandles({ hours: 12, symbol: sym });
      const candles = Array.isArray(r?.candles) ? r.candles : [];
      const data = candles
        .map((c: any) => ({
          time: Math.floor(Number(c.ts) / 1000) as import("lightweight-charts").UTCTimestamp,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
        }))
        .filter(
          (b: any) =>
            Number.isFinite(b.time) &&
            Number.isFinite(b.open) &&
            Number.isFinite(b.high) &&
            Number.isFinite(b.low) &&
            Number.isFinite(b.close),
        );
      if (seriesRef.current && data.length) {
        seriesRef.current.setData(data);
        chartRef.current?.timeScale().fitContent();
      }
    } catch {
      /* ignore */
    }
  }, [symbol]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), pollMs);
    return () => window.clearInterval(id);
  }, [load, pollMs]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const chart = createChart(el, {
      height: TILE_H,
      layout: {
        background: { type: ColorType.Solid, color: dark ? "#0f172a" : "#f8fafc" },
        textColor: dark ? "#e2e8f0" : "#0f172a",
      },
      grid: {
        vertLines: { color: dark ? "#1e293b" : "#e2e8f0" },
        horzLines: { color: dark ? "#1e293b" : "#e2e8f0" },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
      crosshair: { vertLine: { labelVisible: true }, horzLine: { labelVisible: true } },
    });
    const series = chart.addCandlestickSeries({
      upColor: "#34d399",
      downColor: "#fb7185",
      borderVisible: false,
      wickUpColor: "#34d399",
      wickDownColor: "#fb7185",
    });
    chartRef.current = chart;
    seriesRef.current = series;
    const ro = new ResizeObserver(() => {
      try {
        chart.applyOptions({ width: el.clientWidth });
      } catch {
        /* ignore */
      }
    });
    ro.observe(el);
    chart.applyOptions({ width: el.clientWidth });
    queueMicrotask(() => void load());
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [dark, load, symbol]);

  return (
    <div
      className={`flex min-h-0 min-w-0 flex-col rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/50 ${
        onSelect ? "cursor-pointer transition hover:ring-2 hover:ring-sky-500/40" : ""
      }`}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={onSelect ? () => onSelect(symbol) : undefined}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(symbol);
              }
            }
          : undefined
      }
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-700 dark:border-slate-700 dark:text-slate-200">
        <span className="font-mono">{symbol}</span>
        <span className="text-slate-500 dark:text-slate-400">REST · {TILE_H}px</span>
      </div>
      <div ref={wrapRef} className="w-full" style={{ height: TILE_H }} />
    </div>
  );
}

/**
 * Up to 4 live REST charts per page; pagination + sort for tile order.
 * Symbols = union of manual pins and any symbol with an open position (AUTO multi autotrade).
 */
export function MultiChartGrid() {
  const bot = useAppStore((s) => s.bot);
  const positions = useAppStore((s) => s.positions);
  const trades = useAppStore((s) => s.trades);
  const theme = useThemeStore((s) => s.theme);
  const dark = theme === "dark";
  const pinManual = String(bot?.universePinControl || "").toUpperCase() === "MANUAL";

  const rawSyms = useMemo(() => {
    const pins = Array.isArray(bot?.universePinnedSymbols)
      ? bot.universePinnedSymbols.map((x) => String(x || "").trim().toUpperCase()).filter(Boolean)
      : [];
    const fromPos = (Array.isArray(positions) ? positions : [])
      .map((p) => String(p?.symbol || "").toUpperCase().trim())
      .filter(Boolean);
    const merged = [...new Set([...pins, ...fromPos])];
    return merged.slice(0, 24);
  }, [bot?.universePinnedSymbols, positions]);

  const [sort, setSort] = useState<ChartGridSort>(() => loadLs(GRID_SORT_LS, "UNREALIZED_PNL_DESC") as ChartGridSort);
  const [page, setPage] = useState(() => Math.max(0, parseInt(loadLs(GRID_PAGE_LS, "0"), 10) || 0));

  useEffect(() => {
    saveLs(GRID_SORT_LS, sort);
  }, [sort]);
  useEffect(() => {
    saveLs(GRID_PAGE_LS, String(page));
  }, [page]);

  const sorted = useMemo(() => sortPinnedSymbols(rawSyms, sort, positions, trades), [rawSyms, sort, positions, trades]);
  const perPage = 4;
  const maxPage = Math.max(0, Math.ceil(sorted.length / perPage) - 1);
  const safePage = Math.min(page, maxPage);
  const slice = sorted.slice(safePage * perPage, safePage * perPage + perPage);

  useEffect(() => {
    if (page > maxPage) setPage(maxPage);
  }, [page, maxPage]);

  if (rawSyms.length === 0) return null;

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-100/95 p-3 shadow-glow-light dark:border-slate-800 dark:bg-slate-950/60 dark:shadow-glow">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
          Multi-coin charts
          <span className="ml-1 font-normal text-slate-500 dark:text-slate-400">
            ({pinManual ? "pins + open positions" : "open positions"})
          </span>
        </div>
        <label className="flex flex-wrap items-center gap-1 text-[11px] text-slate-600 dark:text-slate-400">
          Order
          <select
            className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] dark:border-slate-600 dark:bg-slate-900"
            value={sort}
            onChange={(e) => setSort(e.target.value as ChartGridSort)}
          >
            <option value="UNREALIZED_PNL_DESC">Highest unrealized PnL</option>
            <option value="UNREALIZED_PNL_ASC">Lowest unrealized PnL</option>
            <option value="NOTIONAL_DESC">Highest notional (est.)</option>
            <option value="NOTIONAL_ASC">Lowest notional (est.)</option>
            <option value="RECENT_TRADE">Most recent trade</option>
            <option value="SYMBOL_ASC">Symbol A–Z</option>
          </select>
        </label>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {slice.map((sym) => (
          <RestCandleTile key={sym} symbol={sym} dark={dark} />
        ))}
      </div>
      {sorted.length > perPage ? (
        <div className="mt-2 flex items-center justify-center gap-2 text-[11px] text-slate-600 dark:text-slate-400">
          <button
            type="button"
            className="rounded border border-slate-300 px-2 py-1 font-semibold hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:hover:bg-slate-900"
            disabled={safePage <= 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Prev 4
          </button>
          <span>
            Page {safePage + 1} / {maxPage + 1} ({sorted.length} coins)
          </span>
          <button
            type="button"
            className="rounded border border-slate-300 px-2 py-1 font-semibold hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:hover:bg-slate-900"
            disabled={safePage >= maxPage}
            onClick={() => setPage((p) => Math.min(maxPage, p + 1))}
          >
            Next 4
          </button>
        </div>
      ) : null}
    </div>
  );
}
