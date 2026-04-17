import { useEffect, useMemo, useRef, useState } from "react";
import { createChart, LineStyle, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import {
  DEFAULT_TRAIL_FEE_BE_MULTIPLIER,
  buildTieredStEquidistantLockRows,
  buildTrailLockPrices,
  clampFeeRate,
  computeEffectiveTrailBuffer,
  defaultTieredPostT02SpacingFrac,
  feeRateBreakevenPadded,
  type TrailLockRow,
} from "../lib/trailingFeeLadder";

type Candle = { ts: number; open: number; high: number; low: number; close: number; volume: number };

type TrailBufferMode = "PERCENT" | "ATR";

export type TrailPreviewCfg = {
  futuresTrailingStopMode: "SUPERTREND" | "FEE_LADDER";
  futuresTrailingStFeeBreakeven: boolean;
  futuresTrailingStAdvanced: boolean;

  trailOpenFeeRate: number;
  trailCloseFeeRate: number;
  trailFeeBeMultiplier: number;

  trailActivationSlippageFrac: number;

  trailBufferMode: TrailBufferMode;
  trailBufferRate: number;
  trailBufferAtrMult: number;

  trailMaintMarginRate: number;
  trailMinSlDistFrac: number;
  trailMinGapFromMarkFrac: number;
  trailPostT02SpacingFrac: number | null;
  trailPostT02MaxExtraTiers: number;

  trailingStopExtraScalpingPcts: number[];
};

type PreviewPoint = {
  id: string;
  label: string;
  lockPx: number | null;
  activationPx: number | null;
};

function fmtPx(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(Number(x)) || Number(x) <= 0) return "—";
  const n = Number(x);
  if (n >= 1000) return n.toFixed(2);
  if (n >= 10) return n.toFixed(4);
  return n.toFixed(6);
}

function uniqSyms(syms: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of syms.map((x) => String(x || "").trim().toUpperCase()).filter(Boolean)) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function clampNum(x: number, min: number, max: number): number {
  const n = Number(x);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function NumericTextInput({
  value,
  onCommit,
  min,
  max,
  decimals,
  pct,
  disabled,
  title,
}: {
  value: number;
  onCommit: (v: number) => void;
  min: number;
  max: number;
  decimals: number;
  pct: boolean;
  disabled?: boolean;
  title?: string;
}) {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const shown = focused && draft != null ? draft : String(value);
  useEffect(() => {
    // Do not clobber the user's in-progress typing when other preview fields update.
    if (!focused) setDraft(null);
  }, [value, focused]);
  const commit = () => {
    const raw = (draft ?? String(value)).replace(/,/g, ".").trim();
    if (raw === "" || raw === "-" || raw === ".") {
      setFocused(false);
      setDraft(null);
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      setFocused(false);
      setDraft(null);
      return;
    }
    const clamped = clampNum(n, min, max);
    onCommit(pct ? clamped / 100 : clamped);
    setFocused(false);
    setDraft(null);
  };
  return (
    <input
      value={shown}
      disabled={disabled}
      title={title}
      className="w-full rounded border border-sky-200 bg-white px-1.5 py-0.5 text-right text-[10px] tabular-nums dark:border-sky-700 dark:bg-slate-900"
      onFocus={() => {
        setFocused(true);
        setDraft(String(value));
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setFocused(false);
          setDraft(null);
        }
      }}
      inputMode="decimal"
    />
  );
}

function effectivePreviewBuffer(cfg: TrailPreviewCfg, atrPct: number | null): number {
  return computeEffectiveTrailBuffer({
    bufferRate: cfg.trailBufferRate,
    trailBufferMode: cfg.trailBufferMode,
    trailBufferAtrMult: cfg.trailBufferAtrMult,
    atrPct: atrPct ?? null,
  });
}

function buildFirstTenPreviewPoints(p: {
  cfg: TrailPreviewCfg;
  entryPx: number;
  isLong: boolean;
  atrPct: number | null;
}): PreviewPoint[] {
  const { cfg, entryPx: E, isLong, atrPct } = p;
  if (!Number.isFinite(E) || E <= 0) return [];

  const buf = effectivePreviewBuffer(cfg, atrPct);
  const openR = clampFeeRate(cfg.trailOpenFeeRate);
  const closeR = clampFeeRate(cfg.trailCloseFeeRate);
  const rtFee = openR + closeR;

  const feeBeBase = feeRateBreakevenPadded(rtFee, cfg.trailFeeBeMultiplier ?? DEFAULT_TRAIL_FEE_BE_MULTIPLIER);
  const feeBeSt = Math.min(0.02, feeBeBase + clampNum(cfg.trailActivationSlippageFrac ?? 0, 0, 0.01));

  if (cfg.futuresTrailingStopMode === "FEE_LADDER") {
    const levels = buildTrailLockPrices(E, isLong, closeR, cfg.trailingStopExtraScalpingPcts ?? [], {
      openFeeRate: openR,
      closeFeeRate: closeR,
      feeBeMultiplier: cfg.trailFeeBeMultiplier,
    });
    const pts: PreviewPoint[] = [];
    for (let i = 0; i < Math.min(10, levels.length); i++) {
      const row = levels[i]!;
      const lockPx = Number(row.lockPx);
      const activationPx = Number.isFinite(lockPx) && lockPx > 0 ? (isLong ? lockPx * (1 + buf) : lockPx * (1 - buf)) : null;
      pts.push({ id: `FEE_${row.tierLabel ?? i}`, label: row.tierLabel ?? `T${i}`, lockPx, activationPx });
    }
    return pts;
  }

  // SUPERTREND preview:
  // - With Fee BE + Advanced ON: show tiered gates (T01, T02, then T1..T8) derived from entry + feeBeSt + post‑T02 spacing.
  // - Otherwise: show only basic BE/activation reference points (no post‑T02 tiers).
  if (!(cfg.futuresTrailingStFeeBreakeven && cfg.futuresTrailingStAdvanced)) {
    const beLock = isLong ? E * (1 + feeBeSt) : E * (1 - feeBeSt);
    const act = isLong ? E * (1 + feeBeSt + buf) : E * (1 - feeBeSt - buf);
    return [
      { id: "ST_BE", label: "BE", lockPx: beLock, activationPx: act },
      { id: "ST_ENTRY", label: "ENTRY", lockPx: E, activationPx: isLong ? E * (1 + buf) : E * (1 - buf) },
    ].slice(0, 10);
  }

  const spUser = cfg.trailPostT02SpacingFrac != null && Number.isFinite(Number(cfg.trailPostT02SpacingFrac)) ? Number(cfg.trailPostT02SpacingFrac) : null;
  const sp = spUser != null && spUser > 0 ? Math.min(0.05, spUser) : defaultTieredPostT02SpacingFrac(rtFee);
  const tierLocks = buildTieredStEquidistantLockRows(E, isLong, feeBeSt, sp, 16);

  const pts: PreviewPoint[] = [];
  for (const row of tierLocks) {
    if (pts.length >= 10) break;
    const lockPx = Number(row.lockPx);
    const activationPx = Number.isFinite(lockPx) && lockPx > 0 ? (isLong ? lockPx * (1 + buf) : lockPx * (1 - buf)) : null;
    pts.push({
      id: `ST_${row.tierLabel}`,
      label: String(row.tierLabel),
      lockPx,
      activationPx,
    });
  }
  return pts;
}

function pointsDefaultSelection(points: PreviewPoint[]): string[] {
  // Default: show the next meaningful rungs: T01, T02, T1, T2 if they exist.
  const want = new Set(["T01", "T02", "T1", "T2", "T0"]);
  const out = points.filter((p) => want.has(p.label)).map((p) => p.id);
  return out.length ? out : points.slice(0, 4).map((p) => p.id);
}

export function TrailPreviewModal({
  open,
  onClose,
  initialCfg,
  initialSymbol,
  initialTimeframe,
  cachedCandlesBySymbol,
  cachedAtrPctBySymbol,
}: {
  open: boolean;
  onClose: () => void;
  initialCfg: TrailPreviewCfg;
  initialSymbol: string;
  initialTimeframe: string;
  /** No fetch: only data already in memory should be passed in. */
  cachedCandlesBySymbol: Record<string, Candle[]>;
  cachedAtrPctBySymbol?: Record<string, number | null | undefined>;
}) {
  const symFixed = String(initialSymbol || "").toUpperCase();
  const syms = useMemo(() => uniqSyms(Object.keys(cachedCandlesBySymbol || {}).concat([symFixed])), [cachedCandlesBySymbol, symFixed]);
  const [sym, setSym] = useState(symFixed);
  const [cfg, setCfg] = useState<TrailPreviewCfg>(initialCfg);
  const [isLong, setIsLong] = useState(true);

  // Entry snapshot is pegged to "open time" for the selected symbol (or when symbol changes inside modal).
  const [entryTs, setEntryTs] = useState<number>(() => Date.now());
  const [entryPx, setEntryPx] = useState<number>(() => {
    const cs = cachedCandlesBySymbol?.[String(initialSymbol || "").toUpperCase()] ?? [];
    const last = cs.length ? cs[cs.length - 1]!.close : NaN;
    return Number.isFinite(last) && last > 0 ? last : 0;
  });

  useEffect(() => {
    if (!open) return;
    // Reset only on open: keep coin fixed for the session.
    const s = symFixed;
    setSym(s);
    setCfg(initialCfg);
    setIsLong(true);
    const cs = cachedCandlesBySymbol?.[s] ?? [];
    const last = cs.length ? Number(cs[cs.length - 1]!.close) : NaN;
    setEntryTs(Date.now());
    setEntryPx(Number.isFinite(last) && last > 0 ? last : 0);
  }, [open, initialCfg, symFixed, cachedCandlesBySymbol]);

  const candles = cachedCandlesBySymbol?.[sym] ?? [];
  const atrPct = cachedAtrPctBySymbol?.[sym] != null ? Number(cachedAtrPctBySymbol?.[sym]) : null;

  // If symbol changes, re-snapshot entry from that symbol's cached last close.
  useEffect(() => {
    if (!open) return;
    const cs = cachedCandlesBySymbol?.[sym] ?? [];
    const last = cs.length ? Number(cs[cs.length - 1]!.close) : NaN;
    setEntryTs(Date.now());
    setEntryPx(Number.isFinite(last) && last > 0 ? last : 0);
  }, [sym, open, cachedCandlesBySymbol]);

  const points = useMemo(() => buildFirstTenPreviewPoints({ cfg, entryPx, isLong, atrPct }), [cfg, entryPx, isLong, atrPct]);
  const [selectedIds, setSelectedIds] = useState<string[]>(() => pointsDefaultSelection(points));
  useEffect(() => {
    if (!open) return;
    setSelectedIds((prev) => (prev.length ? prev : pointsDefaultSelection(points)));
  }, [points, open]);

  const selected = useMemo(() => {
    const want = new Set(selectedIds);
    return points.filter((p) => want.has(p.id));
  }, [points, selectedIds]);

  const chartWrapRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRefs = useRef<{ candles?: any; entry?: any; lines: any[] }>({ lines: [] });
  const disposedRef = useRef(false);
  const didFitRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    if (!chartWrapRef.current) return;
    disposedRef.current = false;
    didFitRef.current = false;
    // Create chart once per open.
    const root = chartWrapRef.current;
    const chart = createChart(root, {
      height: 420,
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#94a3b8" },
      grid: { vertLines: { color: "rgba(148,163,184,0.08)" }, horzLines: { color: "rgba(148,163,184,0.08)" } },
      rightPriceScale: { borderVisible: false, autoScale: true },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 2,
        barSpacing: 7,
        minBarSpacing: 2,
        fixLeftEdge: true,
        fixRightEdge: true,
        lockVisibleTimeRangeOnResize: true,
      },
      crosshair: { mode: 1 },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    });
    chartRef.current = chart;
    const cs = chart.addCandlestickSeries({
      upColor: "#16a34a",
      downColor: "#ef4444",
      wickUpColor: "#16a34a",
      wickDownColor: "#ef4444",
      borderVisible: false,
    });
    seriesRefs.current.candles = cs;
    const entry = chart.addLineSeries({ color: "#38bdf8", lineWidth: 2, lineStyle: LineStyle.Solid, priceLineVisible: true });
    seriesRefs.current.entry = entry;
    return () => {
      disposedRef.current = true;
      try {
        chart.remove();
      } catch {
        /* ignore */
      }
      chartRef.current = null;
      seriesRefs.current = { lines: [] };
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const cs = seriesRefs.current.candles;
    const entryS = seriesRefs.current.entry;
    const chart = chartRef.current;
    if (!cs || !entryS || !chart) return;

    try {
      // Candles: recent only (no fetch).
      const data = (candles || [])
        .slice(-500)
        .map((c) => ({ time: Math.floor(c.ts / 1000) as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }));
      cs.setData(data);

      // Entry: horizontal line across entire chart.
      if (Number.isFinite(entryPx) && entryPx > 0 && data.length) {
        const firstT = data[0]!.time;
        const lastT = data[data.length - 1]!.time;
        entryS.setData([
          { time: firstT, value: entryPx },
          { time: lastT, value: entryPx },
        ]);
      } else {
        entryS.setData([]);
      }

      // Clear old point series.
      for (const s of seriesRefs.current.lines) {
        try {
          chart.removeSeries(s);
        } catch {
          /* ignore */
        }
      }
      seriesRefs.current.lines = [];

      const firstT = data.length ? data[0]!.time : (Math.floor(Date.now() / 1000) as UTCTimestamp);
      const lastT = data.length ? data[data.length - 1]!.time : (Math.floor(Date.now() / 1000) as UTCTimestamp);

      // Selected points: lock (solid) + activation (dotted).
      const mkLine = (px: number, color: string, style: LineStyle) => {
        try {
          const s = chart.addLineSeries({ color, lineWidth: 1, lineStyle: style, priceLineVisible: false });
          s.setData([
            { time: firstT, value: px },
            { time: lastT, value: px },
          ]);
          seriesRefs.current.lines.push(s);
        } catch {
          /* ignore */
        }
      };
      for (const p of selected) {
        if (p.lockPx != null && Number.isFinite(p.lockPx) && p.lockPx > 0) mkLine(p.lockPx, "rgba(148,163,184,0.90)", LineStyle.Solid);
        if (p.activationPx != null && Number.isFinite(p.activationPx) && p.activationPx > 0) mkLine(p.activationPx, "rgba(56,189,248,0.75)", LineStyle.Dotted);
      }

      // Fit only once per modal open; do not fight user pan/zoom afterward.
      if (!disposedRef.current && !didFitRef.current) {
        try {
          chart.timeScale().fitContent();
          didFitRef.current = true;
        } catch {
          /* ignore */
        }
      }
    } catch {
      // Never allow preview to crash the whole UI.
    }
  }, [open, candles, entryPx, selected]);

  if (!open) return null;

  const hasCandles = Array.isArray(candles) && candles.length >= 20;
  const bufEff = effectivePreviewBuffer(cfg, atrPct);

  return (
    <div className="fixed inset-0 z-[120] overflow-y-auto bg-black/50 p-2 sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="mx-auto my-2 flex max-h-[92vh] w-[min(1100px,96vw)] flex-col overflow-hidden rounded-xl border border-sky-200 bg-white shadow-2xl dark:border-sky-800 dark:bg-slate-950"
      >
        <div className="sticky top-0 z-[1] flex items-center justify-between border-b border-sky-200/70 bg-sky-50/80 px-3 py-2 backdrop-blur dark:border-sky-800/50 dark:bg-slate-950/80">
          <div className="min-w-0">
            <div className="text-[12px] font-bold text-slate-900 dark:text-slate-50">Trail preview</div>
            <div className="text-[10px] text-slate-600 dark:text-slate-400">
              Cached chart only (no forced refresh). Entry snapshot: {new Date(entryTs).toLocaleTimeString()} · entry {fmtPx(entryPx)} · effective buffer{" "}
              {(bufEff * 100).toFixed(3)}%
            </div>
          </div>
          <button
            className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="grid flex-1 grid-cols-1 gap-0 overflow-hidden md:grid-cols-[1.2fr_0.8fr]">
          <div className="min-h-0 overflow-auto border-b border-sky-200/60 p-3 dark:border-sky-800/40 md:border-b-0 md:border-r">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <div className="text-[10px] font-semibold text-slate-700 dark:text-slate-300">Coin</div>
              <div className="rounded border border-sky-200 bg-white px-2 py-1 text-[11px] font-mono text-slate-800 dark:border-sky-800 dark:bg-slate-900 dark:text-slate-100">
                {sym}
              </div>
              <div className="ml-auto flex items-center gap-3 text-[10px] text-slate-600 dark:text-slate-400">
                <span className="font-mono">{initialTimeframe}</span>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={isLong} onChange={(e) => setIsLong(e.currentTarget.checked)} />
                  Long
                </label>
              </div>
            </div>

            {!hasCandles ? (
              <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
                No cached candles for <span className="font-mono">{sym}</span>. Open that coin on the main chart first, then re-open preview.
              </div>
            ) : (
              <div className="relative">
                <div
                  ref={chartWrapRef}
                  className="h-[min(420px,48vh)] w-full touch-none rounded-lg border border-sky-200/60 bg-white/60 dark:border-sky-800/40 dark:bg-slate-950/40"
                />
                <button
                  type="button"
                  className="absolute right-2 top-2 rounded border border-slate-300 bg-white/80 px-2 py-1 text-[10px] font-semibold text-slate-700 shadow-sm hover:bg-white dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-200 dark:hover:bg-slate-900"
                  onClick={() => {
                    const chart = chartRef.current;
                    if (!chart) return;
                    try {
                      chart.timeScale().fitContent();
                      didFitRef.current = true;
                    } catch {
                      /* ignore */
                    }
                  }}
                  title="Reset view to show all cached candles"
                >
                  Fit
                </button>
              </div>
            )}

            <div className="mt-2 text-[10px] text-slate-600 dark:text-slate-400">
              Lines: <span className="text-slate-700 dark:text-slate-300">grey</span> = lock,{" "}
              <span className="text-sky-700 dark:text-sky-300">blue dotted</span> = activation,{" "}
              <span className="text-sky-500">cyan</span> = entry.
            </div>
          </div>

          <div className="min-h-0 overflow-auto p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="text-[11px] font-semibold text-slate-900 dark:text-slate-100">Preview settings</div>
              <div className="text-[10px] text-slate-500 dark:text-slate-400">
                Mode: <span className="font-mono">{cfg.futuresTrailingStopMode}</span>
              </div>
            </div>

            <div className="mt-2 space-y-2">
              <div className="rounded border border-sky-200/60 bg-white/60 p-2 dark:border-sky-800/40 dark:bg-slate-950/40">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-sky-800/70 dark:text-sky-300/50">Calculation</div>
                <div className="flex flex-wrap gap-3 text-[10px] text-slate-700 dark:text-slate-300">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="trail-prev-mode"
                      checked={cfg.futuresTrailingStopMode === "SUPERTREND"}
                      onChange={() => setCfg((p0) => ({ ...p0, futuresTrailingStopMode: "SUPERTREND" }))}
                    />
                    Supertrend-based
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="trail-prev-mode"
                      checked={cfg.futuresTrailingStopMode === "FEE_LADDER"}
                      onChange={() => setCfg((p0) => ({ ...p0, futuresTrailingStopMode: "FEE_LADDER" }))}
                    />
                    Fee ladder
                  </label>
                </div>
              </div>

              {cfg.futuresTrailingStopMode === "SUPERTREND" ? (
                <div className="rounded border border-sky-200/60 bg-white/60 p-2 dark:border-sky-800/40 dark:bg-slate-950/40">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-sky-800/70 dark:text-sky-300/50">
                    Supertrend toggles
                  </div>
                  <div className="space-y-1.5 text-[10px] text-slate-700 dark:text-slate-300">
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={cfg.futuresTrailingStFeeBreakeven}
                        onChange={(e) => setCfg((p0) => ({ ...p0, futuresTrailingStFeeBreakeven: e.currentTarget.checked }))}
                      />
                      <span>
                        <span className="font-semibold text-slate-800 dark:text-slate-200">Fee breakeven (T01 / T02)</span>
                        <span className="mt-0.5 block text-[10px] text-slate-600 dark:text-slate-400">
                          Enables tier gates: <span className="font-mono">T01 → T02</span> before Supertrend trailing.
                        </span>
                      </span>
                    </label>
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={cfg.futuresTrailingStAdvanced}
                        onChange={(e) => setCfg((p0) => ({ ...p0, futuresTrailingStAdvanced: e.currentTarget.checked }))}
                      />
                      <span>
                        <span className="font-semibold text-slate-800 dark:text-slate-200">Advanced trailing (T1, T2…)</span>
                        <span className="mt-0.5 block text-[10px] text-slate-600 dark:text-slate-400">
                          Post‑T02 tiers use equal spacing from the T02 lock (not fee ladder’s T0/T1 interval).
                        </span>
                      </span>
                    </label>
                  </div>
                </div>
              ) : null}

              <div className="rounded border border-sky-200/60 bg-white/60 p-2 dark:border-sky-800/40 dark:bg-slate-950/40">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-sky-800/70 dark:text-sky-300/50">Fees / buffer</div>
                <div className="grid grid-cols-[1fr_76px] items-center gap-2 text-[10px]">
                  <div className="text-slate-700 dark:text-slate-300" title="Open fee (fraction).">
                    Open fee (%)
                  </div>
                  <NumericTextInput
                    value={+(cfg.trailOpenFeeRate * 100).toFixed(4)}
                    pct
                    min={0}
                    max={1}
                    decimals={4}
                    onCommit={(v) => setCfg((p0) => ({ ...p0, trailOpenFeeRate: clampNum(v, 0, 0.01) }))}
                    title="Open fee rate (percent)."
                  />

                  <div className="text-slate-700 dark:text-slate-300" title="Close fee (fraction).">
                    Close fee (%)
                  </div>
                  <NumericTextInput
                    value={+(cfg.trailCloseFeeRate * 100).toFixed(4)}
                    pct
                    min={0}
                    max={1}
                    decimals={4}
                    onCommit={(v) => setCfg((p0) => ({ ...p0, trailCloseFeeRate: clampNum(v, 0, 0.01) }))}
                    title="Close fee rate (percent)."
                  />

                  <div className="text-slate-700 dark:text-slate-300" title="Safety multiplier on round-trip fee.">
                    Fee BE mult (×)
                  </div>
                  <NumericTextInput
                    value={+Number(cfg.trailFeeBeMultiplier).toFixed(2)}
                    pct={false}
                    min={1}
                    max={2}
                    decimals={2}
                    onCommit={(v) => setCfg((p0) => ({ ...p0, trailFeeBeMultiplier: clampNum(v, 1, 2) }))}
                    title="Safety multiplier."
                  />

                  <div className="text-slate-700 dark:text-slate-300" title="Added to padded fee for Supertrend tiered gates only.">
                    BE slip (%)
                  </div>
                  <NumericTextInput
                    value={+(cfg.trailActivationSlippageFrac * 100).toFixed(3)}
                    pct
                    min={0}
                    max={1}
                    decimals={3}
                    onCommit={(v) => setCfg((p0) => ({ ...p0, trailActivationSlippageFrac: clampNum(v, 0, 0.01) }))}
                    title="Slippage add-on (percent)."
                  />
                </div>

                <div className="mt-2 rounded border border-sky-200/60 bg-white/70 p-2 dark:border-sky-800/40 dark:bg-slate-950/40">
                  <div className="mb-1 flex items-center justify-between">
                    <div className="text-[10px] font-semibold text-slate-800 dark:text-slate-200">Activation buffer</div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">
                      mode <span className="font-mono">{cfg.trailBufferMode}</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-3 text-[10px] text-slate-700 dark:text-slate-300">
                    <label className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name="trail-prev-bufmode"
                        checked={cfg.trailBufferMode === "PERCENT"}
                        onChange={() => setCfg((p0) => ({ ...p0, trailBufferMode: "PERCENT" }))}
                      />
                      Fixed %
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name="trail-prev-bufmode"
                        checked={cfg.trailBufferMode === "ATR"}
                        onChange={() => setCfg((p0) => ({ ...p0, trailBufferMode: "ATR" }))}
                      />
                      ATR × multiplier
                    </label>
                  </div>
                  <div className="mt-2 grid grid-cols-[1fr_76px] items-center gap-2 text-[10px]">
                    {cfg.trailBufferMode === "ATR" ? (
                      <>
                        <div className="text-slate-700 dark:text-slate-300">ATR mult</div>
                        <NumericTextInput
                          value={+Number(cfg.trailBufferAtrMult).toFixed(2)}
                          pct={false}
                          min={0}
                          max={1}
                          decimals={2}
                          onCommit={(v) => setCfg((p0) => ({ ...p0, trailBufferAtrMult: clampNum(v, 0, 1) }))}
                        />
                        <div className="text-slate-700 dark:text-slate-300" title="Used when atrPct missing.">
                          Fallback buf (%)
                        </div>
                        <NumericTextInput
                          value={+(cfg.trailBufferRate * 100).toFixed(3)}
                          pct
                          min={0}
                          max={5}
                          decimals={3}
                          onCommit={(v) => setCfg((p0) => ({ ...p0, trailBufferRate: clampNum(v, 0, 0.05) }))}
                        />
                      </>
                    ) : (
                      <>
                        <div className="text-slate-700 dark:text-slate-300">Buffer (%)</div>
                        <NumericTextInput
                          value={+(cfg.trailBufferRate * 100).toFixed(3)}
                          pct
                          min={0}
                          max={5}
                          decimals={3}
                          onCommit={(v) => setCfg((p0) => ({ ...p0, trailBufferRate: clampNum(v, 0, 0.05) }))}
                        />
                      </>
                    )}
                  </div>
                </div>
              </div>

              {cfg.futuresTrailingStopMode === "SUPERTREND" && cfg.futuresTrailingStAdvanced ? (
                <div className="rounded border border-sky-200/60 bg-white/60 p-2 dark:border-sky-800/40 dark:bg-slate-950/40">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-sky-800/70 dark:text-sky-300/50">
                    Advanced trailing parameters
                  </div>
                  <div className="grid grid-cols-[1fr_76px] items-center gap-2 text-[10px]">
                    <div className="text-slate-700 dark:text-slate-300">Min SL distance (%)</div>
                    <NumericTextInput
                      value={+(cfg.trailMinSlDistFrac * 100).toFixed(3)}
                      pct
                      min={0}
                      max={10}
                      decimals={3}
                      onCommit={(v) => setCfg((p0) => ({ ...p0, trailMinSlDistFrac: clampNum(v, 0, 0.1) }))}
                    />

                    <div className="text-slate-700 dark:text-slate-300">Min gap from mark (%)</div>
                    <NumericTextInput
                      value={+(cfg.trailMinGapFromMarkFrac * 100).toFixed(3)}
                      pct
                      min={0}
                      max={20}
                      decimals={3}
                      onCommit={(v) => setCfg((p0) => ({ ...p0, trailMinGapFromMarkFrac: clampNum(v, 0, 0.2) }))}
                    />

                    <div className="text-slate-700 dark:text-slate-300">Maint margin rate (%)</div>
                    <NumericTextInput
                      value={+(cfg.trailMaintMarginRate * 100).toFixed(3)}
                      pct
                      min={0}
                      max={10}
                      decimals={3}
                      onCommit={(v) => setCfg((p0) => ({ ...p0, trailMaintMarginRate: clampNum(v, 0, 0.1) }))}
                    />

                    <div className="text-slate-700 dark:text-slate-300">Post‑T02 step (% entry)</div>
                    <NumericTextInput
                      value={+(((cfg.trailPostT02SpacingFrac ?? 0) as number) * 100).toFixed(3)}
                      pct
                      min={0}
                      max={5}
                      decimals={3}
                      onCommit={(v) => {
                        const frac = clampNum(v, 0, 0.05);
                        setCfg((p0) => ({ ...p0, trailPostT02SpacingFrac: frac > 0 ? frac : null }));
                      }}
                      title="0 = auto spacing; else fixed % of entry between rungs"
                    />

                    <div className="text-slate-700 dark:text-slate-300">Max post‑T02 tiers</div>
                    <NumericTextInput
                      value={Math.max(10, Math.min(500, Math.floor(Number(cfg.trailPostT02MaxExtraTiers) || 150)))}
                      pct={false}
                      min={10}
                      max={500}
                      decimals={0}
                      onCommit={(v) => setCfg((p0) => ({ ...p0, trailPostT02MaxExtraTiers: Math.floor(clampNum(v, 10, 500)) }))}
                    />
                  </div>
                </div>
              ) : null}

              <div className="rounded border border-sky-200/60 bg-white/60 p-2 dark:border-sky-800/40 dark:bg-slate-950/40">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-sky-800/70 dark:text-sky-300/50">Points on chart</div>
                <div className="text-[10px] text-slate-600 dark:text-slate-400">Select up to 10 tier points (multiple select).</div>
                <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
                  {points.map((p) => {
                    const checked = selectedIds.includes(p.id);
                    const disabled = !checked && selectedIds.length >= 10;
                    return (
                      <label key={p.id} className="flex cursor-pointer items-center gap-2 text-[10px] text-slate-700 dark:text-slate-300">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={(e) => {
                            const on = e.currentTarget.checked;
                            setSelectedIds((prev) => {
                              if (on) {
                                if (prev.includes(p.id)) return prev;
                                if (prev.length >= 10) return prev;
                                return [...prev, p.id];
                              }
                              return prev.filter((x) => x !== p.id);
                            });
                          }}
                        />
                        <span className="min-w-[3.2rem] font-mono">{p.label}</span>
                        <span className="text-slate-500 dark:text-slate-400">L {fmtPx(p.lockPx)} · A {fmtPx(p.activationPx)}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

