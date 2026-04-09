import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { deferTask } from "../lib/deferTask";
import { useAppStore } from "../ws/store";

const numericInputClass =
  "w-full rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-slate-900 dark:text-slate-100 tabular-nums";

/**
 * Plain text + inputMode so values are freely typed (no spinner-only UX); commits on blur / Enter.
 */
function NumericTextInput({
  value,
  disabled,
  inputMode = "decimal",
  min,
  max,
  onCommit,
  parse,
  onDraftParsed,
}: {
  value: number;
  disabled?: boolean;
  inputMode?: "decimal" | "numeric";
  min?: number;
  max?: number;
  onCommit: (v: number) => void | Promise<void>;
  parse?: (raw: string) => number;
  /** Fires while typing so parents (e.g. leverage) can recompute derived hints before commit. */
  onDraftParsed?: (n: number | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const parseNum = parse ?? ((raw: string) => parseFloat(raw.replace(/,/g, ".")));
  const shown = focused && draft !== null ? draft : String(value);

  useEffect(() => {
    if (!focused) setDraft(null);
  }, [value, focused]);

  const commit = async () => {
    const raw = (draft ?? String(value)).replace(/,/g, ".").trim();
    if (raw === "" || raw === "-" || raw === ".") {
      setFocused(false);
      setDraft(null);
      return;
    }
    const n = parseNum(raw);
    if (!Number.isFinite(n)) {
      setFocused(false);
      setDraft(null);
      return;
    }
    let n2 = n;
    if (min != null) n2 = Math.max(min, n2);
    if (max != null) n2 = Math.min(max, n2);
    if (Math.abs(n2 - value) < 1e-12) {
      setFocused(false);
      setDraft(null);
      return;
    }
    deferTask(() => {
      void (async () => {
        try {
          await onCommit(n2);
        } finally {
          setFocused(false);
          setDraft(null);
        }
      })();
    });
  };

  return (
    <input
      type="text"
      inputMode={inputMode}
      autoComplete="off"
      spellCheck={false}
      disabled={disabled}
      className={numericInputClass}
      value={shown}
      onFocus={() => {
        setFocused(true);
        setDraft(String(value));
      }}
      onChange={(e) => {
        const next = e.target.value;
        setDraft(next);
        if (onDraftParsed) {
          const raw = next.replace(/,/g, ".").trim();
          if (raw === "" || raw === "-" || raw === ".") {
            onDraftParsed(null);
            return;
          }
          const n = parseNum(raw);
          onDraftParsed(Number.isFinite(n) ? n : null);
        }
      }}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function clampNum(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

/** ~1.5¢ cushion: avoids false "below min" when Risk/trade equals Binance min (e.g. ETHUSDT min 20) due to float/UI rounding. */
const FUTURES_MIN_NOTIONAL_TOL_USD = 0.015;

function futuresOrderNotionalBelowMin(orderNom: number, exchangeMin: number): boolean {
  return orderNom + FUTURES_MIN_NOTIONAL_TOL_USD < exchangeMin;
}

function futuresBuyingPowerBelowMin(maxAffordable: number, exchangeMin: number): boolean {
  return maxAffordable + FUTURES_MIN_NOTIONAL_TOL_USD < exchangeMin;
}

/** Normalize /api/symbol/constraints for spot + futures legs. */
function constraintsLegs(data: any): {
  spot: { min: number; qa: string } | null;
  fut: { min: number; qa: string } | null;
  fetchFailed: boolean;
} {
  const empty = { spot: null as { min: number; qa: string } | null, fut: null as { min: number; qa: string } | null, fetchFailed: true };
  if (!data) return empty;
  if (data.ok === false) return { spot: null, fut: null, fetchFailed: true };
  const out = { spot: null as { min: number; qa: string } | null, fut: null as { min: number; qa: string } | null, fetchFailed: false };
  if (data.venue === "BOTH" && data.legs && typeof data.legs === "object") {
    const sp = data.legs.spot;
    const fu = data.legs.futures;
    if (sp?.ok && Number.isFinite(Number(sp.minNotional)) && Number(sp.minNotional) > 0) {
      out.spot = { min: Number(sp.minNotional), qa: String(sp.quoteAsset || "USDT") };
    }
    if (fu?.ok && Number.isFinite(Number(fu.minNotional)) && Number(fu.minNotional) > 0) {
      out.fut = { min: Number(fu.minNotional), qa: String(fu.quoteAsset || "USDT") };
    }
    return out;
  }
  if (data.venue === "SPOT" && Number.isFinite(Number(data.minNotional)) && Number(data.minNotional) > 0) {
    out.spot = { min: Number(data.minNotional), qa: String(data.quoteAsset || "USDT") };
  }
  if (data.venue === "FUTURES" && Number.isFinite(Number(data.minNotional)) && Number(data.minNotional) > 0) {
    out.fut = { min: Number(data.minNotional), qa: String(data.quoteAsset || "USDT") };
  }
  return out;
}

/** Match backend riskPlan: buying power = freeBalance × leverage (futures), cap ~90% of that. */
function effectiveFuturesOrderNotionalUsdt(riskUsdt: number, freeBalance: number | null, leverage: number): number | null {
  if (!Number.isFinite(riskUsdt) || riskUsdt <= 0) return null;
  if (freeBalance == null || !Number.isFinite(freeBalance) || freeBalance <= 0) return null;
  const lev = Math.max(1, Math.min(100, Number(leverage) || 1));
  const buyingPower = freeBalance * lev;
  const cap = buyingPower * 0.9;
  return Math.min(riskUsdt, cap);
}

function effectiveSpotOrderNotionalUsdt(riskUsdt: number, freeBalance: number | null): number | null {
  if (!Number.isFinite(riskUsdt) || riskUsdt <= 0) return null;
  if (freeBalance == null || !Number.isFinite(freeBalance) || freeBalance <= 0) return null;
  return Math.min(riskUsdt, freeBalance * 0.9);
}

/** Same ladder as backend `decideFuturesLeverage` (AUTO); result clamped to 1–5. */
function decideFuturesLeverageUi(prob: number, atrPct: number, regimeType: string): number {
  const p = clampNum(Number(prob ?? 0), 0, 1);
  const a = Math.max(0, Number(atrPct || 0));
  const reg = String(regimeType || "").toUpperCase();
  const volatile = reg.includes("VOLAT") || a >= 0.012;
  let lev =
    p >= 0.85 ? 15 :
    p >= 0.78 ? 10 :
    p >= 0.7 ? 7 :
    p >= 0.62 ? 5 :
    p >= 0.55 ? 3 : 2;
  if (volatile) lev = Math.max(2, Math.floor(lev * 0.6));
  return clampNum(lev, 1, 5);
}

type LevCfg = {
  futuresLeverage: number;
  futuresLeverageMode: string;
  riskPerTradeUnit?: string;
  maxDailyLossUnit?: string;
};

/**
 * Futures leverage used for margin×leverage caps in the UI.
 * MANUAL: configured slider (1–100). AUTO: model (AI + regime), same rules as bot `riskPlan` / `manualTrade`.
 */
function effectiveFuturesLeverageForSizing(bot: any, cfg: LevCfg, opts?: { manualTrade?: boolean }): number {
  const mode = String(cfg.futuresLeverageMode || "AUTO").toUpperCase();
  if (mode === "MANUAL") {
    return clampNum(Math.floor(Number(cfg.futuresLeverage) || 1), 1, 100);
  }
  const ru = String(cfg.riskPerTradeUnit || bot?.riskPerTradeUnit || "");
  const mu = String(cfg.maxDailyLossUnit || bot?.maxDailyLossUnit || "");
  const fixedUsdt = ru === "USDT" && mu === "USDT";
  const prob = opts?.manualTrade
    ? Number(bot?.lastAi?.probability ?? 0.55)
    : fixedUsdt
      ? 0.75
      : Number(bot?.lastAi?.gateProbability ?? bot?.lastAi?.probability ?? 0.5);
  const atrPct = Number(bot?.lastRegime?.atrPct ?? 0);
  const regime = String(bot?.lastRegime?.type ?? "");
  return decideFuturesLeverageUi(prob, atrPct, regime);
}

/** Leverage for margin×buying-power math: MANUAL uses committed config or live draft from the Leverage × field. */
function futuresLeverageUsedForMarginCap(
  bot: any,
  cfg: LevCfg,
  levDraftManual: number | null,
  opts?: { manualTrade?: boolean },
): number {
  const mode = String(cfg.futuresLeverageMode || "AUTO").toUpperCase();
  if (mode === "MANUAL") {
    if (levDraftManual != null && Number.isFinite(levDraftManual)) {
      return clampNum(Math.floor(levDraftManual), 1, 100);
    }
    return clampNum(Math.floor(Number(cfg.futuresLeverage) || 1), 1, 100);
  }
  return effectiveFuturesLeverageForSizing(bot, cfg, opts);
}

function RiskUnitToggle({
  value,
  disabled,
  onChange,
}: {
  value: "PCT" | "USDT";
  disabled?: boolean;
  onChange: (u: "PCT" | "USDT") => void | Promise<void>;
}) {
  const sel = value === "USDT" ? "USDT" : "PCT";
  return (
    <div className="flex shrink-0 rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-0.5 text-[10px] font-medium text-slate-700 dark:text-slate-300">
      <button
        type="button"
        disabled={disabled}
        className={`rounded px-1.5 py-0.5 ${sel === "PCT" ? "bg-slate-600 text-white" : "hover:text-slate-900 dark:text-slate-100 disabled:opacity-40"}`}
        onClick={() => void onChange("PCT")}
      >
        %
      </button>
      <button
        type="button"
        disabled={disabled}
        className={`rounded px-1.5 py-0.5 ${sel === "USDT" ? "bg-slate-600 text-white" : "hover:text-slate-900 dark:text-slate-100 disabled:opacity-40"}`}
        onClick={() => void onChange("USDT")}
      >
        USDT
      </button>
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <rect x="5" y="11" width="14" height="11" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function UnlockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <rect x="5" y="11" width="14" height="11" rx="2" />
      <path d="M16 11V8a4 4 0 0 0-7.45-1.07" />
    </svg>
  );
}

/**
 * Slider 0–100 in UI units. Parent maps to API on commit (e.g. AI prob ÷ 100).
 * Locked by default: unlock to drag; lock again commits immediately and disables the slider.
 */
function ThresholdSliderWithLock({
  serverSliderUnits,
  disabled,
  onDebouncedCommit,
  formatDisplay,
  ariaLabel,
}: {
  serverSliderUnits: number;
  disabled?: boolean;
  onDebouncedCommit: (sliderUnits: number) => void;
  formatDisplay: (sliderUnits: number) => string;
  ariaLabel: string;
}) {
  const [unlocked, setUnlocked] = useState(false);
  const [draft, setDraft] = useState(() => clampNum(Math.round(serverSliderUnits), 0, 100));
  const debRef = useRef<number | null>(null);

  useEffect(() => {
    if (!unlocked) setDraft(clampNum(Math.round(serverSliderUnits), 0, 100));
  }, [serverSliderUnits, unlocked]);

  const shown = unlocked ? draft : clampNum(Math.round(serverSliderUnits), 0, 100);

  const clearDebounce = () => {
    if (debRef.current != null) {
      window.clearTimeout(debRef.current);
      debRef.current = null;
    }
  };

  const schedule = (sliderUnits: number) => {
    clearDebounce();
    debRef.current = window.setTimeout(() => {
      debRef.current = null;
      onDebouncedCommit(sliderUnits);
    }, 450);
  };

  const toggleLock = () => {
    if (disabled) return;
    if (unlocked) {
      clearDebounce();
      const toSave = clampNum(draft, 0, 100);
      deferTask(() => onDebouncedCommit(toSave));
      setUnlocked(false);
    } else {
      setDraft(clampNum(Math.round(serverSliderUnits), 0, 100));
      setUnlocked(true);
    }
  };

  useEffect(() => () => clearDebounce(), []);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <input
        type="range"
        aria-label={ariaLabel}
        className="h-2 min-w-0 flex-1 cursor-pointer accent-emerald-500 disabled:cursor-not-allowed disabled:opacity-45"
        min={0}
        max={100}
        step={1}
        value={shown}
        disabled={disabled || !unlocked}
        onChange={(e) => {
          const v = Number(e.target.value);
          setDraft(v);
          if (unlocked) schedule(v);
        }}
      />
      <span className="w-11 shrink-0 text-right text-[11px] tabular-nums text-slate-600 dark:text-slate-400">{formatDisplay(shown)}</span>
      <button
        type="button"
        onClick={toggleLock}
        disabled={disabled}
        className="shrink-0 rounded border border-slate-300 dark:border-slate-700 bg-slate-200/88 dark:bg-slate-100 dark:bg-slate-900/80 p-1 text-slate-600 dark:text-slate-400 hover:border-slate-600 hover:text-slate-800 dark:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
        title={unlocked ? "Lock (save current threshold)" : "Unlock to adjust threshold"}
        aria-pressed={unlocked}
      >
        {unlocked ? <UnlockIcon /> : <LockIcon />}
      </button>
    </div>
  );
}

const STRATS = [
  { key: "EMA_CROSS", label: "Trend (EMA crossover)" },
  { key: "RSI_MEAN", label: "Mean Reversion (RSI)" },
  { key: "BREAKOUT_VOL", label: "Breakout (Volume)" },
];

export function TradingPanel() {
  const bot = useAppStore((s) => s.bot);
  const account = useAppStore((s) => s.account);
  const pushLog = useAppStore((s) => s.pushLog);
  const [top, setTop] = useState<any[]>([]);
  const [btLoading, setBtLoading] = useState(false);
  const [coinBusy, setCoinBusy] = useState(false);
  // Bot configuration is always visible; this toggle only controls manual orders visibility below it.
  const [showManualOrders, setShowManualOrders] = useState(false);

  const [amountUsdStr, setAmountUsdStr] = useState("200");
  const [slPctStr, setSlPctStr] = useState("0.002");
  const [tpPctStr, setTpPctStr] = useState("0.015");
  const [manualOrderBusy, setManualOrderBusy] = useState(false);
  const manualFormHydratedRef = useRef(false);
  const skipManualFormPersistRef = useRef(true);

  useEffect(() => {
    const d = bot?.tradingFormDefaults as { amountUsdStr?: string; slPctStr?: string; tpPctStr?: string } | undefined;
    if (!d || manualFormHydratedRef.current) return;
    if (typeof d.amountUsdStr === "string") setAmountUsdStr(d.amountUsdStr);
    if (typeof d.slPctStr === "string") setSlPctStr(d.slPctStr);
    if (typeof d.tpPctStr === "string") setTpPctStr(d.tpPctStr);
    manualFormHydratedRef.current = true;
  }, [bot?.tradingFormDefaults]);

  useEffect(() => {
    if (!manualFormHydratedRef.current) return;
    if (skipManualFormPersistRef.current) {
      skipManualFormPersistRef.current = false;
      return;
    }
    const t = window.setTimeout(() => {
      void api
        .botConfig({
          tradingFormDefaults: { amountUsdStr, slPctStr, tpPctStr },
        })
        .catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [amountUsdStr, slPctStr, tpPctStr]);

  const cfg = useMemo(() => {
    return {
      aiThreshold: Number(bot?.aiThreshold ?? 0.65),
      riskPerTrade: Number(bot?.riskPerTrade ?? 0.01),
      maxDailyLoss: Number(bot?.maxDailyLoss ?? 0.05),
      riskPerTradeUnit: bot?.riskPerTradeUnit === "USDT" ? ("USDT" as const) : ("PCT" as const),
      maxDailyLossUnit: bot?.maxDailyLossUnit === "USDT" ? ("USDT" as const) : ("PCT" as const),
      strategyMode: bot?.strategyMode ?? "AUTO",
      manualStrategy: bot?.manualStrategy ?? "EMA_CROSS",
      symbolMode: bot?.symbolMode ?? "SINGLE",
      marketMode: bot?.marketMode ?? "AUTO",
      futuresLeverageMode: (bot?.futuresLeverageMode as string) === "MANUAL" ? "MANUAL" : "AUTO",
      futuresLeverage: Number(bot?.futuresLeverage ?? 5),
      supertrendSpotAuto: Boolean(bot?.supertrendSpotAuto),
      supertrendFuturesAuto: Boolean(bot?.supertrendFuturesAuto),
      supertrendPeriod: Number(bot?.supertrendPeriod ?? 10),
      supertrendMultiplier: Number(bot?.supertrendMultiplier ?? 3),
      supertrendWilderAtr: bot?.supertrendWilderAtr !== false,
      supertrendFuturesAiConfidenceFilter: bot?.supertrendFuturesAiConfidenceFilter !== false,
      signalStrengthGatesTrades: bot?.signalStrengthGatesTrades === true,
      signalStrengthOpenMin: clampNum(Math.round(Number(bot?.signalStrengthOpenMin ?? 65)), 0, 100),
      supertrendFuturesMinAiProb: clampNum(Number(bot?.supertrendFuturesMinAiProb ?? 0.55), 0, 1),
      supertrendFuturesFixedSlPct: clampNum(Number(bot?.supertrendFuturesFixedSlPct ?? 0.002), 0.00005, 0.2),
      supertrendFuturesFixedTpPct: clampNum(Number(bot?.supertrendFuturesFixedTpPct ?? 0.015), 0.00005, 0.5),
      supertrendFuturesTwoWay: bot?.supertrendFuturesTwoWay === true,
    };
  }, [bot]);

  const activeSymbol = useMemo(() => {
    const s = String(bot?.symbol || "").toUpperCase().trim();
    return s || "BTCUSDT";
  }, [bot?.symbol]);

  const marketClose = useAppStore((s) => {
    const c = s.market?.candle?.close;
    const n = Number(c);
    return Number.isFinite(n) && n > 0 ? n : null;
  });

  const [constraintsRaw, setConstraintsRaw] = useState<any>(null);
  /** MANUAL leverage while typing (before blur/commit); keeps min-notional hints in sync with Leverage ×. */
  const [futuresLevDraft, setFuturesLevDraft] = useState<number | null>(null);

  useEffect(() => {
    if (String(cfg.futuresLeverageMode || "AUTO").toUpperCase() !== "MANUAL") {
      setFuturesLevDraft(null);
    }
  }, [cfg.futuresLeverageMode]);

  useEffect(() => {
    let alive = true;
    const mm = String(cfg.marketMode || "AUTO").toUpperCase();
    const venue = mm === "AUTO" ? "BOTH" : mm === "SPOT" ? "SPOT" : "FUTURES";
    void api
      .symbolConstraints(activeSymbol, venue)
      .then((r) => {
        if (alive) setConstraintsRaw(r);
      })
      .catch(() => {
        if (alive) setConstraintsRaw({ ok: false });
      });
    return () => {
      alive = false;
    };
  }, [activeSymbol, cfg.marketMode]);

  const manualAmountUsd = useMemo(() => {
    const n = parseFloat(String(amountUsdStr).replace(/,/g, ".").trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [amountUsdStr]);

  const minNotionalUi = useMemo(() => {
    const legs = constraintsLegs(constraintsRaw);
    const mm = String(cfg.marketMode || "AUTO").toUpperCase();
    const needSpot = mm === "SPOT" || mm === "AUTO";
    const needFut = mm === "FUTURES" || mm === "AUTO";
    const futFreeRaw = account?.venues?.futures?.freeBalance;
    const spotFreeRaw = account?.venues?.spot?.freeBalance;
    const futFree =
      futFreeRaw != null && Number.isFinite(Number(futFreeRaw)) && Number(futFreeRaw) >= 0
        ? Number(futFreeRaw)
        : null;
    const spotFree =
      spotFreeRaw != null && Number.isFinite(Number(spotFreeRaw)) && Number(spotFreeRaw) >= 0
        ? Number(spotFreeRaw)
        : null;
    const levFutures = futuresLeverageUsedForMarginCap(bot, cfg, futuresLevDraft, { manualTrade: false });
    const lines: { key: string; text: string; warn: boolean }[] = [];
    if (needFut && legs.fut) {
      const { min, qa } = legs.fut;
      lines.push({
        key: "fut-min",
        text: `Binance USD-M ${activeSymbol}: min order notional ≈ ${min.toFixed(2)} ${qa} (exchangeInfo MIN_NOTIONAL).`,
        warn: false,
      });
    }
    if (needSpot && legs.spot) {
      const { min, qa } = legs.spot;
      lines.push({
        key: "spot-min",
        text: `Binance spot ${activeSymbol}: min order notional ≈ ${min.toFixed(2)} ${qa} (exchangeInfo NOTIONAL / MIN_NOTIONAL, quote).`,
        warn: false,
      });
    }
    const risk = cfg.riskPerTrade;
    if (cfg.riskPerTradeUnit === "USDT") {
      if (needFut && legs.fut) {
        const { min: futMin, qa: futQa } = legs.fut;
        const levLabel =
          String(cfg.futuresLeverageMode || "AUTO").toUpperCase() === "MANUAL"
            ? `Leverage × ${levFutures}`
            : `AUTO ~${levFutures}x`;
        const maxAff = futFree != null ? futFree * levFutures * 0.9 : null;
        const orderNom = maxAff != null ? Math.min(risk, maxAff) : risk;
        if (maxAff != null && futuresBuyingPowerBelowMin(maxAff, futMin)) {
          lines.push({
            key: "risk-fut-bp",
            warn: true,
            text: `Futures: at ${levLabel}, max deployable notional ≈ ${maxAff.toFixed(2)} ${futQa} (~90% of margin×leverage) — below Binance min ${futMin.toFixed(2)} ${futQa} for ${activeSymbol}. Add USDT-M margin or raise Leverage × (MANUAL).`,
          });
        } else if (futuresOrderNotionalBelowMin(orderNom, futMin)) {
          lines.push({
            key: "risk-fut-order",
            warn: true,
            text: `Futures: order notional ≈ ${orderNom.toFixed(2)} ${futQa} (min of Risk/trade and ${levLabel} cap × ~90% margin) — below min ${futMin.toFixed(2)} ${futQa} for ${activeSymbol}. Raise Risk/trade USDT and/or Leverage ×, or add margin.`,
          });
        }
      }
      if (needSpot && legs.spot) {
        if (risk + 1e-9 < legs.spot.min) {
          lines.push({
            key: "risk-spot",
            text: `Risk/trade (${risk.toFixed(2)} USDT) is below spot min notional (${legs.spot.min.toFixed(2)} ${legs.spot.qa}).`,
            warn: true,
          });
        } else if (spotFree != null) {
          const eff = effectiveSpotOrderNotionalUsdt(risk, spotFree);
          if (eff != null && eff + 1e-9 < legs.spot.min) {
            lines.push({
              key: "risk-spot-cap",
              text: `Spot: after ~90% of free ${legs.spot.qa}, effective notional ≈ ${eff.toFixed(2)} — below min ${legs.spot.min.toFixed(2)} ${legs.spot.qa}. Add spot quote balance or raise Risk/trade.`,
              warn: true,
            });
          }
        }
      }
    } else if (marketClose && marketClose > 0) {
      if (needFut && legs.fut) {
        const minQ = legs.fut.min / marketClose;
        lines.push({
          key: "pct-fut",
          text: `% mode: at last ~${marketClose.toFixed(6)}, min notional ${legs.fut.min.toFixed(2)} ${legs.fut.qa} ⇒ rough min base qty ≈ ${minQ.toPrecision(4)} (actual notional depends on stop distance and tiers).`,
          warn: false,
        });
      }
      if (needSpot && legs.spot) {
        const minQ = legs.spot.min / marketClose;
        lines.push({
          key: "pct-spot",
          text: `% mode (spot): at last ~${marketClose.toFixed(6)}, min notional ${legs.spot.min.toFixed(2)} ${legs.spot.qa} ⇒ spend at least that much quote on a MARKET BUY.`,
          warn: false,
        });
      }
    }
    return lines;
  }, [
    constraintsRaw,
    cfg.marketMode,
    cfg.riskPerTrade,
    cfg.riskPerTradeUnit,
    cfg.futuresLeverage,
    cfg.futuresLeverageMode,
    cfg.maxDailyLossUnit,
    cfg.riskPerTradeUnit,
    activeSymbol,
    marketClose,
    account,
    bot?.lastRegime?.type,
    bot?.lastRegime?.atrPct,
    bot?.lastAi?.probability,
    bot?.lastAi?.gateProbability,
    futuresLevDraft,
  ]);

  const manualNotionalWarnings = useMemo(() => {
    const legs = constraintsLegs(constraintsRaw);
    const mm = String(cfg.marketMode || "AUTO").toUpperCase();
    const needSpot = mm === "SPOT" || mm === "AUTO";
    const needFut = mm === "FUTURES" || mm === "AUTO";
    const futFreeRaw = account?.venues?.futures?.freeBalance;
    const spotFreeRaw = account?.venues?.spot?.freeBalance;
    const futFree =
      futFreeRaw != null && Number.isFinite(Number(futFreeRaw)) && Number(futFreeRaw) >= 0
        ? Number(futFreeRaw)
        : null;
    const spotFree =
      spotFreeRaw != null && Number.isFinite(Number(spotFreeRaw)) && Number(spotFreeRaw) >= 0
        ? Number(spotFreeRaw)
        : null;
    const levManualOrder = futuresLeverageUsedForMarginCap(bot, cfg, futuresLevDraft, { manualTrade: true });
    const w: string[] = [];
    if (manualAmountUsd == null) return w;
    if (needFut && legs.fut) {
      const { min: futMin, qa: futQa } = legs.fut;
      const levLabel =
        String(cfg.futuresLeverageMode || "AUTO").toUpperCase() === "MANUAL"
          ? `Leverage × ${levManualOrder}`
          : `AUTO ~${levManualOrder}x`;
      const maxAff = futFree != null ? futFree * levManualOrder * 0.9 : null;
      const orderNom = maxAff != null ? Math.min(manualAmountUsd, maxAff) : manualAmountUsd;
      if (maxAff != null && futuresBuyingPowerBelowMin(maxAff, futMin)) {
        w.push(
          `Futures: at ${levLabel}, max deployable ~${maxAff.toFixed(2)} ${futQa} — below min ~${futMin.toFixed(2)} ${futQa} for ${activeSymbol}.`,
        );
      } else if (futuresOrderNotionalBelowMin(orderNom, futMin)) {
        w.push(
          `Futures: order notional ~${orderNom.toFixed(2)} ${futQa} (Amount capped by ${levLabel} margin×~90%) — below min ~${futMin.toFixed(2)} ${futQa}. Raise Amount and/or Leverage ×.`,
        );
      }
    }
    if (needSpot && legs.spot) {
      if (manualAmountUsd + 1e-9 < legs.spot.min) {
        w.push(`Amount is below spot min notional (~${legs.spot.min.toFixed(2)} ${legs.spot.qa}) for ${activeSymbol}.`);
      } else if (spotFree != null) {
        const eff = effectiveSpotOrderNotionalUsdt(manualAmountUsd, spotFree);
        if (eff != null && eff + 1e-9 < legs.spot.min) {
          w.push(
            `Spot: free balance caps spend to ~${eff.toFixed(2)} ${legs.spot.qa} — below min (~${legs.spot.min.toFixed(2)}). Add funds or raise Amount once wallet allows.`,
          );
        }
      }
    }
    return w;
  }, [
    constraintsRaw,
    cfg.marketMode,
    manualAmountUsd,
    activeSymbol,
    account,
    cfg.futuresLeverage,
    cfg.futuresLeverageMode,
    cfg.maxDailyLossUnit,
    cfg.riskPerTradeUnit,
    bot?.lastRegime?.type,
    bot?.lastRegime?.atrPct,
    bot?.lastAi?.probability,
    bot?.lastAi?.gateProbability,
    futuresLevDraft,
  ]);

  const rankedCoins = (bot?.universe?.ranked || []).slice(0, 12);
  const pinnedSymbolNorm = bot?.universePinnedSymbol ? String(bot.universePinnedSymbol).toUpperCase() : "";
  const showRankedCoins = cfg.symbolMode === "AUTO" || Boolean(pinnedSymbolNorm);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      if (cfg.strategyMode !== "MANUAL") return;
      try {
        setBtLoading(true);
        const r = await api.backtest(700);
        if (!alive) return;
        setTop((r?.results || []).slice(0, 10));
      } catch {
        if (!alive) return;
        setTop([]);
      } finally {
        if (alive) setBtLoading(false);
      }
    };
    run();
    const id = setInterval(run, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [cfg.strategyMode]);

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">Trading</div>
          <div className="text-xs text-slate-600 dark:text-slate-400">
            Toggle: bot settings vs one-off manual trades. (Strategy on/off is the <span className="text-slate-600 dark:text-slate-500">Mode</span>{" "}
            field below.)
          </div>
        </div>
      </div>

      <div className="mb-4">
        <div className="flex rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40 p-1">
          <button
            type="button"
            className={`flex-1 rounded-md px-3 py-2 text-xs font-semibold ${
              !showManualOrders
                ? "bg-emerald-600/80 text-slate-950 dark:text-slate-50 hover:bg-emerald-600"
                : "bg-white/70 dark:bg-slate-950/20 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:bg-slate-900"
            }`}
            onClick={() => setShowManualOrders(false)}
          >
            Bot configuration
          </button>
          <button
            type="button"
            className={`flex-1 rounded-md px-3 py-2 text-xs font-semibold ${
              showManualOrders
                ? "bg-emerald-600/80 text-slate-950 dark:text-slate-50 hover:bg-emerald-600"
                : "bg-white/70 dark:bg-slate-950/20 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:bg-slate-900"
            }`}
            onClick={() => setShowManualOrders(true)}
          >
            Manual orders
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40 p-3">
        <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">Auto trading / bot configuration</div>
        <div className="mt-2 grid gap-2 text-xs">
            <label className="grid grid-cols-[110px_1fr] items-center gap-2">
              <span className="text-slate-600 dark:text-slate-400">Mode</span>
              <select
                className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-slate-900 dark:text-slate-100"
                value={cfg.strategyMode}
                onChange={(e) => {
                  const v = e.target.value;
                  deferTask(() => {
                    void (async () => {
                      try {
                        await api.botConfig({ strategyMode: v });
                      } catch {
                        pushLog({ level: "error", msg: "Failed to set strategy mode" });
                      }
                    })();
                  });
                }}
              >
                <option value="AUTO">AUTO (regime-based)</option>
                <option value="MANUAL">MANUAL (pick strategy)</option>
              </select>
            </label>

            <label className="grid grid-cols-[110px_1fr] items-center gap-2">
              <span className="text-slate-600 dark:text-slate-400">Coin select</span>
              <select
                className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-slate-900 dark:text-slate-100"
                value={cfg.symbolMode}
                onChange={(e) => {
                  const v = e.target.value;
                  deferTask(() => {
                    void (async () => {
                      try {
                        await api.botConfig({ symbolMode: v });
                        if (v === "AUTO") pushLog({ level: "info", msg: "Coin selection enabled (auto)" });
                        else pushLog({ level: "info", msg: "Coin selection disabled (single coin)" });
                      } catch {
                        pushLog({ level: "error", msg: "Failed to set coin selection mode" });
                      }
                    })();
                  });
                }}
              >
                <option value="SINGLE">SINGLE (trade selected symbol)</option>
                <option value="AUTO">AUTO (scan + rank + pick)</option>
              </select>
            </label>

            <label className="grid grid-cols-[110px_1fr] items-center gap-2">
              <span className="text-slate-600 dark:text-slate-400">Market</span>
              <select
                className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-slate-900 dark:text-slate-100"
                value={cfg.marketMode}
                onChange={(e) => {
                  const mode = e.target.value;
                  deferTask(() => {
                    void (async () => {
                      try {
                        await api.botConfig({ marketMode: mode });
                        pushLog({ level: "info", msg: "Market mode set", marketMode: mode });
                      } catch {
                        pushLog({ level: "error", msg: "Failed to set market mode" });
                      }
                    })();
                  });
                }}
              >
                <option value="AUTO">AUTO (model chooses spot vs futures)</option>
                <option value="SPOT">SPOT only</option>
                <option value="FUTURES">FUTURES only</option>
              </select>
            </label>

            {cfg.marketMode !== "SPOT" && (
              <div className="rounded-lg border border-slate-200 dark:border-slate-800/90 bg-white/85 dark:bg-slate-950/30 p-2">
                <div className="mb-1.5 text-[11px] font-semibold text-slate-700 dark:text-slate-300">Supertrend futures direction</div>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-semibold ${
                      !cfg.supertrendFuturesTwoWay
                        ? "bg-amber-600/85 text-slate-950 dark:text-slate-50 hover:bg-amber-600"
                        : "border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:bg-slate-900"
                    }`}
                    onClick={() => {
                      if (!cfg.supertrendFuturesTwoWay) return;
                      deferTask(() => {
                        void (async () => {
                          try {
                            await api.botConfig({ supertrendFuturesTwoWay: false });
                            pushLog({
                              level: "info",
                              msg: "Futures Supertrend: 1-way (buy) — SELL signal only closes long; BUY opens long.",
                            });
                          } catch {
                            pushLog({ level: "error", msg: "Failed to set 1-way mode" });
                          }
                        })();
                      });
                    }}
                  >
                    1-way (Buy)
                  </button>
                  <button
                    type="button"
                    className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-semibold ${
                      cfg.supertrendFuturesTwoWay
                        ? "bg-amber-600/85 text-slate-950 dark:text-slate-50 hover:bg-amber-600"
                        : "border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:bg-slate-900"
                    }`}
                    onClick={() => {
                      if (cfg.supertrendFuturesTwoWay) return;
                      deferTask(() => {
                        void (async () => {
                          try {
                            await api.botConfig({ supertrendFuturesTwoWay: true });
                            pushLog({
                              level: "info",
                              msg: "Futures Supertrend: 2-way — BUY closes short then long; SELL closes long then short.",
                            });
                          } catch {
                            pushLog({ level: "error", msg: "Failed to set 2-way mode" });
                          }
                        })();
                      });
                    }}
                  >
                    2-way (Buy &amp; Sell)
                  </button>
                </div>
                <p className="mt-1.5 text-[10px] leading-snug text-slate-600 dark:text-slate-500">
                  Indicator autotrade only. With AI confidence filter off, entries use fixed SL 0.2% / TP 1.5% (defaults).
                </p>
              </div>
            )}

            {(cfg.marketMode === "SPOT" || cfg.marketMode === "FUTURES") && (
              <div
                className={
                  cfg.marketMode === "FUTURES"
                    ? "space-y-2 rounded-lg border border-amber-900/40 bg-amber-950/15 p-2"
                    : "space-y-2 rounded-lg border border-emerald-900/40 bg-emerald-950/15 p-2"
                }
              >
                <label className="flex cursor-pointer items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={
                      cfg.marketMode === "SPOT" ? cfg.supertrendSpotAuto : cfg.supertrendFuturesAuto
                    }
                    onChange={(e) => {
                      const autoOn = e.currentTarget.checked;
                      const mm = cfg.marketMode;
                      deferTask(() => {
                        void (async () => {
                          try {
                            if (mm === "SPOT") {
                              await api.botConfig({ supertrendSpotAuto: autoOn });
                              pushLog({
                                level: "info",
                                msg: autoOn
                                  ? "Supertrend spot autotrading ON — BUY uses ~all available spot quote; SELL closes full base on signal (bar close). Start the bot. AI path is paused."
                                  : "Supertrend spot autotrading OFF",
                              });
                            } else {
                              await api.botConfig(
                                autoOn
                                  ? { supertrendFuturesAuto: true }
                                  : {
                                      supertrendFuturesAuto: false,
                                      supertrendFuturesAiConfidenceFilter: true,
                                    },
                              );
                              pushLog({
                                level: "info",
                                msg: autoOn
                                  ? "Supertrend futures autotrading ON — BUY sizes to ~available margin × leverage (see Lev. mode below); SELL closes the long on signal (bar close). Start the bot. AI path is paused."
                                  : "Supertrend futures autotrading OFF",
                              });
                            }
                          } catch {
                            pushLog({ level: "error", msg: "Failed to update Supertrend" });
                          }
                        })();
                      });
                    }}
                  />
                  <span>
                    <span
                      className={
                        cfg.marketMode === "FUTURES"
                          ? "font-semibold text-amber-200"
                          : "font-semibold text-emerald-200"
                      }
                    >
                      Autotrade with Supertrend
                    </span>
                    <span className="mt-0.5 block text-[11px] text-slate-600 dark:text-slate-500">
                      {cfg.marketMode === "SPOT" ? (
                        <>
                          Uses your chart timeframe. Signals on bar close. BUY ≈ full spot quote (
                          <code className="text-slate-600 dark:text-slate-400">SUPERTREND_SPOT_NOTIONAL_BUFFER_PCT</code>); SELL exits the
                          full position. Requires <code className="text-slate-600 dark:text-slate-400">MARKET_FEED=BINANCE</code> or futures
                          feed for klines.
                        </>
                      ) : (
                        <>
                          Bar-close Supertrend BUY calls the coin AI (<code className="text-slate-600 dark:text-slate-400">/predict</code>)
                          for confidence: that score drives leverage (AUTO), position size (risk tiers), and SL/TP (ATR +
                          regime + confidence). Exit: take-profit / stop on the exchange, or Supertrend SELL closes the
                          long. Needs ≥30 candles and a running AI service. Optional{" "}
                          <code className="text-slate-600 dark:text-slate-400">SUPERTREND_FUTURES_MIN_AI_PROB</code>. Lev. mode below applies
                          to AUTO leverage.
                        </>
                      )}
                    </span>
                  </span>
                </label>
                <div className="grid grid-cols-[110px_1fr] items-center gap-2 text-xs">
                  <span className="text-slate-600 dark:text-slate-400">ATR period</span>
                  <NumericTextInput
                    value={cfg.supertrendPeriod}
                    inputMode="numeric"
                    min={2}
                    max={100}
                    parse={(raw) => parseInt(raw, 10)}
                    disabled={
                      cfg.marketMode === "SPOT" ? !cfg.supertrendSpotAuto : !cfg.supertrendFuturesAuto
                    }
                    onCommit={async (v) => {
                      try {
                        await api.botConfig({ supertrendPeriod: v });
                      } catch {
                        pushLog({ level: "error", msg: "Failed to set ATR period" });
                      }
                    }}
                  />
                </div>
                <div className="grid grid-cols-[110px_1fr] items-center gap-2 text-xs">
                  <span className="text-slate-600 dark:text-slate-400">Multiplier</span>
                  <NumericTextInput
                    value={cfg.supertrendMultiplier}
                    min={0.5}
                    max={20}
                    disabled={
                      cfg.marketMode === "SPOT" ? !cfg.supertrendSpotAuto : !cfg.supertrendFuturesAuto
                    }
                    onCommit={async (v) => {
                      try {
                        await api.botConfig({ supertrendMultiplier: v });
                      } catch {
                        pushLog({ level: "error", msg: "Failed to set multiplier" });
                      }
                    }}
                  />
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={cfg.supertrendWilderAtr}
                    disabled={
                      cfg.marketMode === "SPOT" ? !cfg.supertrendSpotAuto : !cfg.supertrendFuturesAuto
                    }
                    onChange={(e) => {
                      const checked = e.target.checked;
                      deferTask(() => {
                        void (async () => {
                          try {
                            await api.botConfig({ supertrendWilderAtr: checked });
                          } catch {
                            pushLog({ level: "error", msg: "Failed to set ATR mode" });
                          }
                        })();
                      });
                    }}
                  />
                  Wilder ATR (Pine default). Off = SMA(TR)
                </label>
              </div>
            )}

            {cfg.marketMode !== "SPOT" && (
              <>
                <label className="grid grid-cols-[110px_1fr] items-center gap-2">
                  <span className="text-slate-600 dark:text-slate-400">Lev. mode</span>
                  <select
                    className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-slate-900 dark:text-slate-100"
                    value={cfg.futuresLeverageMode}
                    onChange={(e) => {
                      const v = e.target.value as "AUTO" | "MANUAL";
                      deferTask(() => {
                        void (async () => {
                          try {
                            await api.botConfig({ futuresLeverageMode: v });
                            pushLog({
                              level: "info",
                              msg:
                                v === "AUTO"
                                  ? "Futures leverage: model will choose per trade"
                                  : "Futures leverage: using manual multiplier",
                            });
                          } catch {
                            pushLog({ level: "error", msg: "Failed to set leverage mode" });
                          }
                        })();
                      });
                    }}
                  >
                    <option value="AUTO">AUTO (AI + volatility)</option>
                    <option value="MANUAL">MANUAL (fixed)</option>
                  </select>
                </label>
                {cfg.futuresLeverageMode === "MANUAL" ? (
                  <label className="grid grid-cols-[110px_1fr] items-center gap-2">
                    <span className="text-slate-600 dark:text-slate-400">Leverage ×</span>
                    <NumericTextInput
                      value={cfg.futuresLeverage}
                      inputMode="numeric"
                      min={1}
                      max={100}
                      parse={(raw) => parseInt(raw, 10)}
                      onDraftParsed={(n) => {
                        if (n == null || !Number.isFinite(n)) setFuturesLevDraft(null);
                        else setFuturesLevDraft(clampNum(Math.floor(n), 1, 100));
                      }}
                      onCommit={async (v) => {
                        setFuturesLevDraft(null);
                        try {
                          await api.botConfig({ futuresLeverage: v });
                        } catch {
                          pushLog({ level: "error", msg: "Failed to set futures leverage" });
                        }
                      }}
                    />
                  </label>
                ) : (
                  <div className="grid grid-cols-[110px_1fr] gap-2 text-[11px] leading-snug text-slate-600 dark:text-slate-500">
                    <span className="text-slate-600 dark:text-slate-400">Lev. ×</span>
                    <span>
                      Chosen automatically each trade from model confidence and volatility (conservative caps). Manual
                      value below is ignored until you switch to MANUAL.
                    </span>
                  </div>
                )}
                <div className="grid grid-cols-[110px_1fr] items-center gap-2">
                  <span className="text-slate-600 dark:text-slate-400" title="Stop distance as a fraction of price (Supertrend futures, AI filter off)">
                    ST
                  </span>
                  <NumericTextInput
                    value={cfg.supertrendFuturesFixedSlPct}
                    min={0.00005}
                    max={0.2}
                    disabled={!cfg.supertrendFuturesAuto}
                    onCommit={async (v) => {
                      try {
                        await api.botConfig({ supertrendFuturesFixedSlPct: v });
                      } catch {
                        pushLog({ level: "error", msg: "Failed to set ST (stop) %" });
                      }
                    }}
                  />
                </div>
                <div className="grid grid-cols-[110px_1fr] items-center gap-2">
                  <span className="text-slate-600 dark:text-slate-400" title="Take-profit distance as a fraction of price (Supertrend futures, AI filter off)">
                    TP
                  </span>
                  <NumericTextInput
                    value={cfg.supertrendFuturesFixedTpPct}
                    min={0.00005}
                    max={0.5}
                    disabled={!cfg.supertrendFuturesAuto}
                    onCommit={async (v) => {
                      try {
                        await api.botConfig({ supertrendFuturesFixedTpPct: v });
                      } catch {
                        pushLog({ level: "error", msg: "Failed to set TP %" });
                      }
                    }}
                  />
                </div>
                <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-500">
                  <span className="text-slate-600 dark:text-slate-400">ST</span> / <span className="text-slate-600 dark:text-slate-400">TP</span> apply to{" "}
                  <span className="text-slate-600 dark:text-slate-400">Autotrade with Supertrend</span> on futures when the AI confidence
                  filter is <span className="text-slate-600 dark:text-slate-400">off</span> (same idea as manual SL/TP:{" "}
                  <span className="font-mono text-slate-600 dark:text-slate-500">0.002</span> ≈ 0.2% move).
                </p>
              </>
            )}

            {showRankedCoins && (
              <div className="mt-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40">
                <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 px-3 py-2">
                  <div>
                    <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">Top coins (ranked)</div>
                    {pinnedSymbolNorm ? (
                      <div className="mt-0.5 text-[11px] font-medium text-emerald-300/90">
                        Pinned: {pinnedSymbolNorm} — other rows are locked until you unpin or restart the bot
                      </div>
                    ) : null}
                  </div>
                  <button
                    disabled={coinBusy}
                    className="rounded-md border border-slate-300 dark:border-slate-700 bg-slate-200/65 dark:bg-slate-100 dark:bg-slate-900/50 px-2 py-1 text-[11px] font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:bg-slate-900 disabled:opacity-50"
                    onClick={() => {
                      deferTask(() => {
                        void (async () => {
                          setCoinBusy(true);
                          try {
                            await api.universeScan();
                            pushLog({ level: "info", msg: "Universe scan requested" });
                          } catch {
                            pushLog({ level: "warn", msg: "Universe scan failed" });
                          } finally {
                            setCoinBusy(false);
                          }
                        })();
                      });
                    }}
                  >
                    {coinBusy ? "Scanning…" : "Scan now"}
                  </button>
                </div>
                <div className="max-h-[180px] overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-slate-50 dark:bg-slate-950">
                      <tr className="text-left text-slate-600 dark:text-slate-400">
                        <th className="px-3 py-2">Symbol</th>
                        <th className="px-3 py-2">AI</th>
                        <th className="px-3 py-2">Opp</th>
                        <th className="px-3 py-2">Spr%</th>
                        <th className="px-3 py-2">Pick</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rankedCoins.length === 0 ? (
                        <tr>
                          <td className="px-3 py-3 text-slate-600 dark:text-slate-500" colSpan={5}>
                            No scan results yet (set MARKET_FEED=BINANCE or BINANCE_FUTURES and symbol mode AUTO)
                          </td>
                        </tr>
                      ) : (
                        rankedCoins.map((c: any) => {
                          const symU = String(c.symbol || "").toUpperCase();
                          const isPinnedRow = Boolean(pinnedSymbolNorm) && symU === pinnedSymbolNorm;
                          const rowLockedOut = Boolean(pinnedSymbolNorm) && !isPinnedRow;
                          return (
                            <tr
                              key={c.symbol}
                              className={`border-t border-slate-200 dark:border-slate-900 transition-opacity ${
                                isPinnedRow
                                  ? "bg-emerald-950/35 ring-1 ring-inset ring-emerald-500/40"
                                  : rowLockedOut
                                    ? "pointer-events-none opacity-[0.38]"
                                    : ""
                              }`}
                            >
                              <td className={`px-3 py-2 font-semibold ${isPinnedRow ? "text-emerald-100" : "text-slate-800 dark:text-slate-200"}`}>
                                {c.symbol}
                                {isPinnedRow ? (
                                  <span className="ml-1.5 rounded bg-emerald-600/80 px-1 py-px text-[9px] font-bold uppercase text-white">
                                    pinned
                                  </span>
                                ) : null}
                              </td>
                              <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                                {c.aiProb != null && Number.isFinite(Number(c.aiProb)) ? Number(c.aiProb).toFixed(3) : "—"}
                              </td>
                              <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                                {c.opportunity != null && Number.isFinite(Number(c.opportunity)) ? Number(c.opportunity).toFixed(2) : "—"}
                              </td>
                              <td className="px-3 py-2 text-slate-700 dark:text-slate-300">
                                {c.spreadPct != null && Number.isFinite(Number(c.spreadPct))
                                  ? `${(Number(c.spreadPct) * 100).toFixed(2)}`
                                  : "—"}
                              </td>
                              <td className="px-3 py-2">
                                {isPinnedRow ? (
                                  <button
                                    type="button"
                                    className="rounded-md border border-amber-700/80 bg-amber-950/50 px-2 py-1 text-[11px] font-semibold text-amber-100 hover:bg-amber-900/60"
                                    onClick={() => {
                                      deferTask(() => {
                                        void (async () => {
                                          try {
                                            await api.botConfig({ universePinnedSymbol: null });
                                            pushLog({ level: "info", msg: "Unpinned symbol — auto coin selection resumed" });
                                          } catch {
                                            pushLog({ level: "error", msg: "Failed to unpin" });
                                          }
                                        })();
                                      });
                                    }}
                                  >
                                    Unpin
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    disabled={rowLockedOut}
                                    className="rounded-md border border-slate-300 dark:border-slate-700 bg-slate-200/50 dark:bg-slate-100 dark:bg-slate-900/30 px-2 py-1 text-[11px] font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
                                    onClick={() => {
                                      const sym = symU;
                                      deferTask(() => {
                                        void (async () => {
                                          try {
                                            await api.botConfig({ universePinnedSymbol: sym });
                                            pushLog({ level: "info", msg: "Pinned symbol", symbol: sym });
                                          } catch {
                                            pushLog({ level: "error", msg: "Failed to pin symbol" });
                                          }
                                        })();
                                      });
                                    }}
                                  >
                                    Pin
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="px-3 py-2 text-[11px] text-slate-600 dark:text-slate-500">
                  Selected: <span className="text-slate-700 dark:text-slate-300">{(bot?.universe?.selected || []).join(", ") || "—"}</span>
                </div>
              </div>
            )}

            <label className="grid grid-cols-[110px_1fr] items-center gap-2">
              <span className="text-slate-600 dark:text-slate-400">Strategy</span>
              {cfg.strategyMode === "AUTO" ? (
                <div className="rounded-md border border-slate-200/90 dark:border-slate-800/80 bg-slate-100/95 dark:bg-slate-950/60 px-2 py-1 text-[11px] text-slate-600 dark:text-slate-500">
                  Automatic: regime + model choose EMA / RSI / breakout each bar. Set Mode to MANUAL to pick a fixed
                  strategy.
                </div>
              ) : (
                <select
                  className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-slate-900 dark:text-slate-100"
                  value={cfg.manualStrategy}
                  onChange={(e) => {
                    const v = e.target.value;
                    deferTask(() => {
                      void (async () => {
                        try {
                          await api.botConfig({ manualStrategy: v });
                        } catch {
                          pushLog({ level: "error", msg: "Failed to set manual strategy" });
                        }
                      })();
                    });
                  }}
                >
                  {STRATS.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
              )}
            </label>

            {cfg.strategyMode === "MANUAL" && (
              <div className="mt-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40">
                <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 px-3 py-2">
                  <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">Top strategies (backtest)</div>
                  <div className="text-[11px] text-slate-600 dark:text-slate-500">{btLoading ? "running…" : "last 700 candles"}</div>
                </div>
                <div className="max-h-[180px] overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-slate-50 dark:bg-slate-950">
                      <tr className="text-left text-slate-600 dark:text-slate-400">
                        <th className="px-3 py-2">Key</th>
                        <th className="px-3 py-2">Trades</th>
                        <th className="px-3 py-2">Win%</th>
                        <th className="px-3 py-2">PF</th>
                        <th className="px-3 py-2">PnL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {top.length === 0 ? (
                        <tr>
                          <td className="px-3 py-3 text-slate-600 dark:text-slate-500" colSpan={5}>
                            No backtest results yet
                          </td>
                        </tr>
                      ) : (
                        top.map((r) => (
                          <tr key={r.key} className="border-t border-slate-200 dark:border-slate-900">
                            <td className="px-3 py-2">
                              <button
                                className="font-semibold text-slate-800 dark:text-slate-200 hover:text-emerald-300"
                                onClick={() => {
                                  const key = r.key;
                                  deferTask(() => {
                                    void (async () => {
                                      try {
                                        await api.botConfig({ manualStrategy: key });
                                      } catch {
                                        pushLog({ level: "error", msg: "Failed to set manual strategy" });
                                      }
                                    })();
                                  });
                                }}
                              >
                                {r.key}
                              </button>
                              <div className="text-[11px] text-slate-600 dark:text-slate-500">{r.name}</div>
                            </td>
                            <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{r.trades}</td>
                            <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{(Number(r.winRate || 0) * 100).toFixed(1)}</td>
                            <td className="px-3 py-2 text-slate-700 dark:text-slate-300">{Number(r.profitFactor || 0).toFixed(2)}</td>
                            <td className={`px-3 py-2 ${Number(r.netPnl || 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                              {Number(r.netPnl || 0).toFixed(2)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <label className="grid grid-cols-[110px_1fr] items-center gap-2">
              <span className="text-slate-600 dark:text-slate-400">AI threshold</span>
              <NumericTextInput
                value={cfg.aiThreshold}
                min={0}
                max={1}
                onCommit={async (v) => {
                  try {
                    await api.botConfig({ aiThreshold: v });
                  } catch {
                    pushLog({ level: "error", msg: "Failed to set AI threshold" });
                  }
                }}
              />
            </label>

            {cfg.marketMode !== "SPOT" && cfg.supertrendFuturesAuto && (
              <div className="rounded-md border border-slate-200/90 dark:border-slate-800/80 bg-white/85 dark:bg-slate-950/30 px-2 py-2">
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={cfg.supertrendFuturesAiConfidenceFilter}
                    onChange={(e) => {
                      const filterOn = e.currentTarget.checked;
                      const minProbPct = (cfg.supertrendFuturesMinAiProb * 100).toFixed(0);
                      deferTask(() => {
                        void (async () => {
                          try {
                            await api.botConfig({ supertrendFuturesAiConfidenceFilter: filterOn });
                            pushLog({
                              level: "info",
                              msg: filterOn
                                ? `Supertrend futures: AI confidence filter ON — opens need AI ≥ ${minProbPct}% (slider) + AI sizing tiers`
                                : "Supertrend futures: AI confidence filter OFF — signal strength drives sizing tiers; min AI prob skipped",
                            });
                          } catch {
                            pushLog({ level: "error", msg: "Failed to update Supertrend AI filter" });
                          }
                        })();
                      });
                    }}
                  />
                  <span className="min-w-0 flex-1 text-xs leading-snug text-slate-700 dark:text-slate-300">
                    <span className="font-semibold text-slate-800 dark:text-slate-200">AI confidence filter (Supertrend futures)</span>
                    <span className="mt-0.5 block text-[11px] text-slate-600 dark:text-slate-500">
                      When <span className="text-slate-600 dark:text-slate-400">on</span>, bar-close opens must meet the minimum AI probability
                      below (unlock to change). Uses AI for risk tiers. When <span className="text-slate-600 dark:text-slate-400">off</span>, that
                      gate is skipped and position size follows chart signal strength (and a safe sizing floor).
                    </span>
                  </span>
                </label>
                <div className="mt-2 flex items-center gap-2 pl-6">
                  <span className="w-[7.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Min AI prob</span>
                  <ThresholdSliderWithLock
                    ariaLabel="Minimum AI probability for Supertrend futures (percent)"
                    serverSliderUnits={Math.round(cfg.supertrendFuturesMinAiProb * 100)}
                    formatDisplay={(u) => `${u}%`}
                    onDebouncedCommit={(u) => {
                      const p = clampNum(u / 100, 0, 1);
                      void api.botConfig({ supertrendFuturesMinAiProb: Number(p.toFixed(3)) }).catch(() => {
                        pushLog({ level: "error", msg: "Failed to set min AI probability" });
                      });
                    }}
                  />
                </div>
              </div>
            )}
            {(cfg.supertrendSpotAuto || cfg.supertrendFuturesAuto) && (
              <div className="rounded-md border border-slate-200/90 dark:border-slate-800/80 bg-white/85 dark:bg-slate-950/30 px-2 py-2">
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={cfg.signalStrengthGatesTrades}
                    onChange={(e) => {
                      const gatesOn = e.currentTarget.checked;
                      const openMin = cfg.signalStrengthOpenMin;
                      deferTask(() => {
                        void (async () => {
                          try {
                            await api.botConfig({ signalStrengthGatesTrades: gatesOn });
                            pushLog({
                              level: "info",
                              msg: gatesOn
                                ? `Signal strength gates opens ON — opens need strength ≥ ${openMin} and matching direction`
                                : "Signal strength gates opens OFF — composite strength is logged/UI only; Supertrend flips are not blocked by the engine",
                            });
                          } catch {
                            pushLog({ level: "error", msg: "Failed to update signal strength gate" });
                          }
                        })();
                      });
                    }}
                  />
                  <span className="min-w-0 flex-1 text-xs leading-snug text-slate-700 dark:text-slate-300">
                    <span className="font-semibold text-slate-800 dark:text-slate-200">Signal strength gates Supertrend opens</span>
                    <span className="mt-0.5 block text-[11px] text-slate-600 dark:text-slate-500">
                      When <span className="text-slate-600 dark:text-slate-400">off</span> (default), the composite engine still computes 0–100
                      strength for the UI — it does not block orders. When <span className="text-slate-600 dark:text-slate-400">on</span>, spot and
                      futures <span className="text-slate-600 dark:text-slate-400">opening</span> legs after a bar-close signal require composite
                      strength at least the threshold below (unlock to change) and a matching BUY/SELL. Closes are unchanged.
                    </span>
                  </span>
                </label>
                <div className="mt-2 flex items-center gap-2 pl-6">
                  <span className="w-[7.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Min strength</span>
                  <ThresholdSliderWithLock
                    ariaLabel="Minimum composite signal strength to allow Supertrend opens"
                    serverSliderUnits={cfg.signalStrengthOpenMin}
                    formatDisplay={(u) => `${u}`}
                    onDebouncedCommit={(u) => {
                      void api.botConfig({ signalStrengthOpenMin: Math.round(clampNum(u, 0, 100)) }).catch(() => {
                        pushLog({ level: "error", msg: "Failed to set min signal strength" });
                      });
                    }}
                  />
                </div>
              </div>
            )}
            {cfg.marketMode !== "SPOT" && !cfg.supertrendFuturesAuto && (
              <p className="text-[11px] leading-snug text-slate-600 dark:text-slate-500">
                Supertrend futures AI confidence filter resets to <span className="text-slate-600 dark:text-slate-400">on</span> (default).
                {cfg.marketMode === "FUTURES" ? (
                  <>
                    {" "}
                    Enable <span className="text-slate-600 dark:text-slate-400">Autotrade with Supertrend</span> above to configure them.
                  </>
                ) : (
                  <>
                    {" "}
                    Set market to <span className="text-slate-600 dark:text-slate-400">FUTURES</span> and enable Autotrade with Supertrend to
                    configure it.
                  </>
                )}
              </p>
            )}

            <div className="grid grid-cols-[100px_auto_1fr] items-center gap-x-2 gap-y-1">
              <span className="text-slate-600 dark:text-slate-400">Risk / trade</span>
              <RiskUnitToggle
                value={cfg.riskPerTradeUnit}
                onChange={(u) => {
                  deferTask(() => {
                    void (async () => {
                      try {
                        await api.botConfig({ riskPerTradeUnit: u });
                      } catch {
                        pushLog({ level: "error", msg: "Failed to set risk unit" });
                      }
                    })();
                  });
                }}
              />
              <NumericTextInput
                key={`rpt-${cfg.riskPerTradeUnit}`}
                value={cfg.riskPerTrade}
                min={cfg.riskPerTradeUnit === "USDT" ? 1 : 0.001}
                max={cfg.riskPerTradeUnit === "USDT" ? 10_000_000 : 0.05}
                onCommit={async (v) => {
                  try {
                    await api.botConfig({ riskPerTrade: v });
                  } catch {
                    pushLog({ level: "error", msg: "Failed to set risk per trade" });
                  }
                }}
              />
            </div>
            <p className="mb-2 text-[10px] leading-snug text-slate-600 dark:text-slate-500">
              {cfg.riskPerTradeUnit === "USDT" ? (
                cfg.maxDailyLossUnit === "USDT" ? (
                  <>
                    <span className="text-slate-600 dark:text-slate-400">Fixed USDT capital</span> per trade:{" "}
                    <span className="text-slate-600 dark:text-slate-400">100%</span> of this value as order notional (no AI confidence sizing or
                    entry threshold). Capped by ~90% buying power. SL/TP from ATR only (no AI bracket tweak).
                  </>
                ) : (
                  <>
                    <span className="text-slate-600 dark:text-slate-400">Investing capital</span> per autotrade: target order size in{" "}
                    <span className="text-slate-600 dark:text-slate-400">USDT notional</span> (scaled by confidence tiers), capped by available
                    buying power (~90%). Stops still set risk from ATR.
                  </>
                )
              ) : (
                <>
                  Fraction of <span className="text-slate-600 dark:text-slate-400">free balance</span> (0.1%–5%) at stop before tiers.
                </>
              )}
            </p>
            {minNotionalUi.length > 0 ? (
              <div className="mb-2 space-y-1 rounded-md border border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-950/40 p-2 text-[10px] leading-snug">
                {minNotionalUi.map((row) => (
                  <div
                    key={row.key}
                    className={row.warn ? "text-amber-800 dark:text-amber-200" : "text-slate-600 dark:text-slate-500"}
                  >
                    {row.text}
                  </div>
                ))}
              </div>
            ) : constraintsRaw?.ok === false ? (
              <div className="mb-2 text-[10px] text-slate-600 dark:text-slate-500">
                Could not load Binance min-notional rules for {activeSymbol}.
              </div>
            ) : null}

            <div className="grid grid-cols-[100px_auto_1fr] items-center gap-x-2 gap-y-1">
              <span className="text-slate-600 dark:text-slate-400">Max daily loss</span>
              <RiskUnitToggle
                value={cfg.maxDailyLossUnit}
                onChange={(u) => {
                  deferTask(() => {
                    void (async () => {
                      try {
                        await api.botConfig({ maxDailyLossUnit: u });
                      } catch {
                        pushLog({ level: "error", msg: "Failed to set max daily loss unit" });
                      }
                    })();
                  });
                }}
              />
              <NumericTextInput
                key={`mdl-${cfg.maxDailyLossUnit}`}
                value={cfg.maxDailyLoss}
                min={cfg.maxDailyLossUnit === "USDT" ? 1 : 0.01}
                max={cfg.maxDailyLossUnit === "USDT" ? 10_000_000 : 0.2}
                onCommit={async (v) => {
                  try {
                    await api.botConfig({ maxDailyLoss: v });
                  } catch {
                    pushLog({ level: "error", msg: "Failed to set max daily loss" });
                  }
                }}
              />
            </div>
            <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-500">
              {cfg.maxDailyLossUnit === "USDT" ? (
                <>
                  <span className="text-slate-600 dark:text-slate-400">Daily loss limit</span> in USD (not per-trade size). With{" "}
                  <span className="text-slate-600 dark:text-slate-400">Risk / trade</span> also in USDT, the bot uses fixed notional and skips AI
                  gates for entry size. Halt when a venue’s <span className="text-slate-600 dark:text-slate-400">day PnL</span> vs UTC-day baseline
                  reaches this loss (hybrid: spot and futures checked separately). Needs reliable day-start equity from the exchange.
                </>
              ) : (
                <>
                  Halt when today’s <span className="text-slate-600 dark:text-slate-400">return vs day start</span> falls below{" "}
                  <span className="text-slate-600 dark:text-slate-400">−(this fraction)</span> on any venue.
                </>
              )}
            </p>
        </div>
      </div>

      {showManualOrders && (
        <div className="mt-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40 p-3">
          <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">Manual trade</div>
          <div className="mt-1 text-[10px] leading-snug text-slate-600 dark:text-slate-500">
            Stop-loss and take-profit are fractions of price (e.g. <span className="font-mono text-slate-600 dark:text-slate-400">0.02</span>{" "}
            = 2%). Backend rejects values outside ~0.1%–20% SL and ~0.1%–50% TP.
          </div>
          <div className="mt-2 grid gap-2 text-xs">
            <label className="grid grid-cols-[110px_1fr] items-center gap-2">
              <span className="text-slate-600 dark:text-slate-400">Amount (USD)</span>
              <div className="min-w-0">
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  className={numericInputClass}
                  value={amountUsdStr}
                  onChange={(e) => setAmountUsdStr(e.target.value)}
                />
                {manualNotionalWarnings.length > 0 ? (
                  <div className="mt-1 space-y-0.5 text-[10px] leading-snug text-amber-800 dark:text-amber-200">
                    {manualNotionalWarnings.map((t, i) => (
                      <div key={i}>{t}</div>
                    ))}
                  </div>
                ) : null}
              </div>
            </label>
            <label className="grid grid-cols-[110px_1fr] items-center gap-2">
              <span className="text-slate-600 dark:text-slate-400">Stop-loss</span>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                className={numericInputClass}
                value={slPctStr}
                onChange={(e) => setSlPctStr(e.target.value)}
              />
            </label>
            <label className="grid grid-cols-[110px_1fr] items-center gap-2">
              <span className="text-slate-600 dark:text-slate-400">Take-profit</span>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                className={numericInputClass}
                value={tpPctStr}
                onChange={(e) => setTpPctStr(e.target.value)}
              />
            </label>
            <div className="mt-2 flex gap-2">
              <button
                disabled={manualOrderBusy}
                className="flex-1 rounded-md bg-emerald-600/80 px-3 py-2 font-semibold hover:bg-emerald-600 disabled:opacity-50"
                onClick={() => {
                  if (manualOrderBusy) return;
                  const amountUsd = parseFloat(amountUsdStr.replace(/,/g, "."));
                  const slPct = parseFloat(slPctStr.replace(/,/g, "."));
                  const tpPct = parseFloat(tpPctStr.replace(/,/g, "."));
                  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
                    pushLog({ level: "warn", msg: "Enter a valid amount (USD)" });
                    return;
                  }
                  if (!Number.isFinite(slPct) || !Number.isFinite(tpPct)) {
                    pushLog({ level: "warn", msg: "Enter valid stop-loss and take-profit" });
                    return;
                  }
                  deferTask(() => {
                    void (async () => {
                      setManualOrderBusy(true);
                      try {
                        const out = await api.manualTrade({
                          side: "BUY",
                          amountUsd,
                          stopLossPct: slPct,
                          takeProfitPct: tpPct,
                        });
                        pushLog({ level: "info", msg: "Manual BUY accepted", ...(out && typeof out === "object" ? out : {}) });
                      } catch (e: any) {
                        pushLog({ level: "error", msg: "Manual BUY failed", error: String(e?.message || e) });
                      } finally {
                        setManualOrderBusy(false);
                      }
                    })();
                  });
                }}
              >
                Buy
              </button>
              <button
                disabled={manualOrderBusy}
                className="flex-1 rounded-md bg-rose-600/80 px-3 py-2 font-semibold hover:bg-rose-600 disabled:opacity-50"
                onClick={() => {
                  if (manualOrderBusy) return;
                  const amountUsd = parseFloat(amountUsdStr.replace(/,/g, "."));
                  const slPct = parseFloat(slPctStr.replace(/,/g, "."));
                  const tpPct = parseFloat(tpPctStr.replace(/,/g, "."));
                  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
                    pushLog({ level: "warn", msg: "Enter a valid amount (USD)" });
                    return;
                  }
                  if (!Number.isFinite(slPct) || !Number.isFinite(tpPct)) {
                    pushLog({ level: "warn", msg: "Enter valid stop-loss and take-profit" });
                    return;
                  }
                  deferTask(() => {
                    void (async () => {
                      setManualOrderBusy(true);
                      try {
                        const out = await api.manualTrade({
                          side: "SELL",
                          amountUsd,
                          stopLossPct: slPct,
                          takeProfitPct: tpPct,
                        });
                        pushLog({ level: "info", msg: "Manual SELL accepted", ...(out && typeof out === "object" ? out : {}) });
                      } catch (e: any) {
                        pushLog({ level: "error", msg: "Manual SELL failed", error: String(e?.message || e) });
                      } finally {
                        setManualOrderBusy(false);
                      }
                    })();
                  });
                }}
              >
                Sell
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

