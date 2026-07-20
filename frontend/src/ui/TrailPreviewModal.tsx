import { useEffect, useMemo, useRef, useState } from "react";
import { createChart, LineStyle, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import {
  DEFAULT_TRAIL_FEE_BE_MULTIPLIER,
  buildTrailLockPrices,
  clampFeeRate,
  computeDynamicT01LockFrac,
  computeDynamicTrailBuffer,
  computeEffectiveTrailBuffer,
  defaultTieredPostT02SpacingFrac,
  dynamicPostT02SpacingFrac,
  feeRateBreakevenPadded,
  resolveTrailSizingMode,
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
  /** Tiered T01: stop lock offset from entry (fraction of price). */
  trailT01LockSlippageFrac: number;

  trailBufferMode: TrailBufferMode;
  trailBufferRate: number;
  trailBufferAtrMult: number;

  /**
   * Independent activation buffer for post-T02 rungs (T1, T2, T3…). Fraction of price.
   * `null` = inherit `trailBufferRate` (legacy single-buffer behaviour). This decouples the
   * profit-rung pull-back cushion from the fee-recovery (T01/T02) cushion so users can, for
   * example, keep T01/T02 glued to entry while giving every profit rung a wider activation gap.
   */
  trailPostT02ActivationBufferRate: number | null;

  trailMaintMarginRate: number;
  trailMinSlDistFrac: number;
  trailMinGapFromMarkFrac: number;
  trailPostT02SpacingFrac: number | null;
  trailPostT02MaxExtraTiers: number;

  trailSizingMode: "FIXED_PCT" | "DYNAMIC";
  trailDynamicBeAtrMult: number;
  trailDynamicBeT01LockAtrMult: number;
  trailDynamicBeRegimeAdjust: boolean;
  trailDynamicBeRegimeLowMult: number;
  trailDynamicBeRegimeHighMult: number;
  trailDynamicAdvAtrHwmMult: number;
  trailDynamicAdvMfeGivebackFrac: number;
  trailDynamicAdvMfeMinR: number;
  trailDynamicAdvMergeSupertrend: boolean;
  trailDynamicAdvAtrSource: "ENTRY" | "ROLLING";
  trailDynamicAdvPostT02StepAtrMult: number;

  trailingStopExtraScalpingPcts: number[];
};

type PreviewPoint = {
  id: string;
  label: string;
  kind: "T01" | "T02" | "POST_T02" | "FEE_T0" | "FEE_T1" | "FEE_USER" | "ENTRY_REF" | "BE_REF";
  lockPx: number | null;
  activationPx: number | null;
  /** Human-readable formula for this tier (for the summary pane). */
  formula: string;
};

function fmtPx(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(Number(x)) || Number(x) <= 0) return "—";
  const n = Number(x);
  if (n >= 1000) return n.toFixed(2);
  if (n >= 10) return n.toFixed(4);
  return n.toFixed(6);
}

function fmtPct(x: number, digits = 3): string {
  const n = Number(x);
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
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

/** Shallow equality on the fields we round-trip to `api.botConfig`. Used for the dirty flag. */
function cfgEqual(a: TrailPreviewCfg, b: TrailPreviewCfg): boolean {
  const sameList = (x: number[], y: number[]): boolean => {
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (Number(x[i]) !== Number(y[i])) return false;
    return true;
  };
  return (
    a.futuresTrailingStopMode === b.futuresTrailingStopMode &&
    a.futuresTrailingStFeeBreakeven === b.futuresTrailingStFeeBreakeven &&
    a.futuresTrailingStAdvanced === b.futuresTrailingStAdvanced &&
    a.trailOpenFeeRate === b.trailOpenFeeRate &&
    a.trailCloseFeeRate === b.trailCloseFeeRate &&
    a.trailFeeBeMultiplier === b.trailFeeBeMultiplier &&
    a.trailActivationSlippageFrac === b.trailActivationSlippageFrac &&
    a.trailT01LockSlippageFrac === b.trailT01LockSlippageFrac &&
    a.trailBufferMode === b.trailBufferMode &&
    a.trailBufferRate === b.trailBufferRate &&
    a.trailBufferAtrMult === b.trailBufferAtrMult &&
    a.trailPostT02ActivationBufferRate === b.trailPostT02ActivationBufferRate &&
    a.trailMaintMarginRate === b.trailMaintMarginRate &&
    a.trailMinSlDistFrac === b.trailMinSlDistFrac &&
    a.trailMinGapFromMarkFrac === b.trailMinGapFromMarkFrac &&
    a.trailPostT02SpacingFrac === b.trailPostT02SpacingFrac &&
    a.trailPostT02MaxExtraTiers === b.trailPostT02MaxExtraTiers &&
    a.trailSizingMode === b.trailSizingMode &&
    a.trailDynamicBeAtrMult === b.trailDynamicBeAtrMult &&
    a.trailDynamicBeT01LockAtrMult === b.trailDynamicBeT01LockAtrMult &&
    a.trailDynamicBeRegimeAdjust === b.trailDynamicBeRegimeAdjust &&
    a.trailDynamicBeRegimeLowMult === b.trailDynamicBeRegimeLowMult &&
    a.trailDynamicBeRegimeHighMult === b.trailDynamicBeRegimeHighMult &&
    a.trailDynamicAdvAtrHwmMult === b.trailDynamicAdvAtrHwmMult &&
    a.trailDynamicAdvMfeGivebackFrac === b.trailDynamicAdvMfeGivebackFrac &&
    a.trailDynamicAdvMfeMinR === b.trailDynamicAdvMfeMinR &&
    a.trailDynamicAdvMergeSupertrend === b.trailDynamicAdvMergeSupertrend &&
    a.trailDynamicAdvAtrSource === b.trailDynamicAdvAtrSource &&
    a.trailDynamicAdvPostT02StepAtrMult === b.trailDynamicAdvPostT02StepAtrMult &&
    sameList(a.trailingStopExtraScalpingPcts, b.trailingStopExtraScalpingPcts)
  );
}

/**
 * Free-typed numeric input with blur/Enter commit.
 * - Owns its own "draft" string so in-progress edits are never clobbered by parent re-renders.
 * - On commit: clamps to `[min, max]` (for fraction mode, min/max are pre-scaled), applies decimals display logic.
 * - `pct=true` means the *display value* is percent (×100) while `onCommit` receives the fraction.
 */
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
  const display = useMemo(() => {
    const n = Number(value);
    if (!Number.isFinite(n)) return "";
    return n.toFixed(decimals);
  }, [value, decimals]);
  const shown = focused && draft != null ? draft : display;
  useEffect(() => {
    if (!focused) setDraft(null);
  }, [value, focused]);
  const commit = () => {
    const raw = (draft ?? display).replace(/,/g, ".").trim();
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
        setDraft(display);
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
  if (resolveTrailSizingMode(cfg) === "DYNAMIC") {
    return computeDynamicTrailBuffer({
      entryAtrPct: atrPct,
      trailDynamicBeAtrMult: cfg.trailDynamicBeAtrMult,
      trailDynamicBeRegimeAdjust: cfg.trailDynamicBeRegimeAdjust,
      trailDynamicBeRegimeLowMult: cfg.trailDynamicBeRegimeLowMult,
      trailDynamicBeRegimeHighMult: cfg.trailDynamicBeRegimeHighMult,
      fallbackBufferRate: cfg.trailBufferRate,
    });
  }
  return computeEffectiveTrailBuffer({
    bufferRate: cfg.trailBufferRate,
    trailBufferMode: cfg.trailBufferMode,
    trailBufferAtrMult: cfg.trailBufferAtrMult,
    atrPct: atrPct ?? null,
  });
}

/**
 * Compute the preview tier points — **matches the live backend semantics** in
 * `backend/src/lib/trailingStopLoss.js::applyTrailingStopBinanceMemory`:
 *
 * Tiered Supertrend (fee BE + advanced on):
 *   T01 lock       = entry × (1 ± trailT01LockSlippageFrac)      ← zero-loss point (entry)
 *   T01 activation = entry × (1 ± trailBufferRate)               ← when mark crosses this, T01 engages
 *   T02 lock       = entry × (1 ± feeBe)                         ← exact fee break-even (NO slipFrac)
 *   T02 activation = entry × (1 ± (feeBe + slipFrac + buffer))   ← activation includes execution cushion
 *   Post-T02 lock_k     = T02 lock ± k × spacingFrac × entry
 *   Post-T02 activation = lock_k × (1 ± postT02Buffer)           ← independent buffer (null = inherit main)
 *   feeBe = (openFee + closeFee) × feeBeMultiplier
 *
 * Supertrend fee-BE only (advanced off): single BE reference + entry reference.
 * Fee ladder: T0 = padded BE lock, T1 = 2× round-trip, T2+ = user scalp pcts; activation = lock × (1 ± buffer).
 */
function buildPreviewPoints(p: {
  cfg: TrailPreviewCfg;
  entryPx: number;
  isLong: boolean;
  atrPct: number | null;
}): PreviewPoint[] {
  const { cfg, entryPx: E, isLong, atrPct } = p;
  if (!Number.isFinite(E) || E <= 0) return [];

  const buf = effectivePreviewBuffer(cfg, atrPct);
  /**
   * Post-T02 buffer: uses the dedicated knob when set; otherwise inherits `buf` for
   * backward-compatible behaviour. T01/T02 always use `buf` (they are the fee-recovery tiers).
   */
  const postT02BufRaw = cfg.trailPostT02ActivationBufferRate;
  const postT02Buf =
    postT02BufRaw != null && Number.isFinite(Number(postT02BufRaw)) && Number(postT02BufRaw) >= 0
      ? Math.min(0.05, Number(postT02BufRaw))
      : buf;
  const openR = clampFeeRate(cfg.trailOpenFeeRate);
  const closeR = clampFeeRate(cfg.trailCloseFeeRate);
  const rtFee = openR + closeR;

  // Exact fee break-even (× multiplier) — used as the T02 LOCK anchor. Matches backend `feeBe`.
  const feeBe = feeRateBreakevenPadded(rtFee, cfg.trailFeeBeMultiplier ?? DEFAULT_TRAIL_FEE_BE_MULTIPLIER);
  // Activation padding for T02 ONLY; does NOT move the lock. Matches backend `feeBeSt` (activation only).
  const slipFrac = clampNum(cfg.trailActivationSlippageFrac ?? 0, 0, 0.01);
  const feeBeActGate = Math.min(0.02, feeBe + slipFrac);

  const t01Slip =
    resolveTrailSizingMode(cfg) === "DYNAMIC"
      ? computeDynamicT01LockFrac({
          entryAtrPct: atrPct,
          trailDynamicBeT01LockAtrMult: cfg.trailDynamicBeT01LockAtrMult,
          fixedT01LockSlipFrac: cfg.trailT01LockSlippageFrac ?? 0,
        })
      : clampNum(cfg.trailT01LockSlippageFrac ?? 0, 0, 0.01);
  const sign = isLong ? 1 : -1;
  const apply = (frac: number) => E * (1 + sign * frac);

  if (cfg.futuresTrailingStopMode === "FEE_LADDER") {
    // Fee ladder path: T0 (padded BE), T1 (2× RT), T2+ (user scalp %s). Activation = lock × (1 ± buffer).
    const levels = buildTrailLockPrices(E, isLong, closeR, cfg.trailingStopExtraScalpingPcts ?? [], {
      openFeeRate: openR,
      closeFeeRate: closeR,
      feeBeMultiplier: cfg.trailFeeBeMultiplier,
    });
    const out: PreviewPoint[] = [];
    for (let i = 0; i < levels.length; i++) {
      const row = levels[i]!;
      const lockPx = Number(row.lockPx);
      const act = Number.isFinite(lockPx) && lockPx > 0 ? (isLong ? lockPx * (1 + buf) : lockPx * (1 - buf)) : null;
      const tier = row.tierLabel ?? `T${i}`;
      let kind: PreviewPoint["kind"] = "FEE_USER";
      let formula = `lock = entry × (1 ${isLong ? "+" : "−"} ${fmtPct((lockPx - E) / E, 4)})`;
      if (row.kind === "fee_breakeven") {
        kind = "FEE_T0";
        formula = `lock = entry × (1 ${isLong ? "+" : "−"} ${fmtPct(feeBe, 4)})  [padded round-trip fee]`;
      } else if (row.kind === "fee_first_scalp") {
        kind = "FEE_T1";
        formula = `lock = entry × (1 ${isLong ? "+" : "−"} ${fmtPct(2 * rtFee, 4)})  [2 × round-trip fee]`;
      } else if (row.kind === "user_scalp" && row.pct != null) {
        kind = "FEE_USER";
        formula = `lock = entry × (1 ${isLong ? "+" : "−"} ${Number(row.pct).toFixed(3)}%)  [user scalp]`;
      }
      out.push({
        id: `FEE_${tier}`,
        label: tier,
        kind,
        lockPx,
        activationPx: act,
        formula,
      });
    }
    return out;
  }

  // SUPERTREND path.
  const tieredOn = cfg.futuresTrailingStFeeBreakeven && cfg.futuresTrailingStAdvanced;
  if (!tieredOn) {
    // Either fee-BE only, advanced only, or both off. Show reference anchors.
    const pts: PreviewPoint[] = [];
    if (cfg.futuresTrailingStFeeBreakeven) {
      pts.push({
        id: "ST_BE",
        label: "BE",
        kind: "BE_REF",
        lockPx: apply(feeBe),
        activationPx: apply(feeBeActGate + buf),
        formula: `lock = entry × (1 ${isLong ? "+" : "−"} ${fmtPct(feeBe, 4)})  ·  activation = entry × (1 ${
          isLong ? "+" : "−"
        } ${fmtPct(feeBeActGate + buf, 4)})`,
      });
    }
    pts.push({
      id: "ST_ENTRY",
      label: "ENTRY",
      kind: "ENTRY_REF",
      lockPx: E,
      activationPx: apply(buf),
      formula: `lock = entry  ·  activation = entry × (1 ${isLong ? "+" : "−"} ${fmtPct(buf, 4)})`,
    });
    return pts;
  }

  // Tiered T01 / T02 / post-T02.
  const spUser =
    cfg.trailPostT02SpacingFrac != null && Number.isFinite(Number(cfg.trailPostT02SpacingFrac))
      ? Number(cfg.trailPostT02SpacingFrac)
      : null;
  const sp =
    resolveTrailSizingMode(cfg) === "DYNAMIC"
      ? dynamicPostT02SpacingFrac(atrPct, cfg.trailDynamicAdvPostT02StepAtrMult)
      : spUser != null && spUser > 0
        ? Math.min(0.05, spUser)
        : defaultTieredPostT02SpacingFrac(rtFee);

  const t01Lock = apply(t01Slip);
  const t01Act = apply(buf);
  const t02Lock = apply(feeBe);
  const t02Act = apply(feeBeActGate + buf);

  const pts: PreviewPoint[] = [
    {
      id: "ST_T01",
      label: "T01",
      kind: "T01",
      lockPx: t01Lock,
      activationPx: t01Act,
      formula: `lock = entry × (1 ${isLong ? "+" : "−"} ${fmtPct(t01Slip, 4)})  ·  activation = entry × (1 ${
        isLong ? "+" : "−"
      } ${fmtPct(buf, 4)})`,
    },
    {
      id: "ST_T02",
      label: "T02",
      kind: "T02",
      lockPx: t02Lock,
      activationPx: t02Act,
      formula: `lock = entry × (1 ${isLong ? "+" : "−"} ${fmtPct(feeBe, 4)})  [exact BE]  ·  activation = entry × (1 ${
        isLong ? "+" : "−"
      } ${fmtPct(feeBeActGate + buf, 4)})`,
    },
  ];

  const maxExtra = Math.max(1, Math.min(20, Math.floor(Number(cfg.trailPostT02MaxExtraTiers) || 150)));
  const preview = Math.min(10, maxExtra);
  for (let k = 1; k <= preview; k++) {
    const lockPx = isLong ? t02Lock + k * E * sp : t02Lock - k * E * sp;
    if (!Number.isFinite(lockPx) || lockPx <= 0) break;
    const act = isLong ? lockPx * (1 + postT02Buf) : lockPx * (1 - postT02Buf);
    pts.push({
      id: `ST_T${k}`,
      label: `T${k}`,
      kind: "POST_T02",
      lockPx,
      activationPx: act,
      formula: `lock = T02_lock ${isLong ? "+" : "−"} ${k} × ${fmtPct(sp, 4)} × entry  ·  activation = lock × (1 ${
        isLong ? "+" : "−"
      } ${fmtPct(postT02Buf, 4)})`,
    });
  }

  return pts;
}

function pointsDefaultSelection(points: PreviewPoint[]): string[] {
  const want = ["T01", "T02", "T1", "T2", "T0", "BE", "ENTRY"];
  const prefIds: string[] = [];
  for (const w of want) {
    const found = points.find((p) => p.label === w);
    if (found && !prefIds.includes(found.id)) prefIds.push(found.id);
    if (prefIds.length >= 4) break;
  }
  return prefIds.length ? prefIds : points.slice(0, Math.min(4, points.length)).map((p) => p.id);
}

export function TrailPreviewModal({
  open,
  onClose,
  onApply,
  initialCfg,
  initialSymbol,
  initialTimeframe,
  cachedCandlesBySymbol,
  cachedAtrPctBySymbol,
}: {
  open: boolean;
  onClose: () => void;
  /** Called when the user clicks "Apply". Parent persists the returned cfg to backend. */
  onApply: (cfg: TrailPreviewCfg) => Promise<void> | void;
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
  const [baselineCfg, setBaselineCfg] = useState<TrailPreviewCfg>(initialCfg);
  const [isLong, setIsLong] = useState(true);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Entry snapshot is pegged to "open time" for the selected symbol (or when symbol changes inside modal).
  const [entryTs, setEntryTs] = useState<number>(() => Date.now());
  const [entryPx, setEntryPx] = useState<number>(() => {
    const cs = cachedCandlesBySymbol?.[String(initialSymbol || "").toUpperCase()] ?? [];
    const last = cs.length ? cs[cs.length - 1]!.close : NaN;
    return Number.isFinite(last) && last > 0 ? last : 0;
  });

  /**
   * CRITICAL: reset ONLY on the false → true transition of `open`. The previous implementation listed
   * `initialCfg` and `cachedCandlesBySymbol` (both new object identities each parent render) in the
   * effect deps, which re-fired this reset on every parent re-render and clobbered user edits → "edits
   * aren't accepted" from the user's point of view.
   */
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setSym(symFixed);
      setCfg(initialCfg);
      setBaselineCfg(initialCfg);
      setIsLong(true);
      setApplying(false);
      setApplyError(null);
      const cs = cachedCandlesBySymbol?.[symFixed] ?? [];
      const last = cs.length ? Number(cs[cs.length - 1]!.close) : NaN;
      setEntryTs(Date.now());
      setEntryPx(Number.isFinite(last) && last > 0 ? last : 0);
    }
    prevOpenRef.current = open;
  }, [open, symFixed, initialCfg, cachedCandlesBySymbol]);

  const candles = cachedCandlesBySymbol?.[sym] ?? [];
  const atrPct = cachedAtrPctBySymbol?.[sym] != null ? Number(cachedAtrPctBySymbol?.[sym]) : null;

  // If the user changes the symbol inside the modal, re-snapshot entry from that symbol's last cached close.
  // Does NOT reset cfg — the symbol dropdown is chart-scope only. Also resets the "fit once" flag so
  // the chart re-fits when a brand-new dataset is loaded (otherwise the old symbol's visible range
  // survives and the new symbol's candles can appear off-scale).
  useEffect(() => {
    if (!open) return;
    if (sym === symFixed && !prevOpenRef.current) return;
    const cs = cachedCandlesBySymbol?.[sym] ?? [];
    const last = cs.length ? Number(cs[cs.length - 1]!.close) : NaN;
    setEntryTs(Date.now());
    setEntryPx(Number.isFinite(last) && last > 0 ? last : 0);
    didFitRef.current = false;
  }, [sym, open, cachedCandlesBySymbol, symFixed]);

  const points = useMemo(() => buildPreviewPoints({ cfg, entryPx, isLong, atrPct }), [cfg, entryPx, isLong, atrPct]);
  const [selectedIds, setSelectedIds] = useState<string[]>(() => pointsDefaultSelection(points));

  /**
   * Prune stale ids whenever `points` changes (mode switch, advanced toggle, extras edit). If nothing
   * survives the prune, fall back to the default selection so the chart and list stay consistent.
   */
  useEffect(() => {
    if (!open) return;
    const valid = new Set(points.map((p) => p.id));
    setSelectedIds((prev) => {
      const kept = prev.filter((id) => valid.has(id));
      if (kept.length > 0) return kept.length === prev.length ? prev : kept;
      return pointsDefaultSelection(points);
    });
  }, [points, open]);

  const selected = useMemo(() => {
    const want = new Set(selectedIds);
    return points.filter((p) => want.has(p.id));
  }, [points, selectedIds]);

  const dirty = useMemo(() => !cfgEqual(cfg, baselineCfg), [cfg, baselineCfg]);

  // ---------- Chart lifecycle -------------------------------------------------
  const chartWrapRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRefs = useRef<{ candles?: ISeriesApi<"Candlestick">; entry?: ISeriesApi<"Line">; lines: ISeriesApi<"Line">[] }>({ lines: [] });
  const disposedRef = useRef(false);
  const didFitRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    if (!chartWrapRef.current) return;
    disposedRef.current = false;
    didFitRef.current = false;
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
        /**
         * `minBarSpacing: 0.5` lets the user zoom FAR out (fit 500+ candles comfortably).
         * The prior `2` combined with `fixLeftEdge / fixRightEdge / lockVisibleTimeRangeOnResize`
         * effectively pinned the range and made wheel zoom feel like a no-op.
         */
        minBarSpacing: 0.5,
        fixLeftEdge: false,
        fixRightEdge: false,
        lockVisibleTimeRangeOnResize: false,
      },
      crosshair: { mode: 1 },
      /**
       * `handleScroll.mouseWheel: false` — wheel must go to ZOOM, not horizontal pan.
       * When both `handleScroll.mouseWheel` and `handleScale.mouseWheel` are true, the scroll
       * handler wins and the user perceives "wheel does nothing useful / zoom is broken."
       * Horizontal pan is still available via click-drag (`pressedMouseMove`).
       */
      handleScroll: {
        mouseWheel: false,
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
    if (disposedRef.current) return;
    const cs = seriesRefs.current.candles;
    const entryS = seriesRefs.current.entry;
    const chart = chartRef.current;
    if (!cs || !entryS || !chart) return;

    try {
      const data = (candles || [])
        .slice(-500)
        .map((c) => ({ time: Math.floor(c.ts / 1000) as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }));
      cs.setData(data);

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

      // Nuke prior tier lines before adding fresh ones. Guard chart ops so a mode-toggle race
      // (which can unmount/remount the chart) cannot throw up through the React tree.
      for (const s of seriesRefs.current.lines) {
        try {
          chart.removeSeries(s);
        } catch {
          /* ignore */
        }
      }
      seriesRefs.current.lines = [];

      /**
       * Tier lines anchor to the candle time range. When there are 0/1 candles (empty cache or
       * still-filling buffer) there's no meaningful range, and lightweight-charts rejects a line
       * series whose two points share the same timestamp — so skip drawing tier lines in that
       * case. The "no data" overlay is already shown above the empty chart.
       */
      if (data.length >= 2) {
        const firstT = data[0]!.time;
        const lastT = data[data.length - 1]!.time;

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
          const lockColor =
            p.kind === "T01"
              ? "rgba(16,185,129,0.95)"
              : p.kind === "T02"
                ? "rgba(234,179,8,0.95)"
                : p.kind === "POST_T02" || p.kind === "FEE_USER" || p.kind === "FEE_T1"
                  ? "rgba(148,163,184,0.90)"
                  : "rgba(100,116,139,0.85)";
          if (p.lockPx != null && Number.isFinite(p.lockPx) && p.lockPx > 0) mkLine(p.lockPx, lockColor, LineStyle.Solid);
          if (p.activationPx != null && Number.isFinite(p.activationPx) && p.activationPx > 0)
            mkLine(p.activationPx, "rgba(56,189,248,0.75)", LineStyle.Dotted);
        }
      }

      if (!disposedRef.current && !didFitRef.current && data.length >= 2) {
        try {
          chart.timeScale().fitContent();
          didFitRef.current = true;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* never let preview crash the whole UI */
    }
  }, [open, candles, entryPx, selected]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const hasCandles = Array.isArray(candles) && candles.length >= 20;
  const bufEff = effectivePreviewBuffer(cfg, atrPct);

  const doRevert = () => {
    setCfg(baselineCfg);
    setApplyError(null);
  };

  const doApply = async () => {
    if (!dirty || applying) return;
    setApplying(true);
    setApplyError(null);
    try {
      await onApply(cfg);
      setApplying(false);
      onClose();
    } catch (e) {
      setApplying(false);
      setApplyError(String((e as Error)?.message || e));
    }
  };

  return (
    <div className="fixed inset-0 z-[120] overflow-y-auto bg-black/50 p-2 sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="mx-auto my-2 flex max-h-[92vh] w-[min(1100px,96vw)] flex-col overflow-hidden rounded-xl border border-sky-200 bg-white shadow-2xl dark:border-sky-800 dark:bg-slate-950"
      >
        <div className="sticky top-0 z-[1] flex items-center justify-between border-b border-sky-200/70 bg-sky-50/80 px-3 py-2 backdrop-blur dark:border-sky-800/50 dark:bg-slate-950/80">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="text-[12px] font-bold text-slate-900 dark:text-slate-50">Trailing stop preview</div>
              {dirty ? (
                <span
                  className="rounded-full border border-amber-300 bg-amber-100 px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-amber-800 dark:border-amber-700/40 dark:bg-amber-950/40 dark:text-amber-200"
                  title="These settings have not yet been applied to the live config."
                >
                  Unsaved changes
                </span>
              ) : null}
            </div>
            <div className="text-[10px] text-slate-600 dark:text-slate-400">
              Preview-only until Apply. Entry snapshot: {new Date(entryTs).toLocaleTimeString()} · entry {fmtPx(entryPx)} · effective buffer{" "}
              {(bufEff * 100).toFixed(3)}%
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {syms.length > 1 ? (
              <select
                className="rounded border border-sky-200 bg-white px-2 py-1 text-[10px] font-mono text-slate-800 dark:border-sky-800 dark:bg-slate-900 dark:text-slate-100"
                value={sym}
                onChange={(e) => setSym(e.currentTarget.value)}
                title="Switch preview chart symbol (cached only)"
              >
                {syms.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              onClick={onClose}
            >
              Close
            </button>
          </div>
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

            {/*
             * IMPORTANT: keep the chart container mounted unconditionally while `open` is true.
             * Previously we conditionally rendered this on `hasCandles`, but when the modal first
             * opened with <20 cached candles (e.g. user hit Preview before the OHLC feed filled
             * the symbol buffer), the wrapper was never in the DOM → `chartWrapRef.current` was
             * null when the create-chart effect ran → chart was never created, and since the
             * create effect only re-runs on `open` transitions, it stayed broken for the rest of
             * the session even after candles arrived. Now we always mount the div; the "no data"
             * state is an overlay on top of an empty chart.
             */}
            <div className="relative">
              <div
                ref={chartWrapRef}
                className="h-[min(420px,48vh)] w-full touch-none rounded-lg border border-sky-200/60 bg-white/60 dark:border-sky-800/40 dark:bg-slate-950/40"
              />
              {!hasCandles ? (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-white/70 text-center text-[11px] text-amber-900 dark:bg-slate-950/70 dark:text-amber-200">
                  <span className="max-w-[80%] rounded border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900/40 dark:bg-amber-950/40">
                    No cached candles for <span className="font-mono">{sym}</span>. Open that coin on the main chart first, then re-open preview.
                  </span>
                </div>
              ) : null}
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

            <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-600 dark:text-slate-400">
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2 w-4 rounded bg-emerald-500" /> T01 lock (entry)
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2 w-4 rounded bg-amber-400" /> T02 lock (exact BE)
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2 w-4 rounded bg-slate-400" /> Post-T02 / user rungs
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-[2px] w-4 border-t-2 border-dotted border-sky-400" /> activation
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-[3px] w-4 rounded bg-sky-400" /> entry
              </span>
            </div>

            {selected.length > 0 ? (
              <div className="mt-2 rounded border border-sky-200/50 bg-sky-50/40 p-2 text-[10px] dark:border-sky-800/30 dark:bg-sky-950/20">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-sky-800/70 dark:text-sky-300/70">
                  Selected tier formulas
                </div>
                <ul className="space-y-0.5">
                  {selected.map((p) => (
                    <li key={p.id} className="flex items-baseline gap-2 text-slate-700 dark:text-slate-300">
                      <span className="min-w-[2.8rem] font-mono font-semibold">{p.label}</span>
                      <span className="text-[10px] text-slate-500 dark:text-slate-400">lock {fmtPx(p.lockPx)} · activation {fmtPx(p.activationPx)}</span>
                      <span className="ml-auto font-mono text-[9px] text-slate-500 dark:text-slate-400">{p.formula}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
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
                          Post‑T02 tiers use equal spacing from the T02 lock.
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
                    value={cfg.trailOpenFeeRate * 100}
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
                    value={cfg.trailCloseFeeRate * 100}
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
                    value={Number(cfg.trailFeeBeMultiplier)}
                    pct={false}
                    min={1}
                    max={2}
                    decimals={2}
                    onCommit={(v) => setCfg((p0) => ({ ...p0, trailFeeBeMultiplier: clampNum(v, 1, 2) }))}
                    title="Safety multiplier on round-trip fee. 1.0 = exact BE; 1.25 = 25% padding."
                  />

                  <div className="text-slate-700 dark:text-slate-300" title="Extra activation cushion on top of fee BE (T02 only). Does NOT move the lock.">
                    T02 activation slip (%)
                  </div>
                  <NumericTextInput
                    value={cfg.trailActivationSlippageFrac * 100}
                    pct
                    min={0}
                    max={1}
                    decimals={3}
                    onCommit={(v) => setCfg((p0) => ({ ...p0, trailActivationSlippageFrac: clampNum(v, 0, 0.01) }))}
                    title="Extra activation cushion on top of fee BE for T02. Does NOT move the T02 lock (exact BE is preserved)."
                  />

                  <div className="text-slate-700 dark:text-slate-300" title="Where the T01 SL sits vs entry (LONG above entry; SHORT below). 0 = exactly at entry.">
                    T01 lock slip (%)
                  </div>
                  <NumericTextInput
                    value={cfg.trailT01LockSlippageFrac * 100}
                    pct
                    min={0}
                    max={1}
                    decimals={3}
                    onCommit={(v) => setCfg((p0) => ({ ...p0, trailT01LockSlippageFrac: clampNum(v, 0, 0.01) }))}
                    title="Places T01 SL past entry (LONG above, SHORT below) so fills clear tick/display rounding."
                  />
                </div>

                <div className="mt-2 rounded border border-sky-200/60 bg-white/70 p-2 dark:border-sky-800/40 dark:bg-slate-950/40">
                  <div className="mb-1 flex items-center justify-between">
                    <div className="text-[10px] font-semibold text-slate-800 dark:text-slate-200">
                      Activation buffer <span className="font-normal text-slate-500 dark:text-slate-400">· T01 / T02 only</span>
                    </div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">
                      mode <span className="font-mono">{cfg.trailBufferMode}</span>
                    </div>
                  </div>
                  <div className="mb-1 text-[9px] leading-snug text-slate-600 dark:text-slate-400">
                    Controls the lock→activation gap for the <span className="font-mono">T01</span> (zero-loss) and{" "}
                    <span className="font-mono">T02</span> (fee break-even) tiers only. Post-T02 profit rungs use a
                    separate <span className="font-semibold">Tier activation buffer</span> in the Advanced panel below.
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
                          value={Number(cfg.trailBufferAtrMult)}
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
                          value={cfg.trailBufferRate * 100}
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
                          value={cfg.trailBufferRate * 100}
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
                  {/*
                   * Tier activation buffer — INDEPENDENT from the Fees / buffer "Activation buffer"
                   * above. This field governs the lock→activation gap for every post-T02 rung
                   * (T1, T2, T3…) only. Backend field: `trailPostT02ActivationBufferRate`. An empty
                   * value / toggle "inherit" restores the legacy behaviour of reusing the main
                   * `trailBufferRate` for all tiers. Fixed-percent only (no ATR mode): the profit
                   * rungs are geometric by design, so coupling them to regime ATR rarely helps and
                   * would make the UI confusing given the main buffer already supports ATR.
                   */}
                  {(() => {
                    const inheriting =
                      cfg.trailPostT02ActivationBufferRate == null ||
                      !Number.isFinite(Number(cfg.trailPostT02ActivationBufferRate));
                    /** Fraction currently applied on the chart (inherits when unset). */
                    const effectivePct =
                      (inheriting
                        ? cfg.trailBufferRate
                        : Number(cfg.trailPostT02ActivationBufferRate)) * 100;
                    return (
                      <div className="mb-2 rounded border border-amber-200/60 bg-amber-50/60 px-2 py-1.5 dark:border-amber-900/40 dark:bg-amber-950/20">
                        <div className="mb-1 flex items-center justify-between gap-2 text-[10px]">
                          <span className="font-semibold text-slate-800 dark:text-slate-200">
                            Tier activation buffer <span className="font-normal text-slate-500 dark:text-slate-400">· T1 / T2 / T3…</span>
                          </span>
                          <label className="flex items-center gap-1 text-slate-600 dark:text-slate-400" title="When inheriting, post-T02 rungs reuse the main Activation buffer value (legacy behaviour).">
                            <input
                              type="checkbox"
                              checked={inheriting}
                              onChange={(e) =>
                                setCfg((p0) => ({
                                  ...p0,
                                  trailPostT02ActivationBufferRate: e.target.checked
                                    ? null
                                    : clampNum(Number(p0.trailBufferRate) || 0.0005, 0, 0.05),
                                }))
                              }
                            />
                            inherit from T01/T02
                          </label>
                        </div>
                        <div className="grid grid-cols-[1fr_76px] items-center gap-2 text-[10px]">
                          <div
                            className="text-slate-700 dark:text-slate-300"
                            title="Post-T02 activation = lock_k × (1 ± postT02Buffer). Independent from the T01/T02 buffer."
                          >
                            Buffer (%)
                          </div>
                          <NumericTextInput
                            value={effectivePct}
                            pct
                            min={0}
                            max={5}
                            decimals={3}
                            disabled={inheriting}
                            onCommit={(v) =>
                              setCfg((p0) => ({
                                ...p0,
                                trailPostT02ActivationBufferRate: clampNum(v, 0, 0.05),
                              }))
                            }
                            title={inheriting ? "Uncheck 'inherit' to edit." : undefined}
                          />
                        </div>
                        <div className="mt-1 text-[9px] leading-snug text-slate-600 dark:text-slate-400">
                          Independent from <span className="font-semibold">Activation buffer</span> (T01/T02) above.
                          Controls the lock→activation gap for every post-T02 rung{" "}
                          <span className="font-mono">T1, T2, T3…</span>. Leave{" "}
                          <span className="font-semibold">inherit</span> on to reuse the T01/T02 buffer value.
                        </div>
                      </div>
                    );
                  })()}
                  <div className="grid grid-cols-[1fr_76px] items-center gap-2 text-[10px]">
                    <div className="text-slate-700 dark:text-slate-300">Min SL distance (%)</div>
                    <NumericTextInput
                      value={cfg.trailMinSlDistFrac * 100}
                      pct
                      min={0}
                      max={10}
                      decimals={3}
                      onCommit={(v) => setCfg((p0) => ({ ...p0, trailMinSlDistFrac: clampNum(v, 0, 0.1) }))}
                    />

                    <div className="text-slate-700 dark:text-slate-300">Min gap from mark (%)</div>
                    <NumericTextInput
                      value={cfg.trailMinGapFromMarkFrac * 100}
                      pct
                      min={0}
                      max={20}
                      decimals={3}
                      onCommit={(v) => setCfg((p0) => ({ ...p0, trailMinGapFromMarkFrac: clampNum(v, 0, 0.2) }))}
                    />

                    <div className="text-slate-700 dark:text-slate-300">Maint margin rate (%)</div>
                    <NumericTextInput
                      value={cfg.trailMaintMarginRate * 100}
                      pct
                      min={0}
                      max={10}
                      decimals={3}
                      onCommit={(v) => setCfg((p0) => ({ ...p0, trailMaintMarginRate: clampNum(v, 0, 0.1) }))}
                    />

                    <div className="text-slate-700 dark:text-slate-300">Post‑T02 step (% entry)</div>
                    <NumericTextInput
                      value={((cfg.trailPostT02SpacingFrac ?? 0) as number) * 100}
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

              {cfg.futuresTrailingStopMode === "FEE_LADDER" ? (
                <div className="rounded border border-sky-200/60 bg-white/60 p-2 dark:border-sky-800/40 dark:bg-slate-950/40">
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-sky-800/70 dark:text-sky-300/50">
                    Fee ladder: user scalp rungs (%)
                  </div>
                  <div className="text-[10px] text-slate-600 dark:text-slate-400">
                    Each value is a % of entry; appended after T0 (padded BE) and T1 (2× round-trip).
                  </div>
                  <div className="mt-1 grid grid-cols-3 gap-2">
                    {[0, 1, 2].map((i) => {
                      const list = cfg.trailingStopExtraScalpingPcts ?? [];
                      const cur = Number(list[i] ?? 0);
                      return (
                        <div key={`scalp-${i}`} className="grid grid-cols-[auto_1fr] items-center gap-1 text-[10px]">
                          <span className="font-mono text-slate-500 dark:text-slate-400">T{i + 2}</span>
                          <NumericTextInput
                            value={Number.isFinite(cur) ? cur : 0}
                            pct={false}
                            min={0}
                            max={50}
                            decimals={3}
                            onCommit={(v) => {
                              setCfg((p0) => {
                                const next = [...(p0.trailingStopExtraScalpingPcts ?? [])];
                                while (next.length < 3) next.push(0);
                                next[i] = clampNum(v, 0, 50);
                                const compact = next.filter((x) => Number.isFinite(x) && x > 0);
                                return { ...p0, trailingStopExtraScalpingPcts: compact };
                              });
                            }}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <div className="rounded border border-sky-200/60 bg-white/60 p-2 dark:border-sky-800/40 dark:bg-slate-950/40">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-sky-800/70 dark:text-sky-300/50">Points on chart</div>
                <div className="text-[10px] text-slate-600 dark:text-slate-400">Select up to 10 tier points.</div>
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

        <div className="sticky bottom-0 z-[1] flex items-center justify-between gap-2 border-t border-sky-200/70 bg-sky-50/80 px-3 py-2 backdrop-blur dark:border-sky-800/50 dark:bg-slate-950/80">
          <div className="min-w-0 text-[10px] text-slate-600 dark:text-slate-400">
            {applyError ? (
              <span className="text-red-600 dark:text-red-400">Apply failed: {applyError}</span>
            ) : dirty ? (
              "Click Apply to persist these settings to the live bot config. Close will discard changes."
            ) : (
              "No changes to apply."
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="rounded border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              onClick={doRevert}
              disabled={!dirty || applying}
              title="Reset all preview fields to the values that were live when this modal opened."
            >
              Revert
            </button>
            <button
              type="button"
              className="rounded border border-sky-600 bg-sky-600 px-3 py-1 text-[11px] font-semibold text-white shadow-sm hover:bg-sky-700 disabled:border-slate-400 disabled:bg-slate-400 disabled:opacity-70 dark:border-sky-500 dark:bg-sky-500 dark:hover:bg-sky-400"
              onClick={doApply}
              disabled={!dirty || applying}
              title="Save these preview settings to the live bot configuration."
            >
              {applying ? "Applying…" : "Apply"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
