import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { deferTask } from "../lib/deferTask";
import { useAppStore } from "../ws/store";
import { UniverseCustomCoinsModal } from "./UniverseCustomCoinsModal";
import {
  buildAutotradeLongLiquidationPreview,
  DEFAULT_MAINTENANCE_MARGIN_RATE,
  manualMarketLiquidationPreview,
  riskTierMultPreview,
} from "../lib/futuresLiquidation";

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

/** Parse manual SL/TP %: trim, strip % / full-width percent, Unicode minus, comma decimals. */
function parseManualPercentField(raw: string): number | null {
  const t = String(raw ?? "")
    .trim()
    .replace(/\u2212/g, "-")
    .replace(/%/g, "")
    .replace(/％/g, "")
    .replace(/,/g, ".")
    .replace(/\s+/g, "");
  if (!t) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

function parseTrailingExtraPcts(bot: unknown): number[] {
  const raw =
    bot && typeof bot === "object" && "trailingStopExtraScalpingPcts" in bot
      ? (bot as { trailingStopExtraScalpingPcts?: unknown }).trailingStopExtraScalpingPcts
      : null;
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const x of raw) {
    const n = Number(x);
    if (Number.isFinite(n) && n > 0) out.push(clampNum(n, 0.01, 5));
    if (out.length >= 3) break;
  }
  return out;
}

/** Optional % of entry for trailing extras; empty clears that slot (commits on blur / Enter). */
function OptionalTrailingPctInput({
  value,
  min,
  max,
  onCommit,
}: {
  value: number | undefined;
  min: number;
  max: number;
  onCommit: (v: number | undefined) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(null);
  }, [value, focused]);

  const base =
    value != null && Number.isFinite(value) ? String(value) : "";
  const shown = focused && draft !== null ? draft : base;

  const commit = async () => {
    const raw = (draft ?? base).replace(/,/g, ".").trim();
    setFocused(false);
    setDraft(null);
    if (raw === "" || raw === "-" || raw === ".") {
      if (value !== undefined) await onCommit(undefined);
      return;
    }
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return;
    const n2 = clampNum(n, min, max);
    if (value !== undefined && Math.abs(n2 - value) < 1e-12) return;
    await onCommit(n2);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      className={numericInputClass}
      placeholder="—"
      value={shown}
      onFocus={() => {
        setFocused(true);
        setDraft(base);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

/**
 * Legacy manual form stored SL/TP as fractions of price (e.g. 0.002 = 0.2%).
 * Now the UI uses percent (e.g. 0.2 = 0.2%). Migrate small legacy pairs only.
 */
function migrateManualSlTpFractionToPercentStrings(slStr: string, tpStr: string): { sl: string; tp: string } {
  const sl = parseFloat(slStr.replace(/,/g, "."));
  const tp = parseFloat(tpStr.replace(/,/g, "."));
  if (!Number.isFinite(sl) || !Number.isFinite(tp)) return { sl: slStr, tp: tpStr };
  if (sl > 0 && sl < 0.05 && tp > 0 && tp < 0.05) {
    return { sl: String(sl * 100), tp: String(tp * 100) };
  }
  return { sl: slStr, tp: tpStr };
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

/** Ranked top-table symbols used for multi budget UI / EQUAL divisor (matches backend `symbolsForMultiBudgetList`). */
function multiBudgetSymbolsForUi(bot: any): string[] {
  if (String(bot?.universeCoinSelectMode || "").toUpperCase() !== "MULTIPLE") return [];
  const ranked = Array.isArray(bot?.universe?.ranked) ? (bot.universe.ranked as any[]) : [];
  const rankedSyms = ranked
    .slice(0, 12)
    .map((r) => String(r?.symbol || "").trim().toUpperCase())
    .filter(Boolean);
  const pins = Array.isArray(bot?.universePinnedSymbols)
    ? [...new Set((bot.universePinnedSymbols as unknown[]).map((s) => String(s || "").trim().toUpperCase()).filter(Boolean))]
    : [];
  const manual = String(bot?.universePinControl || "").toUpperCase() === "MANUAL";
  if (manual && pins.length > 0) {
    const setR = new Set(rankedSyms);
    const inTable = pins.filter((p) => setR.has(p));
    return inTable.length > 0 ? inTable : pins;
  }
  return rankedSyms.slice(0, 10);
}

function derivedMultiBudgetSplitMode(bot: any): "FULL" | "EQUAL" | "CUSTOM_USDT" | "CUSTOM_PCT_ALLOWED" {
  const m = String(bot?.multiBudgetSplitMode || "").toUpperCase();
  if (m === "FULL" || m === "EQUAL" || m === "CUSTOM_USDT" || m === "CUSTOM_PCT_ALLOWED") return m as any;
  return bot?.capitalSplitAcrossCoins === true ? "EQUAL" : "FULL";
}

/** Matches backend `positionMarginUsedUsdt`: futures ≈ notional/leverage; spot = full quote at entry. */
function positionMarginUsedUsdtForUi(p: any): number {
  const qty = Math.abs(Number(p?.qty ?? p?.positionAmt ?? 0));
  if (!(qty > 0)) return 0;
  const ep = Number(p?.entryPrice || 0);
  let notional = 0;
  if (Number.isFinite(ep) && ep > 0) notional = qty * ep;
  else {
    const mp = Number(p?.markPrice ?? p?.mark ?? 0);
    if (Number.isFinite(mp) && mp > 0) notional = qty * mp;
  }
  if (!(notional > 0)) return 0;
  const ven = String(p?.venue || "").toUpperCase();
  if (ven === "FUTURES") {
    const levRaw = Number(p?.leverage);
    const lev = Math.max(1, Math.floor(Number.isFinite(levRaw) && levRaw > 0 ? levRaw : 1));
    return notional / lev;
  }
  return notional;
}

function sumOpenMarginUsedUsdtForUi(positions: any[] | undefined, marketMode: string): number {
  const mm = String(marketMode || "AUTO").toUpperCase();
  const rows = Array.isArray(positions) ? positions : [];
  let sum = 0;
  for (const p of rows) {
    const ven = String(p?.venue || "").toUpperCase();
    if (mm === "SPOT" && ven !== "SPOT") continue;
    if (mm === "FUTURES" && ven !== "FUTURES") continue;
    if (mm === "AUTO" && ven && ven !== "SPOT" && ven !== "FUTURES") continue;
    sum += positionMarginUsedUsdtForUi(p);
  }
  return sum;
}

/** Free margin (USDT) — matches backend `walletFreeMarginUsdtForAllowedCap` for allowed / % slider caps. */
function walletFreeMarginUsdt(account: any, marketMode: string): number {
  const mm = String(marketMode || "AUTO").toUpperCase();
  const v = account?.venues;
  const spotF = v?.spot?.freeBalance != null && Number.isFinite(Number(v.spot.freeBalance)) ? Number(v.spot.freeBalance) : 0;
  const futF = v?.futures?.freeBalance != null && Number.isFinite(Number(v.futures.freeBalance)) ? Number(v.futures.freeBalance) : 0;
  if (mm === "SPOT") return spotF;
  if (mm === "FUTURES") return futF;
  return spotF + futF;
}

/** Strategy allowed margin pool (USDT), never above free margin (not leveraged buying power). */
function effectiveAllowedPoolUsdt(bot: any, account: any): number {
  const mm = String(bot?.marketMode || "AUTO").toUpperCase();
  const fixedUsd =
    String(bot?.riskPerTradeUnit || "").toUpperCase() === "USDT" && String(bot?.maxDailyLossUnit || "").toUpperCase() === "USDT";
  const raw = Number(bot?.allowedBudgetUsdt);
  const poolNominal =
    fixedUsd && Number.isFinite(raw) && raw > 0
      ? raw
      : String(bot?.riskPerTradeUnit || "").toUpperCase() === "USDT"
        ? Number(bot?.riskPerTrade ?? 0)
        : 0;
  if (!fixedUsd || !Number.isFinite(poolNominal) || poolNominal <= 0) return poolNominal;
  const cap = walletFreeMarginUsdt(account, mm);
  if (!Number.isFinite(cap) || cap <= 0) return poolNominal;
  return Math.min(poolNominal, cap);
}

/** Per-symbol fixed-USDT order notional target (before venue ~90% cap), mirrors backend `resolveFixedUsdtRiskForOrder`. */
function previewFixedUsdtRiskUsdt(bot: any, symbol: string, positions: any[] | undefined, account: any): number {
  const fixed =
    String(bot?.riskPerTradeUnit || "").toUpperCase() === "USDT" && String(bot?.maxDailyLossUnit || "").toUpperCase() === "USDT";
  if (!fixed) return Number(bot?.riskPerTrade ?? 0);
  const mm = String(bot?.marketMode || "AUTO").toUpperCase();
  const cap = walletFreeMarginUsdt(account, mm);
  const capOk = Number.isFinite(cap) && cap > 0;
  if (String(bot?.universeCoinSelectMode || "").toUpperCase() !== "MULTIPLE") {
    const r = Number(bot?.riskPerTrade ?? 0);
    return capOk ? Math.min(r, cap) : r;
  }
  const mode = derivedMultiBudgetSplitMode(bot);
  const list = multiBudgetSymbolsForUi(bot);
  const nDiv = Math.max(1, list.length);
  const sym = String(symbol || "").toUpperCase();
  const allowed = effectiveAllowedPoolUsdt(bot, account);
  const invested = sumOpenMarginUsedUsdtForUi(positions, String(bot?.marketMode || "AUTO"));
  const usable = Math.max(0, allowed - invested);
  if (mode === "CUSTOM_USDT") {
    const v = Number((bot?.multiBudgetCoinUsdt as Record<string, number> | undefined)?.[sym]);
    return Number.isFinite(v) && v >= 1 ? v : Number(bot?.riskPerTrade ?? 0);
  }
  if (mode === "CUSTOM_PCT_ALLOWED") {
    const pc = Number((bot?.multiBudgetCoinPct as Record<string, number> | undefined)?.[sym]);
    return Number.isFinite(pc) && pc > 0 ? allowed * (clampNum(pc, 0, 100) / 100) : Number(bot?.riskPerTrade ?? 0);
  }
  const usePct = bot?.multiTradeUsePctOfUsable === true;
  const p = clampNum(Number(bot?.multiTradePctOfUsable ?? 100), 0, 100);
  const basePool = usePct ? (usable * p) / 100 : Number(bot?.riskPerTrade ?? 0);
  if (mode === "EQUAL") return Math.max(1e-9, basePool / nDiv);
  return Math.max(1e-9, basePool);
}

/** Mirrors backend split divisor / per-leg sizing hint for min-notional and liquidation previews. */
function capitalSplitDivisorFromBot(bot: any): number {
  if (String(bot?.riskPerTradeUnit || "").toUpperCase() !== "USDT" || String(bot?.maxDailyLossUnit || "").toUpperCase() !== "USDT") {
    return 1;
  }
  if (String(bot?.universeCoinSelectMode || "").toUpperCase() !== "MULTIPLE") return 1;
  const mode = derivedMultiBudgetSplitMode(bot);
  if (mode === "EQUAL") return Math.max(1, multiBudgetSymbolsForUi(bot).length);
  return 1;
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
  accentClassName = "accent-emerald-500",
}: {
  serverSliderUnits: number;
  disabled?: boolean;
  onDebouncedCommit: (sliderUnits: number) => void;
  formatDisplay: (sliderUnits: number) => string;
  ariaLabel: string;
  /** Tailwind `accent-*` for the range input (e.g. Indicators section uses violet). */
  accentClassName?: string;
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
        className={`h-2 min-w-0 flex-1 cursor-pointer disabled:cursor-not-allowed disabled:opacity-45 ${accentClassName}`}
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
  { key: "SURF_PULSE_ML", label: "SurfPulse ML (trend + pullback + XGBoost)" },
  { key: "EMA_CROSS", label: "Trend (EMA crossover)" },
  { key: "RSI_MEAN", label: "Mean Reversion (RSI)" },
  { key: "BREAKOUT_VOL", label: "Breakout (Volume)" },
];

export function TradingPanel() {
  const bot = useAppStore((s) => s.bot);
  const account = useAppStore((s) => s.account);
  const positions = useAppStore((s) => s.positions);
  const pushLog = useAppStore((s) => s.pushLog);
  const [top, setTop] = useState<any[]>([]);
  const [btLoading, setBtLoading] = useState(false);
  const [coinBusy, setCoinBusy] = useState(false);
  const [customUniverseOpen, setCustomUniverseOpen] = useState(false);
  // Bot configuration is always visible; this toggle only controls manual orders visibility below it.
  const [showManualOrders, setShowManualOrders] = useState(false);

  const [amountUsdStr, setAmountUsdStr] = useState("200");
  const [slPctStr, setSlPctStr] = useState("0.2");
  const [tpPctStr, setTpPctStr] = useState("1.5");
  const [manualOrderBusy, setManualOrderBusy] = useState(false);
  const manualFormHydratedRef = useRef(false);
  const skipManualFormPersistRef = useRef(true);
  const capitalSliderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Local % while dragging deployable slider; cleared when server `riskPerTrade` updates. */
  const [capitalSliderDraftPct, setCapitalSliderDraftPct] = useState<number | null>(null);

  useEffect(() => {
    const d = bot?.tradingFormDefaults as { amountUsdStr?: string; slPctStr?: string; tpPctStr?: string } | undefined;
    if (!d || manualFormHydratedRef.current) return;
    if (typeof d.amountUsdStr === "string") setAmountUsdStr(d.amountUsdStr);
    if (typeof d.slPctStr === "string" && typeof d.tpPctStr === "string") {
      const m = migrateManualSlTpFractionToPercentStrings(d.slPctStr, d.tpPctStr);
      setSlPctStr(m.sl);
      setTpPctStr(m.tp);
    } else {
      if (typeof d.slPctStr === "string") setSlPctStr(d.slPctStr);
      if (typeof d.tpPctStr === "string") setTpPctStr(d.tpPctStr);
    }
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
      surfPulseMlThreshold: clampNum(Number(bot?.surfPulseMlThreshold ?? 0.6), 0, 1),
      trailingStopLossAuto: bot?.trailingStopLossAuto === true,
      futuresTrailingStopMode:
        String(bot?.futuresTrailingStopMode || "SUPERTREND").toUpperCase() === "FEE_LADDER" ? "FEE_LADDER" : "SUPERTREND",
      trailingStopExtraScalpingPcts: parseTrailingExtraPcts(bot),
      supertrendFuturesFixedSlPct: clampNum(Number(bot?.supertrendFuturesFixedSlPct ?? 0.002), 0.00005, 0.2),
      supertrendFuturesFixedTpPct: clampNum(Number(bot?.supertrendFuturesFixedTpPct ?? 0.015), 0.00005, 0.5),
      supertrendFuturesTwoWay: bot?.supertrendFuturesTwoWay === true,
      universeCoinBase: bot?.universeCoinBase === "CUSTOM" ? ("CUSTOM" as const) : ("ALL" as const),
      universeCoinSelectMode: bot?.universeCoinSelectMode === "MULTIPLE" ? ("MULTIPLE" as const) : ("SINGLE" as const),
      universePinControl: bot?.universePinControl === "MANUAL" ? ("MANUAL" as const) : ("AUTO" as const),
      universeAutoCoinPick: bot?.universeAutoCoinPick === "ST_SIGNAL_FIRST" ? ("ST_SIGNAL_FIRST" as const) : ("RANKED_AI_SS" as const),
      universeCustomSymbols: Array.isArray(bot?.universeCustomSymbols)
        ? (bot.universeCustomSymbols as unknown[]).map((s) => String(s || "").trim().toUpperCase())
        : [],
      capitalSplitAcrossCoins: bot?.capitalSplitAcrossCoins === true,
      allowedBudgetUsdt: Number(bot?.allowedBudgetUsdt ?? 0),
      allowedBudgetWalletPct: clampNum(Number(bot?.allowedBudgetWalletPct ?? 0), 0, 100),
      allowedBudgetInputMode: bot?.allowedBudgetInputMode === "WALLET_PCT" ? ("WALLET_PCT" as const) : ("USDT" as const),
      multiTradeUsePctOfUsable: bot?.multiTradeUsePctOfUsable === true,
      multiTradePctOfUsable: clampNum(Number(bot?.multiTradePctOfUsable ?? 100), 0, 100),
      multiBudgetSplitMode: derivedMultiBudgetSplitMode(bot),
      multiBudgetCoinUsdt: (bot?.multiBudgetCoinUsdt && typeof bot.multiBudgetCoinUsdt === "object"
        ? (bot.multiBudgetCoinUsdt as Record<string, number>)
        : {}) as Record<string, number>,
      multiBudgetCoinPct: (bot?.multiBudgetCoinPct && typeof bot.multiBudgetCoinPct === "object"
        ? (bot.multiBudgetCoinPct as Record<string, number>)
        : {}) as Record<string, number>,
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

  const atr14 = useAppStore((s) => {
    const raw = s.market?.indicators?.atr_14;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
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
    const effRiskUsdt =
      cfg.riskPerTradeUnit === "USDT" && cfg.maxDailyLossUnit === "USDT"
        ? previewFixedUsdtRiskUsdt(bot, activeSymbol, positions, account)
        : cfg.riskPerTrade;
    if (cfg.riskPerTradeUnit === "USDT") {
      if (needFut && legs.fut) {
        const { min: futMin, qa: futQa } = legs.fut;
        const levLabel =
          String(cfg.futuresLeverageMode || "AUTO").toUpperCase() === "MANUAL"
            ? `Leverage × ${levFutures}`
            : `AUTO ~${levFutures}x`;
        const maxAff = futFree != null ? futFree * levFutures * 0.9 : null;
        const orderNom = maxAff != null ? Math.min(effRiskUsdt, maxAff) : effRiskUsdt;
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
            text: `Futures: order notional ≈ ${orderNom.toFixed(2)} ${futQa} (min of per-trade budget and ${levLabel} cap × ~90% margin) — below min ${futMin.toFixed(2)} ${futQa} for ${activeSymbol}. Raise the USDT budget and/or Leverage ×, or add margin.`,
          });
        }
      }
      if (needSpot && legs.spot) {
        if (effRiskUsdt + 1e-9 < legs.spot.min) {
          lines.push({
            key: "risk-spot",
            text: `Per-trade budget (${effRiskUsdt.toFixed(2)} USDT) is below spot min notional (${legs.spot.min.toFixed(2)} ${legs.spot.qa}).`,
            warn: true,
          });
        } else if (spotFree != null) {
          const eff = effectiveSpotOrderNotionalUsdt(effRiskUsdt, spotFree);
          if (eff != null && eff + 1e-9 < legs.spot.min) {
            lines.push({
              key: "risk-spot-cap",
              text: `Spot: after ~90% of free ${legs.spot.qa}, effective notional ≈ ${eff.toFixed(2)} — below min ${legs.spot.min.toFixed(2)} ${legs.spot.qa}. Add spot quote balance or raise the USDT budget.`,
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
    activeSymbol,
    marketClose,
    account,
    bot?.lastRegime?.type,
    bot?.lastRegime?.atrPct,
    bot?.lastAi?.probability,
    bot?.lastAi?.gateProbability,
    cfg.capitalSplitAcrossCoins,
    bot?.universeCoinSelectMode,
    bot?.universePinnedSymbols,
    futuresLevDraft,
    bot,
    positions,
    cfg.allowedBudgetUsdt,
    cfg.multiBudgetSplitMode,
    bot?.multiTradeUsePctOfUsable,
    bot?.multiBudgetCoinUsdt,
    bot?.multiBudgetCoinPct,
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

  const futuresAutotradeLiqUi = useMemo(() => {
    const mm = String(cfg.marketMode || "AUTO").toUpperCase();
    if (mm === "SPOT") return { kind: "spot_only" as const };
    if (cfg.riskPerTradeUnit !== "USDT") return { kind: "pct_risk" as const };
    if (!Number.isFinite(cfg.riskPerTrade) || cfg.riskPerTrade <= 0) return { kind: "incomplete" as const };
    if (!Number.isFinite(cfg.maxDailyLoss) || cfg.maxDailyLoss < 0) return { kind: "incomplete" as const };
    if (!marketClose || marketClose <= 0) return { kind: "no_price" as const };

    const futFreeRaw = account?.venues?.futures?.freeBalance;
    const futFree =
      futFreeRaw != null && Number.isFinite(Number(futFreeRaw)) && Number(futFreeRaw) >= 0
        ? Number(futFreeRaw)
        : null;
    if (futFree == null || futFree <= 0) return { kind: "no_fut_wallet" as const };

    const lev = futuresLeverageUsedForMarginCap(bot, cfg, futuresLevDraft, { manualTrade: false });
    const fixedUsdt = cfg.riskPerTradeUnit === "USDT" && cfg.maxDailyLossUnit === "USDT";
    const prob = fixedUsdt ? 0.75 : Number(bot?.lastAi?.gateProbability ?? bot?.lastAi?.probability ?? 0.5);
    const tm = riskTierMultPreview(prob, fixedUsdt);
    if (tm <= 0) return { kind: "tier_zero" as const };

    const maxAff = futFree * lev * 0.9;
    const fixedCap = cfg.riskPerTradeUnit === "USDT" && cfg.maxDailyLossUnit === "USDT";
    const effRisk = fixedCap ? previewFixedUsdtRiskUsdt(bot, activeSymbol, positions, account) : cfg.riskPerTrade;
    const targetNom = Math.min(effRisk * tm, maxAff);
    if (!(targetNom > 0)) return { kind: "incomplete" as const };

    const regime = String(bot?.lastRegime?.type || "RANGE");
    const p = buildAutotradeLongLiquidationPreview({
      entryPx: marketClose,
      leverage: lev,
      targetNotionalUsd: targetNom,
      atr: atr14,
      regimeType: regime,
      aiConfidence: fixedUsdt ? undefined : prob,
    });
    if (!p) return { kind: "incomplete" as const };
    return { kind: "preview" as const, preview: p };
  }, [
    cfg.marketMode,
    cfg.riskPerTrade,
    cfg.riskPerTradeUnit,
    cfg.maxDailyLoss,
    cfg.maxDailyLossUnit,
    cfg.futuresLeverage,
    cfg.futuresLeverageMode,
    marketClose,
    account,
    bot?.lastRegime?.type,
    bot?.lastAi?.probability,
    bot?.lastAi?.gateProbability,
    atr14,
    futuresLevDraft,
    bot,
    cfg,
    positions,
    activeSymbol,
  ]);

  const capitalAllotmentHeadline = useMemo(() => {
    const mm = String(cfg.marketMode || "AUTO").toUpperCase();
    const lev = futuresLeverageUsedForMarginCap(bot, cfg, futuresLevDraft, { manualTrade: false });
    const futFreeRaw = account?.venues?.futures?.freeBalance;
    const spotFreeRaw = account?.venues?.spot?.freeBalance;
    const futFree =
      futFreeRaw != null && Number.isFinite(Number(futFreeRaw)) && Number(futFreeRaw) >= 0 ? Number(futFreeRaw) : null;
    const spotFree =
      spotFreeRaw != null && Number.isFinite(Number(spotFreeRaw)) && Number(spotFreeRaw) >= 0 ? Number(spotFreeRaw) : null;
    const maxFut = futFree != null ? futFree * lev * 0.9 : null;
    const maxSpot = spotFree != null ? spotFree * 0.9 : null;
    const walletFreeMarginTotal = walletFreeMarginUsdt(account, mm);
    const splitDiv = capitalSplitDivisorFromBot(bot);
    const fixedUsd = cfg.riskPerTradeUnit === "USDT" && cfg.maxDailyLossUnit === "USDT";
    /** Show pool / usable / multi-coin panels whenever per-trade is USDT (not only when max daily is also USDT). */
    const showUsdtPoolLayout = cfg.riskPerTradeUnit === "USDT";
    let allowedPoolUsdt = 0;
    if (fixedUsd) {
      allowedPoolUsdt = effectiveAllowedPoolUsdt(bot, account);
    } else if (showUsdtPoolLayout) {
      const raw = Number(bot?.allowedBudgetUsdt);
      const poolNominal = Number.isFinite(raw) && raw > 0 ? raw : Number(cfg.riskPerTrade ?? 0);
      const cap = walletFreeMarginUsdt(account, mm);
      allowedPoolUsdt =
        !Number.isFinite(poolNominal) || poolNominal <= 0
          ? poolNominal
          : !Number.isFinite(cap) || cap <= 0
            ? poolNominal
            : Math.min(poolNominal, cap);
    }
    const invested = sumOpenMarginUsedUsdtForUi(positions, mm);
    /** Raw pool left from allowed cap (can be negative if invested > allowed). */
    const usablePoolRaw = allowedPoolUsdt - invested;
    /** Pool used for sizing “% of usable” (never negative). */
    const usableStrategy = Math.max(0, usablePoolRaw);
    const laneBudget =
      cfg.riskPerTradeUnit === "USDT"
        ? previewFixedUsdtRiskUsdt(bot, activeSymbol, positions, account)
        : cfg.riskPerTrade;
    const allowedMain =
      cfg.riskPerTradeUnit === "USDT"
        ? `${allowedPoolUsdt.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDT`
        : `${(cfg.riskPerTrade * 100).toFixed(2)}% at stop`;
    const allowedSub =
      fixedUsd && cfg.universeCoinSelectMode === "MULTIPLE" && cfg.multiBudgetSplitMode === "EQUAL" && splitDiv > 1
        ? `Equal split target ≈ ${(laneBudget ?? cfg.riskPerTrade).toFixed(2)} USDT per active symbol (${splitDiv} in list)`
        : fixedUsd && cfg.universeCoinSelectMode === "MULTIPLE" && cfg.multiBudgetSplitMode !== "FULL"
          ? `Mode: ${cfg.multiBudgetSplitMode.replace(/_/g, " ")} · per-symbol notional ≈ ${(laneBudget ?? 0).toFixed(2)} USDT (${activeSymbol})`
          : null;
    const effFut =
      cfg.riskPerTradeUnit === "USDT" && futFree != null
        ? effectiveFuturesOrderNotionalUsdt(laneBudget ?? cfg.riskPerTrade, futFree, lev)
        : null;
    const effSpot =
      cfg.riskPerTradeUnit === "USDT" && spotFree != null
        ? effectiveSpotOrderNotionalUsdt(laneBudget ?? cfg.riskPerTrade, spotFree)
        : null;
    const deployParts: string[] = [];
    if ((mm === "FUTURES" || mm === "AUTO") && effFut != null) {
      deployParts.push(`Futures order ≤ ~${effFut.toFixed(2)} USDT (after margin×lev ~90%)`);
    }
    if ((mm === "SPOT" || mm === "AUTO") && effSpot != null) {
      deployParts.push(`Spot order ≤ ~${effSpot.toFixed(2)} USDT`);
    }
    if (deployParts.length === 0) {
      deployParts.push(
        cfg.riskPerTradeUnit === "USDT" ? "Fund the venue wallet to see venue-capped deployable notional." : "—",
      );
    }
    const usableFormula = showUsdtPoolLayout
      ? `${allowedPoolUsdt.toFixed(2)} − ${invested.toFixed(2)}`
      : "";
    const usableSizingNote = showUsdtPoolLayout
      ? usablePoolRaw < 0
        ? "Open margin used exceeds allowed — raise allowed or reduce/close positions so usable ≥ 0."
        : usablePoolRaw === 0
          ? "No pool left at this cap until open margin used drops below allowed."
          : "With no open legs, margin used → 0 and usable equals allowed."
      : "";
    const deployLine = deployParts.join(" · ");
    const walletSliderPct =
      cfg.riskPerTradeUnit === "USDT" && walletFreeMarginTotal > 0
        ? clampNum((allowedPoolUsdt / walletFreeMarginTotal) * 100, 0, 100)
        : cfg.allowedBudgetWalletPct;
    return {
      allowedMain,
      allowedSub,
      deployLine,
      walletFreeMarginTotal,
      walletSliderPct,
      fixedUsd,
      showUsdtPoolLayout,
      allowedPoolUsdt,
      usableStrategy,
      usablePoolRaw,
      usableFormula,
      usableSizingNote,
      investedOpen: invested,
    };
  }, [cfg, bot, account, futuresLevDraft, positions, activeSymbol]);

  useEffect(() => {
    setCapitalSliderDraftPct(null);
  }, [cfg.riskPerTrade, cfg.allowedBudgetUsdt, capitalAllotmentHeadline.walletFreeMarginTotal]);

  useEffect(
    () => () => {
      if (capitalSliderTimerRef.current) window.clearTimeout(capitalSliderTimerRef.current);
    },
    [],
  );

  const manualFuturesLiqUi = useMemo(() => {
    const mm = String(cfg.marketMode || "AUTO").toUpperCase();
    if (mm === "SPOT" || !showManualOrders) return null;
    if (!marketClose || marketClose <= 0) return null;
    if (manualAmountUsd == null || manualAmountUsd <= 0) return null;
    const sl = parseManualPercentField(slPctStr);
    const tp = parseManualPercentField(tpPctStr);
    if (sl == null || tp == null) return null;
    const lev = futuresLeverageUsedForMarginCap(bot, cfg, futuresLevDraft, { manualTrade: true });
    const slFrac = sl / 100;
    const buy = manualMarketLiquidationPreview({
      entryPx: marketClose,
      notionalUsd: manualAmountUsd,
      leverage: lev,
      side: "BUY",
      stopLossPctFraction: slFrac,
    });
    const sell = manualMarketLiquidationPreview({
      entryPx: marketClose,
      notionalUsd: manualAmountUsd,
      leverage: lev,
      side: "SELL",
      stopLossPctFraction: slFrac,
    });
    return { buy, sell, lev };
  }, [
    cfg.marketMode,
    showManualOrders,
    marketClose,
    manualAmountUsd,
    slPctStr,
    tpPctStr,
    bot,
    cfg,
    futuresLevDraft,
  ]);

  const coinSelectMultiple = cfg.universeCoinSelectMode === "MULTIPLE";
  const pinsManual = cfg.universePinControl === "MANUAL";
  const pinnedMulti = useMemo(() => {
    const a = bot?.universePinnedSymbols;
    if (!Array.isArray(a)) return [] as string[];
    return [...new Set(a.map((x) => String(x || "").trim().toUpperCase()))];
  }, [bot?.universePinnedSymbols]);
  const pinnedSymbolNorm = useMemo(() => {
    if (coinSelectMultiple) return "";
    if (bot?.universePinnedSymbol) return String(bot.universePinnedSymbol).toUpperCase();
    const f = Array.isArray(bot?.universePinnedSymbols) ? bot!.universePinnedSymbols[0] : null;
    return f ? String(f).toUpperCase() : "";
  }, [coinSelectMultiple, bot?.universePinnedSymbol, bot?.universePinnedSymbols]);
  const pinnedList = useMemo(() => {
    if (coinSelectMultiple) return pinnedMulti;
    return pinnedSymbolNorm ? [pinnedSymbolNorm] : [];
  }, [coinSelectMultiple, pinnedMulti, pinnedSymbolNorm]);
  const pinnedSet = useMemo(() => new Set(pinnedList), [pinnedList]);
  const hasSavedPins = pinnedList.length > 0;
  const rankedCoins = (bot?.universe?.ranked || []).slice(0, 12);
  const emptyCustom = bot?.universe?.emptyCustom === true;
  const showRankedCoins =
    cfg.symbolMode === "AUTO" ||
    Boolean(pinnedSymbolNorm) ||
    (coinSelectMultiple && pinnedMulti.length > 0) ||
    cfg.universeCoinBase === "CUSTOM";

  const capitalMultiSyms = useMemo(() => multiBudgetSymbolsForUi(bot), [bot]);
  const multiBudgetPctSum = useMemo(
    () => capitalMultiSyms.reduce((a, s) => a + clampNum(Number(cfg.multiBudgetCoinPct[s] ?? 0), 0, 100), 0),
    [capitalMultiSyms, cfg.multiBudgetCoinPct],
  );

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
                value={cfg.universeCoinSelectMode}
                onChange={(e) => {
                  const v = e.target.value === "MULTIPLE" ? "MULTIPLE" : "SINGLE";
                  deferTask(() => {
                    void (async () => {
                      try {
                        await api.botConfig({ universeCoinSelectMode: v, symbolMode: "AUTO" });
                        pushLog({
                          level: "info",
                          msg: v === "MULTIPLE" ? "Coin select: multiple (ranked picks)" : "Coin select: single (ranked picks)",
                        });
                      } catch {
                        pushLog({ level: "error", msg: "Failed to set coin select" });
                      }
                    })();
                  });
                }}
              >
                <option value="SINGLE">Single</option>
                <option value="MULTIPLE">Multiple</option>
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
                  <span className="text-slate-600 dark:text-slate-400" title="Stop distance as % of price (e.g. 1 = 1%). Supertrend futures when AI filter is off.">
                    ST %
                  </span>
                  <NumericTextInput
                    value={Number((cfg.supertrendFuturesFixedSlPct * 100).toFixed(8))}
                    min={0.005}
                    max={20}
                    disabled={!cfg.supertrendFuturesAuto}
                    onCommit={async (v) => {
                      try {
                        await api.botConfig({ supertrendFuturesFixedSlPct: v / 100 });
                      } catch {
                        pushLog({ level: "error", msg: "Failed to set ST %" });
                      }
                    }}
                  />
                </div>
                <div className="grid grid-cols-[110px_1fr] items-center gap-2">
                  <span className="text-slate-600 dark:text-slate-400" title="Take-profit distance as % of price (e.g. 1.5 = 1.5%).">
                    TP %
                  </span>
                  <NumericTextInput
                    value={Number((cfg.supertrendFuturesFixedTpPct * 100).toFixed(8))}
                    min={0.005}
                    max={50}
                    disabled={!cfg.supertrendFuturesAuto}
                    onCommit={async (v) => {
                      try {
                        await api.botConfig({ supertrendFuturesFixedTpPct: v / 100 });
                      } catch {
                        pushLog({ level: "error", msg: "Failed to set TP %" });
                      }
                    }}
                  />
                </div>
                <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-500">
                  <span className="text-slate-600 dark:text-slate-400">ST</span> / <span className="text-slate-600 dark:text-slate-400">TP</span> apply to{" "}
                  <span className="text-slate-600 dark:text-slate-400">Autotrade with Supertrend</span> on futures when the AI confidence
                  filter is <span className="text-slate-600 dark:text-slate-400">off</span>. Values are{" "}
                  <span className="font-mono text-slate-600 dark:text-slate-500">percent of price</span> (e.g.{" "}
                  <span className="font-mono text-slate-600 dark:text-slate-500">1</span> = 1% stop distance).
                </p>
              </>
            )}

            {showRankedCoins && (
              <div className="mt-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40">
                <div className="flex flex-col gap-2 border-b border-slate-200 dark:border-slate-800 px-3 py-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">Top coins (ranked)</div>
                    {!pinsManual && hasSavedPins ? (
                      <div className="mt-0.5 text-[11px] text-slate-600 dark:text-slate-400">
                        Saved pins are inactive — switch <span className="font-semibold text-slate-700 dark:text-slate-300">Pick control</span> to{" "}
                        <span className="font-semibold text-slate-700 dark:text-slate-300">Manual</span> to use them.
                      </div>
                    ) : null}
                    {pinsManual && coinSelectMultiple && pinnedMulti.length > 0 ? (
                      <div className="mt-0.5 text-[11px] font-medium text-emerald-300/90">
                        Pinned {pinnedMulti.length}/10: {pinnedMulti.join(", ")} — auto-pick only among pinned when set.
                        <button
                          type="button"
                          className="ml-2 rounded border border-amber-800/60 bg-amber-950/40 px-1.5 py-px text-[10px] font-semibold text-amber-100 hover:bg-amber-900/50"
                          onClick={() => {
                            deferTask(() => {
                              void (async () => {
                                try {
                                  await api.botConfig({ universePinnedSymbols: [] });
                                  pushLog({ level: "info", msg: "Cleared all pinned symbols" });
                                } catch {
                                  pushLog({ level: "error", msg: "Failed to clear pins" });
                                }
                              })();
                            });
                          }}
                        >
                          Clear pins
                        </button>
                      </div>
                    ) : pinsManual && !coinSelectMultiple && pinnedSymbolNorm ? (
                      <div className="mt-0.5 text-[11px] font-medium text-emerald-300/90">
                        Pinned: {pinnedSymbolNorm} — other rows are locked until you unpin or restart the bot
                      </div>
                    ) : null}
                  </div>
                  <button
                    disabled={coinBusy}
                    className="shrink-0 rounded-md border border-slate-300 dark:border-slate-700 bg-slate-200/65 dark:bg-slate-100 dark:bg-slate-900/50 px-2 py-1 text-[11px] font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:bg-slate-900 disabled:opacity-50"
                    onClick={() => {
                      deferTask(() => {
                        void (async () => {
                          setCoinBusy(true);
                          try {
                            await api.universeScan(true);
                            pushLog({ level: "info", msg: "Universe scan refreshed" });
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

                <div className="flex flex-col gap-2 border-b border-slate-200 dark:border-slate-800 px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center">
                  <label className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-700 dark:text-slate-300">
                    <span className="shrink-0 text-slate-600 dark:text-slate-400">Coin base</span>
                    <select
                      className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-slate-900 dark:text-slate-100"
                      value={cfg.universeCoinBase}
                      onChange={(e) => {
                        const v = e.target.value === "CUSTOM" ? "CUSTOM" : "ALL";
                        deferTask(() => {
                          void (async () => {
                            try {
                              await api.botConfig({ universeCoinBase: v });
                              pushLog({ level: "info", msg: v === "CUSTOM" ? "Coin base: custom watchlist" : "Coin base: all Binance universe" });
                              await api.universeScan(true);
                            } catch {
                              pushLog({ level: "error", msg: "Failed to set coin base" });
                            }
                          })();
                        });
                      }}
                    >
                      <option value="ALL">ALL (AI-ranked top from Binance universe)</option>
                      <option value="CUSTOM">Custom (max 10)</option>
                    </select>
                  </label>
                  {cfg.universeCoinBase === "CUSTOM" ? (
                    <button
                      type="button"
                      className="rounded-md border border-slate-300 dark:border-slate-700 bg-slate-200/70 dark:bg-slate-900/50 px-2 py-1 text-[11px] font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-900"
                      onClick={() => setCustomUniverseOpen(true)}
                    >
                      Edit coin list…
                    </button>
                  ) : null}
                  <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-2 text-[11px] text-slate-700 dark:text-slate-300">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="shrink-0 text-slate-600 dark:text-slate-400">
                        Pin:{" "}
                        <span className="font-semibold text-slate-800 dark:text-slate-200">
                          {coinSelectMultiple ? "Multiple (≤10)" : "Single (1)"}
                        </span>
                      </span>
                      <span className="text-slate-500 dark:text-slate-500">·</span>
                      <span className="shrink-0 text-slate-600 dark:text-slate-400">Pick control</span>
                      <div className="inline-flex rounded-md border border-slate-300 dark:border-slate-700 bg-white/80 dark:bg-slate-950/50 p-0.5">
                        <button
                          type="button"
                          className={`rounded px-2 py-1 text-[11px] font-semibold ${
                            cfg.universePinControl === "AUTO"
                              ? "bg-emerald-600/85 text-slate-950 dark:text-slate-50"
                              : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-900"
                          }`}
                          onClick={() => {
                            deferTask(() => {
                              void (async () => {
                                try {
                                  await api.botConfig({ universePinControl: "AUTO" });
                                  pushLog({ level: "info", msg: "Pick control: Auto (pins read-only for bot)" });
                                } catch {
                                  pushLog({ level: "error", msg: "Failed to set pick control" });
                                }
                              })();
                            });
                          }}
                        >
                          Auto
                        </button>
                        <button
                          type="button"
                          className={`rounded px-2 py-1 text-[11px] font-semibold ${
                            cfg.universePinControl === "MANUAL"
                              ? "bg-emerald-600/85 text-slate-950 dark:text-slate-50"
                              : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-900"
                          }`}
                          onClick={() => {
                            deferTask(() => {
                              void (async () => {
                                try {
                                  await api.botConfig({ universePinControl: "MANUAL" });
                                  pushLog({ level: "info", msg: "Pick control: Manual (table pins apply)" });
                                } catch {
                                  pushLog({ level: "error", msg: "Failed to set pick control" });
                                }
                              })();
                            });
                          }}
                        >
                          Manual
                        </button>
                      </div>
                    </div>
                    {cfg.universePinControl === "AUTO" ? (
                      <span
                        className="shrink-0 text-[10px] font-medium text-slate-500 dark:text-slate-400"
                        title="Auto trades follow Supertrend / AI gates on the rotated symbol; table pins are inactive until Manual."
                      >
                        (Signal based)
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-3 py-2 dark:border-slate-800 sm:border-t-0 sm:px-0 sm:py-0">
                    <label className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-700 dark:text-slate-300">
                      <span className="shrink-0 text-slate-600 dark:text-slate-400">Auto coin pick</span>
                      <select
                        className="max-w-[min(100vw,280px)] rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-[11px] text-slate-900 dark:text-slate-100"
                        value={cfg.universeAutoCoinPick}
                        onChange={(e) => {
                          const v = e.target.value === "ST_SIGNAL_FIRST" ? "ST_SIGNAL_FIRST" : "RANKED_AI_SS";
                          deferTask(() => {
                            void (async () => {
                              try {
                                await api.botConfig({ universeAutoCoinPick: v });
                                pushLog({
                                  level: "info",
                                  msg:
                                    v === "ST_SIGNAL_FIRST"
                                      ? "Auto coin: Supertrend signal order (first signal in list)"
                                      : "Auto coin: ranked AI + opportunity composite",
                                });
                              } catch {
                                pushLog({ level: "error", msg: "Failed to set auto coin pick" });
                              }
                            })();
                          });
                        }}
                      >
                        <option value="RANKED_AI_SS">Ranked (AI + opportunity / SS gates at trade)</option>
                        <option value="ST_SIGNAL_FIRST">Supertrend signal first (walk list for bar-close signal)</option>
                      </select>
                    </label>
                  </div>
                </div>

                {emptyCustom ? (
                  <div className="px-3 py-4 text-[12px] text-amber-800 dark:text-amber-200/90">
                    Custom coin base is empty. Use &quot;Edit coin list&quot; to add up to 10 symbols, then scan.
                  </div>
                ) : (
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
                              No scan results yet (set MARKET_FEED=BINANCE or BINANCE_FUTURES and use Coin select above)
                            </td>
                          </tr>
                        ) : (
                          rankedCoins.map((c: any) => {
                            const symU = String(c.symbol || "").toUpperCase();
                            const isPinnedRow = pinnedSet.has(symU);
                            const rowLockedOut =
                              pinsManual && !coinSelectMultiple && Boolean(pinnedSymbolNorm) && !isPinnedRow;
                            const multiPinFull = coinSelectMultiple && !isPinnedRow && pinnedMulti.length >= 10;
                            const pinRowActive = isPinnedRow && pinsManual;
                            const pinRowSavedOnly = isPinnedRow && !pinsManual;
                            return (
                              <tr
                                key={c.symbol}
                                className={`border-t border-slate-200 dark:border-slate-900 transition-opacity ${
                                  pinRowActive
                                    ? "bg-emerald-950/35 ring-1 ring-inset ring-emerald-500/40"
                                    : pinRowSavedOnly
                                      ? "bg-slate-200/40 ring-1 ring-inset ring-slate-400/25 dark:bg-slate-900/40 dark:ring-slate-600/30 opacity-[0.72]"
                                      : rowLockedOut
                                        ? "pointer-events-none opacity-[0.38]"
                                        : ""
                                }`}
                              >
                                <td
                                  className={`px-3 py-2 font-semibold ${
                                    pinRowActive
                                      ? "text-emerald-100"
                                      : pinRowSavedOnly
                                        ? "text-slate-600 dark:text-slate-400"
                                        : "text-slate-800 dark:text-slate-200"
                                  }`}
                                >
                                  {c.symbol}
                                  {pinRowActive ? (
                                    <span className="ml-1.5 rounded bg-emerald-600/80 px-1 py-px text-[9px] font-bold uppercase text-white">
                                      pinned
                                    </span>
                                  ) : pinRowSavedOnly ? (
                                    <span className="ml-1.5 rounded bg-slate-500/50 px-1 py-px text-[9px] font-bold uppercase text-slate-200 dark:text-slate-400">
                                      saved
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
                                <td
                                  className={`px-3 py-2 ${pinsManual ? "" : "pointer-events-none select-none opacity-40"}`}
                                  title={pinsManual ? undefined : "Switch Pick control to Manual to pin or unpin"}
                                >
                                  {coinSelectMultiple ? (
                                    isPinnedRow ? (
                                      <button
                                        type="button"
                                        disabled={!pinsManual}
                                        className="rounded-md border border-amber-700/80 bg-amber-950/50 px-2 py-1 text-[11px] font-semibold text-amber-100 hover:bg-amber-900/60 disabled:cursor-not-allowed disabled:opacity-50"
                                        onClick={() => {
                                          deferTask(() => {
                                            void (async () => {
                                              try {
                                                const next = pinnedMulti.filter((x) => x !== symU);
                                                await api.botConfig({ universePinnedSymbols: next });
                                                pushLog({ level: "info", msg: "Unpinned symbol", symbol: symU });
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
                                        disabled={!pinsManual || multiPinFull}
                                        className="rounded-md border border-slate-300 dark:border-slate-700 bg-slate-200/50 dark:bg-slate-100 dark:bg-slate-900/30 px-2 py-1 text-[11px] font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
                                        onClick={() => {
                                          const sym = symU;
                                          deferTask(() => {
                                            void (async () => {
                                              try {
                                                const next = [...pinnedMulti, sym].slice(0, 10);
                                                await api.botConfig({ universePinnedSymbols: next });
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
                                    )
                                  ) : isPinnedRow ? (
                                    <button
                                      type="button"
                                      disabled={!pinsManual}
                                      className="rounded-md border border-amber-700/80 bg-amber-950/50 px-2 py-1 text-[11px] font-semibold text-amber-100 hover:bg-amber-900/60 disabled:cursor-not-allowed disabled:opacity-50"
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
                                      disabled={!pinsManual || rowLockedOut}
                                      className="rounded-md border border-slate-300 dark:border-slate-700 bg-slate-200/50 dark:bg-slate-100 dark:bg-slate-900/30 px-2 py-1 text-[11px] font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
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
                )}
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

            {(cfg.strategyMode === "AUTO" || cfg.manualStrategy === "SURF_PULSE_ML") && (
              <div className="rounded-md border border-slate-200/90 dark:border-slate-800/80 bg-white/85 dark:bg-slate-950/30 px-2 py-2">
                <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">SurfPulse ML gate</div>
                <p className="mt-0.5 text-[11px] leading-snug text-slate-600 dark:text-slate-500">
                  Minimum XGBoost win probability from <span className="text-slate-600 dark:text-slate-400">/predict/surfpulse</span> required to
                  act on a SurfPulse signal. In <span className="text-slate-600 dark:text-slate-400">AUTO</span> mode this applies whenever the
                  selector runs SurfPulse ML; in <span className="text-slate-600 dark:text-slate-400">MANUAL</span> when SurfPulse ML is selected.
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <span className="w-[7.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Min SurfPulse</span>
                  <ThresholdSliderWithLock
                    ariaLabel="Minimum SurfPulse ML win probability (percent)"
                    serverSliderUnits={Math.round(cfg.surfPulseMlThreshold * 100)}
                    formatDisplay={(u) => `${u}%`}
                    onDebouncedCommit={(u) => {
                      const p = clampNum(u / 100, 0, 1);
                      void api.botConfig({ surfPulseMlThreshold: Number(p.toFixed(3)) }).catch(() => {
                        pushLog({ level: "error", msg: "Failed to set SurfPulse threshold" });
                      });
                    }}
                  />
                </div>
              </div>
            )}

            {cfg.marketMode !== "SPOT" && (
              <div className="mb-3 rounded-xl border-2 border-sky-600/35 bg-gradient-to-br from-sky-50/95 via-white to-slate-50/90 p-3 shadow-md dark:border-sky-500/35 dark:from-sky-950/45 dark:via-slate-950 dark:to-slate-900/90">
                <div className="flex flex-wrap items-start justify-between gap-2 border-b border-sky-800/15 pb-2 dark:border-sky-300/10">
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold tracking-tight text-slate-900 dark:text-slate-50">Features</h3>
                    <p className="mt-0.5 max-w-[28rem] text-[10px] leading-snug text-slate-600 dark:text-slate-400">
                      <span className="font-semibold text-sky-900 dark:text-sky-200">Trailing stop</span> for futures autotrade: tick-by-tighten SL on
                      autotrade legs (local brackets / paper in app; live venues may replace orders). Choose how the next stop is computed below.
                    </p>
                  </div>
                </div>
                <div className="mt-3 space-y-2 rounded-lg border border-sky-800/25 bg-white/85 p-2 dark:border-sky-400/20 dark:bg-slate-950/50">
                  <div className="text-[11px] font-semibold text-sky-900 dark:text-sky-100">Trailing stop (futures autotrade)</div>
                  <label className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={cfg.trailingStopLossAuto}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        deferTask(() => {
                          void (async () => {
                            try {
                              await api.botConfig({ trailingStopLossAuto: on });
                              pushLog({
                                level: "info",
                                msg: on
                                  ? "Trailing stop: ON — futures autotrade SL updates each tick (mode you selected below)"
                                  : "Trailing stop: OFF",
                              });
                            } catch {
                              pushLog({ level: "error", msg: "Failed to update trailing stop" });
                            }
                          })();
                        });
                      }}
                    />
                    <span className="min-w-0 flex-1 text-xs leading-snug text-slate-700 dark:text-slate-300">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">Enable trailing</span>
                      <span className="mt-0.5 block text-[11px] text-slate-600 dark:text-slate-500">
                        When <span className="text-slate-600 dark:text-slate-400">on</span>, each tick can tighten stop-loss on autotrade legs (local brackets /
                        paper sim update in app; live exchange may need order replaces depending on venue). Pick how the next stop is computed:
                      </span>
                    </span>
                  </label>
                  <fieldset className="mt-2 space-y-1.5 border-0 pl-6">
                    <legend className="sr-only">Futures trailing stop calculation</legend>
                    <label className="flex cursor-pointer items-start gap-2 text-[11px] leading-snug text-slate-700 dark:text-slate-300">
                      <input
                        type="radio"
                        name="futures-trailing-mode"
                        className="mt-0.5"
                        checked={cfg.futuresTrailingStopMode === "SUPERTREND"}
                        onChange={() => {
                          deferTask(() => {
                            void (async () => {
                              try {
                                await api.botConfig({ futuresTrailingStopMode: "SUPERTREND" });
                                pushLog({ level: "info", msg: "Futures trailing: Supertrend line + fee activation (chart ST, breakeven floor)" });
                              } catch {
                                pushLog({ level: "error", msg: "Failed to set trailing mode" });
                              }
                            })();
                          });
                        }}
                      />
                      <span>
                        <span className="font-semibold text-slate-800 dark:text-slate-200">Supertrend-based</span> — After price passes a small fee buffer
                        past entry, the stop ratchets with the <span className="text-slate-600 dark:text-slate-400">Supertrend line</span> (from the bot chart),
                        never below a one-way fee breakeven vs entry; includes a rough liquidation-vs-breakeven guard. Reacts to structure, not fixed % steps.
                      </span>
                    </label>
                    <label className="flex cursor-pointer items-start gap-2 text-[11px] leading-snug text-slate-700 dark:text-slate-300">
                      <input
                        type="radio"
                        name="futures-trailing-mode"
                        className="mt-0.5"
                        checked={cfg.futuresTrailingStopMode === "FEE_LADDER"}
                        onChange={() => {
                          deferTask(() => {
                            void (async () => {
                              try {
                                await api.botConfig({ futuresTrailingStopMode: "FEE_LADDER" });
                                pushLog({
                                  level: "info",
                                  msg: "Futures trailing: Fee ladder — discrete locks from fee model + optional % of entry",
                                });
                              } catch {
                                pushLog({ level: "error", msg: "Failed to set trailing mode" });
                              }
                            })();
                          });
                        }}
                      />
                      <span>
                        <span className="font-semibold text-slate-800 dark:text-slate-200">Fee ladder</span> — Discrete locks only: first at{" "}
                        <span className="text-slate-600 dark:text-slate-400">~round-trip fee break-even</span> on entry, second at another{" "}
                        <span className="text-slate-600 dark:text-slate-400">fee-equivalent</span> notch, then up to three optional{" "}
                        <span className="text-slate-600 dark:text-slate-400">% of entry</span> locks you set below. Advance uses favorable excursion (high/low
                        watermark) vs entry — no Supertrend line.
                      </span>
                    </label>
                  </fieldset>
                  <div className="mt-2 space-y-1 pl-6">
                    <p className="text-[11px] text-slate-600 dark:text-slate-500">
                      Extra scalping (% of entry, optional — max 3; used by <span className="font-medium">Fee ladder</span>; ignored for Supertrend-based)
                    </p>
                    {([0, 1, 2] as const).map((idx) => (
                      <div key={idx} className="grid grid-cols-[110px_1fr] items-center gap-2">
                        <span className="text-[11px] text-slate-600 dark:text-slate-500">Extra {idx + 1}</span>
                        <OptionalTrailingPctInput
                          value={cfg.trailingStopExtraScalpingPcts[idx]}
                          min={0.01}
                          max={5}
                          onCommit={async (v) => {
                            const slots: [number | undefined, number | undefined, number | undefined] = [
                              cfg.trailingStopExtraScalpingPcts[0],
                              cfg.trailingStopExtraScalpingPcts[1],
                              cfg.trailingStopExtraScalpingPcts[2],
                            ];
                            slots[idx] = v;
                            const next = [slots[0], slots[1], slots[2]].filter(
                              (x): x is number => x != null && Number.isFinite(x) && x > 0,
                            );
                            try {
                              await api.botConfig({ trailingStopExtraScalpingPcts: next });
                            } catch {
                              pushLog({ level: "error", msg: "Failed to set trailing extra scalping" });
                            }
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {(cfg.supertrendSpotAuto || cfg.supertrendFuturesAuto) && (
              <div className="mb-3 rounded-xl border-2 border-violet-600/35 bg-gradient-to-br from-violet-50/95 via-white to-slate-50/90 p-3 shadow-md dark:border-violet-500/35 dark:from-violet-950/45 dark:via-slate-950 dark:to-slate-900/90">
                <div className="flex flex-wrap items-start justify-between gap-2 border-b border-violet-800/15 pb-2 dark:border-violet-300/10">
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold tracking-tight text-slate-900 dark:text-slate-50">Indicators</h3>
                    <p className="mt-0.5 max-w-[28rem] text-[10px] leading-snug text-slate-600 dark:text-slate-400">
                      Optional gates for <span className="font-semibold text-violet-900 dark:text-violet-200">Supertrend autotrade opens</span>:
                      minimum AI probability on USD-M futures, and minimum composite signal strength on spot and futures. Closes are unchanged.
                    </p>
                  </div>
                </div>

                {cfg.marketMode !== "SPOT" && cfg.supertrendFuturesAuto && (
                  <div className="mt-3 space-y-2 rounded-lg border border-violet-800/25 bg-white/85 p-2 dark:border-violet-400/20 dark:bg-slate-950/50">
                    <div className="text-[11px] font-semibold text-violet-900 dark:text-violet-100">Futures · AI confidence</div>
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
                          When <span className="text-violet-700 dark:text-violet-300">on</span>, bar-close opens must meet the minimum AI probability
                          below (unlock to change). Uses AI for risk tiers. When <span className="text-violet-700 dark:text-violet-300">off</span>, that
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
                        accentClassName="accent-violet-600"
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

                <div className="mt-3 space-y-2 rounded-lg border border-violet-800/25 bg-white/85 p-2 dark:border-violet-400/20 dark:bg-slate-950/50">
                  <div className="text-[11px] font-semibold text-violet-900 dark:text-violet-100">Signal strength</div>
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
                        When <span className="text-violet-700 dark:text-violet-300">off</span> (default), the composite engine still computes 0–100
                        strength for the UI — it does not block orders. When <span className="text-violet-700 dark:text-violet-300">on</span>, spot and
                        futures <span className="text-violet-700 dark:text-violet-300">opening</span> legs after a bar-close signal require composite
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
                      accentClassName="accent-violet-600"
                      onDebouncedCommit={(u) => {
                        void api.botConfig({ signalStrengthOpenMin: Math.round(clampNum(u, 0, 100)) }).catch(() => {
                          pushLog({ level: "error", msg: "Failed to set min signal strength" });
                        });
                      }}
                    />
                  </div>
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

            <div className="mb-3 rounded-xl border-2 border-emerald-700/35 bg-gradient-to-br from-emerald-50/95 via-white to-slate-50/90 p-3 shadow-md dark:border-emerald-600/30 dark:from-emerald-950/40 dark:via-slate-950 dark:to-slate-900/90">
              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-emerald-800/15 pb-2 dark:border-emerald-200/10">
                <div className="min-w-0">
                  <h3 className="text-sm font-bold tracking-tight text-slate-900 dark:text-slate-50">Capital allotment</h3>
                  <p className="mt-0.5 max-w-[22rem] text-[10px] leading-snug text-slate-600 dark:text-slate-400">
                    Allowed is capped at <span className="font-semibold text-slate-700 dark:text-slate-300">free margin</span> (collateral), not
                    leveraged notional. <span className="font-semibold text-slate-700 dark:text-slate-300">Usable</span> is allowed minus open
                    margin used (futures: notional ÷ leverage; spot: full quote at entry). Per-trade USDT is the fallback pool unless multi-coin “% of
                    usable” is on. Deploy line is venue-capped order size (~90% buying power).
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  {capitalAllotmentHeadline.showUsdtPoolLayout ? (
                    <div className="grid grid-cols-2 gap-x-5 gap-y-1">
                      <div>
                        <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Allowed</div>
                        <div className="text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                          {capitalAllotmentHeadline.allowedMain}
                        </div>
                      </div>
                      <div>
                        <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Usable</div>
                        <div
                          className={`text-lg font-bold tabular-nums ${
                            capitalAllotmentHeadline.usablePoolRaw < 0
                              ? "text-amber-600 dark:text-amber-400"
                              : capitalAllotmentHeadline.usablePoolRaw > 0
                                ? "text-sky-600 dark:text-sky-400"
                                : "text-slate-600 dark:text-slate-400"
                          }`}
                        >
                          {capitalAllotmentHeadline.usablePoolRaw.toLocaleString("en-US", {
                            maximumFractionDigits: 2,
                            minimumFractionDigits: 2,
                          })}{" "}
                          USDT
                        </div>
                        <div className="mt-0.5 text-[9px] font-mono text-slate-500 dark:text-slate-400">
                          {capitalAllotmentHeadline.usableFormula}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Per-trade risk</div>
                      <div className="text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                        {capitalAllotmentHeadline.allowedMain}
                      </div>
                    </div>
                  )}
                  {capitalAllotmentHeadline.allowedSub ? (
                    <div className="mt-1 max-w-[14rem] text-[9px] leading-tight text-emerald-800/90 dark:text-emerald-200/90">
                      {capitalAllotmentHeadline.allowedSub}
                    </div>
                  ) : null}
                  {capitalAllotmentHeadline.showUsdtPoolLayout && capitalAllotmentHeadline.usableSizingNote ? (
                    <div className="mt-1.5 max-w-[15rem] text-[10px] leading-snug text-slate-600 dark:text-slate-400">
                      {capitalAllotmentHeadline.usableSizingNote}
                    </div>
                  ) : null}
                  <div className="mt-2 text-[9px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Deploy (venue cap)</div>
                  <div className="max-w-[16rem] text-[10px] font-medium leading-snug text-slate-700 dark:text-slate-200">
                    {capitalAllotmentHeadline.deployLine}
                  </div>
                </div>
              </div>

              {capitalAllotmentHeadline.showUsdtPoolLayout ? (
                <div className="mt-3 space-y-2 rounded-lg border border-emerald-800/20 bg-white/80 p-2 dark:border-emerald-500/25 dark:bg-slate-950/50">
                  <div className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">Allowed budget (USDT pool)</div>
                  <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-500">
                    Cannot exceed free margin ({capitalAllotmentHeadline.walletFreeMarginTotal > 0 ? `~${capitalAllotmentHeadline.walletFreeMarginTotal.toFixed(0)} USDT loaded` : "connect wallet to cap"}).
                  </p>
                  <div className="flex shrink-0 rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-0.5 text-[10px] font-medium text-slate-700 dark:text-slate-300">
                    <button
                      type="button"
                      className={`rounded px-2 py-0.5 ${cfg.allowedBudgetInputMode === "USDT" ? "bg-slate-600 text-white" : "hover:text-slate-900 dark:hover:text-slate-100"}`}
                      onClick={() => {
                        void api.botConfig({ allowedBudgetInputMode: "USDT" }).catch(() => {
                          pushLog({ level: "error", msg: "Failed to set allowed budget input mode" });
                        });
                      }}
                    >
                      USDT value
                    </button>
                    <button
                      type="button"
                      className={`rounded px-2 py-0.5 ${cfg.allowedBudgetInputMode === "WALLET_PCT" ? "bg-slate-600 text-white" : "hover:text-slate-900 dark:hover:text-slate-100"}`}
                      onClick={() => {
                        void api.botConfig({ allowedBudgetInputMode: "WALLET_PCT" }).catch(() => {
                          pushLog({ level: "error", msg: "Failed to set allowed budget input mode" });
                        });
                      }}
                    >
                      % of free margin
                    </button>
                  </div>
                  {cfg.allowedBudgetInputMode === "USDT" ? (
                    <NumericTextInput
                      key="allowed-usdt"
                      value={cfg.allowedBudgetUsdt > 0 ? cfg.allowedBudgetUsdt : cfg.riskPerTrade}
                      min={1}
                      max={
                        capitalAllotmentHeadline.walletFreeMarginTotal > 0
                          ? Math.min(10_000_000, Math.max(1, Math.floor(capitalAllotmentHeadline.walletFreeMarginTotal)))
                          : 10_000_000
                      }
                      onCommit={async (v) => {
                        try {
                          await api.botConfig({ allowedBudgetUsdt: v, allowedBudgetInputMode: "USDT" });
                        } catch {
                          pushLog({ level: "error", msg: "Failed to set allowed budget" });
                        }
                      }}
                    />
                  ) : (
                    <div className="rounded-md border border-slate-200/90 bg-white/90 px-2 py-2 dark:border-slate-700 dark:bg-slate-950/60">
                      <label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                        <span className="shrink-0 text-[10px] font-medium text-slate-600 dark:text-slate-400">
                          % of free margin (~{capitalAllotmentHeadline.walletFreeMarginTotal.toFixed(0)} USDT
                          {String(cfg.marketMode || "AUTO").toUpperCase() === "AUTO" ? " spot+futures" : ""})
                        </span>
                        <input
                          type="range"
                          className="h-2 min-w-0 flex-1 cursor-pointer accent-emerald-600"
                          min={0.5}
                          max={100}
                          step={0.5}
                          value={
                            capitalSliderDraftPct ??
                            (capitalAllotmentHeadline.walletFreeMarginTotal > 0
                              ? capitalAllotmentHeadline.walletSliderPct
                              : cfg.allowedBudgetWalletPct)
                          }
                          onChange={(e) => {
                            const pct = Number(e.target.value);
                            const w = capitalAllotmentHeadline.walletFreeMarginTotal;
                            if (!Number.isFinite(pct) || w <= 0) return;
                            setCapitalSliderDraftPct(pct);
                            if (capitalSliderTimerRef.current) window.clearTimeout(capitalSliderTimerRef.current);
                            capitalSliderTimerRef.current = window.setTimeout(() => {
                              capitalSliderTimerRef.current = null;
                              const nextAllowed = Math.max(1, Math.round((w * pct) / 100));
                              void api
                                .botConfig({
                                  allowedBudgetInputMode: "WALLET_PCT",
                                  allowedBudgetWalletPct: pct,
                                  allowedBudgetUsdt: nextAllowed,
                                })
                                .catch(() => {
                                  pushLog({ level: "error", msg: "Failed to set allowed budget from %" });
                                });
                            }, 380);
                          }}
                        />
                        <span className="w-12 shrink-0 text-right text-[10px] tabular-nums text-slate-600 dark:text-slate-400">
                          {(capitalSliderDraftPct ?? capitalAllotmentHeadline.walletSliderPct).toFixed(1)}%
                        </span>
                      </label>
                    </div>
                  )}
                </div>
              ) : null}

              {cfg.universeCoinSelectMode === "MULTIPLE" && capitalAllotmentHeadline.showUsdtPoolLayout ? (
                <div className="mt-3 space-y-2 rounded-lg border border-emerald-800/20 bg-white/80 p-2 dark:border-emerald-500/25 dark:bg-slate-950/50">
                  <div className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">Multi-coin sizing</div>
                  <label className="flex cursor-pointer items-start gap-2 text-[11px] text-slate-700 dark:text-slate-200">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={cfg.multiTradeUsePctOfUsable}
                      onChange={(e) => {
                        void api.botConfig({ multiTradeUsePctOfUsable: e.target.checked }).catch(() => {
                          pushLog({ level: "error", msg: "Failed to toggle % of usable" });
                        });
                      }}
                    />
                    <span>
                      Use <span className="font-semibold">% of usable</span> capital for the sizing pool (usable = allowed − open margin used). When
                      off, the per-trade USDT field below is the pool.
                    </span>
                  </label>
                  {cfg.multiTradeUsePctOfUsable ? (
                    <div className="flex items-center gap-2 pl-6">
                      <span className="w-24 shrink-0 text-[10px] text-slate-600 dark:text-slate-400">% of usable</span>
                      <input
                        type="range"
                        className="h-2 min-w-0 flex-1 cursor-pointer accent-emerald-600"
                        min={1}
                        max={100}
                        step={1}
                        value={cfg.multiTradePctOfUsable}
                        onChange={(e) => {
                          const v = clampNum(Number(e.target.value), 1, 100);
                          void api.botConfig({ multiTradePctOfUsable: v }).catch(() => {
                            pushLog({ level: "error", msg: "Failed to set % of usable" });
                          });
                        }}
                      />
                      <span className="w-10 text-right text-[10px] tabular-nums text-slate-600 dark:text-slate-400">{cfg.multiTradePctOfUsable}%</span>
                    </div>
                  ) : null}
                  <div className="text-[10px] font-medium text-slate-600 dark:text-slate-400">Split budget across coins</div>
                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [
                        ["FULL", "Full pool per symbol"],
                        ["EQUAL", "Equal split (list)"],
                        ["CUSTOM_USDT", "Custom USDT / coin"],
                        ["CUSTOM_PCT_ALLOWED", "Custom % of allowed"],
                      ] as const
                    ).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        className={`rounded-lg border px-2 py-1 text-[10px] font-semibold ${
                          cfg.multiBudgetSplitMode === mode
                            ? "border-emerald-600 bg-emerald-600 text-white dark:border-emerald-500"
                            : "border-slate-300 bg-white text-slate-700 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"
                        }`}
                        onClick={() => {
                          void api.botConfig({ multiBudgetSplitMode: mode }).catch(() => {
                            pushLog({ level: "error", msg: "Failed to set split mode" });
                          });
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {capitalMultiSyms.length === 0 ? (
                    <p className="text-[10px] text-amber-800 dark:text-amber-200/90">
                      No symbols in the Top coins list yet — run a universe scan (or pin symbols that appear in the table) to configure per-coin
                      splits.
                    </p>
                  ) : (
                    <div className="max-h-[200px] overflow-auto rounded border border-slate-200/80 dark:border-slate-700">
                      <table className="w-full text-[10px]">
                        <thead className="sticky top-0 bg-slate-100 dark:bg-slate-900">
                          <tr className="text-left text-slate-600 dark:text-slate-400">
                            <th className="px-2 py-1.5">Symbol</th>
                            <th className="px-2 py-1.5">
                              {cfg.multiBudgetSplitMode === "CUSTOM_USDT"
                                ? "USDT / trade"
                                : cfg.multiBudgetSplitMode === "CUSTOM_PCT_ALLOWED"
                                  ? "% of allowed (Σ≤100)"
                                  : "—"}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {capitalMultiSyms.map((sym) => (
                            <tr key={sym} className="border-t border-slate-200 dark:border-slate-800">
                              <td className="px-2 py-1.5 font-semibold text-slate-800 dark:text-slate-100">{sym}</td>
                              <td className="px-2 py-1.5">
                                {cfg.multiBudgetSplitMode === "CUSTOM_USDT" ? (
                                  <NumericTextInput
                                    key={`cu-${sym}`}
                                    value={Math.max(1, Number(cfg.multiBudgetCoinUsdt[sym] ?? 100))}
                                    min={1}
                                    max={10_000_000}
                                    onCommit={async (v) => {
                                      try {
                                        await api.botConfig({
                                          multiBudgetCoinUsdt: { ...cfg.multiBudgetCoinUsdt, [sym]: v },
                                        });
                                      } catch {
                                        pushLog({ level: "error", msg: `Failed to set USDT for ${sym}` });
                                      }
                                    }}
                                  />
                                ) : cfg.multiBudgetSplitMode === "CUSTOM_PCT_ALLOWED" ? (
                                  <div className="flex items-center gap-1">
                                    <input
                                      type="range"
                                      className="h-1.5 min-w-0 flex-1 cursor-pointer accent-emerald-600"
                                      min={0}
                                      max={100}
                                      step={1}
                                      value={clampNum(Number(cfg.multiBudgetCoinPct[sym] ?? 0), 0, 100)}
                                      onChange={(e) => {
                                        const v = clampNum(Number(e.target.value), 0, 100);
                                        void api
                                          .botConfig({
                                            multiBudgetCoinPct: { ...cfg.multiBudgetCoinPct, [sym]: v },
                                          })
                                          .catch(() => {
                                            pushLog({ level: "error", msg: `Failed to set % for ${sym}` });
                                          });
                                      }}
                                    />
                                    <span className="w-8 shrink-0 text-right tabular-nums">
                                      {clampNum(Number(cfg.multiBudgetCoinPct[sym] ?? 0), 0, 100)}%
                                    </span>
                                  </div>
                                ) : (
                                  <span className="text-slate-500 dark:text-slate-500">—</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {cfg.multiBudgetSplitMode === "CUSTOM_PCT_ALLOWED" && multiBudgetPctSum > 100 + 0.01 ? (
                    <p className="text-[10px] font-medium text-amber-800 dark:text-amber-200">
                      Per-coin % of allowed sums to {multiBudgetPctSum.toFixed(1)}% — server scales down to ≤100% on save; reduce sliders for a
                      precise split.
                    </p>
                  ) : cfg.multiBudgetSplitMode === "CUSTOM_PCT_ALLOWED" ? (
                    <p className="text-[10px] text-slate-600 dark:text-slate-500">Σ per-coin % = {multiBudgetPctSum.toFixed(1)}% (max 100%).</p>
                  ) : null}
                </div>
              ) : null}

              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,7.5rem)_auto_1fr] sm:items-center sm:gap-x-2">
                <span className="text-[11px] font-medium text-slate-700 dark:text-slate-200">Per-trade budget</span>
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

              <p className="mt-2 text-[10px] leading-snug text-slate-600 dark:text-slate-500">
                {cfg.riskPerTradeUnit === "USDT" ? (
                  capitalAllotmentHeadline.fixedUsd ? (
                    <>
                      <span className="font-medium text-slate-700 dark:text-slate-300">Fixed USDT mode</span>: notional follows allowed / usable
                      rules above and multi split mode. <span className="font-medium">Per-trade USDT</span> is the fallback pool when “% of usable”
                      is off. SL/TP from ATR; venue still caps near ~90% buying power.
                    </>
                  ) : (
                    <>
                      <span className="font-medium text-slate-700 dark:text-slate-300">USDT target notional</span> per autotrade (scaled by
                      confidence tiers), capped by ~90% buying power. Stops still come from ATR. Set{" "}
                      <span className="font-medium">Max daily loss</span> to USDT as well for server-side fixed pool / multi-coin sizing to match
                      the controls above.
                    </>
                  )
                ) : (
                  <>
                    Fraction of <span className="text-slate-600 dark:text-slate-400">free balance</span> at the stop (0.1%–5%) before confidence
                    tiers.
                  </>
                )}
              </p>

              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,7.5rem)_auto_1fr] sm:items-center sm:gap-x-2">
                <span className="text-[11px] font-medium text-slate-700 dark:text-slate-200">Max daily loss</span>
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
              <p className="mt-1 text-[10px] leading-snug text-slate-600 dark:text-slate-500">
                {cfg.maxDailyLossUnit === "USDT" ? (
                  <>
                    <span className="font-medium text-slate-700 dark:text-slate-300">Daily loss limit</span> in USD (not per-trade size). With
                    per-trade budget also in USDT, the bot uses fixed notional and skips AI gates for entry size. Halts when a venue’s day PnL vs
                    UTC-day baseline hits this loss (hybrid: spot and futures checked separately).
                  </>
                ) : (
                  <>
                    Halt when today’s <span className="text-slate-600 dark:text-slate-400">return vs day start</span> falls below{" "}
                    <span className="text-slate-600 dark:text-slate-400">−(this fraction)</span> on any venue.
                  </>
                )}
              </p>

              {minNotionalUi.length > 0 ? (
                <div className="mt-3 space-y-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white/80 p-2 text-[10px] leading-snug dark:bg-slate-950/50">
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
                <div className="mt-3 text-[10px] text-slate-600 dark:text-slate-500">
                  Could not load Binance min-notional rules for {activeSymbol}.
                </div>
              ) : null}
            </div>
            {(() => {
              const u = futuresAutotradeLiqUi;
              if (u.kind === "spot_only") return null;
              if (u.kind === "pct_risk") {
                return (
                  <div className="mt-2 rounded-md border border-slate-300/80 dark:border-slate-700 bg-slate-200/40 dark:bg-slate-900/40 px-2 py-2 text-[10px] leading-snug text-slate-600 dark:text-slate-400">
                    <span className="font-semibold text-slate-700 dark:text-slate-300">Liquidation preview</span> — set{" "}
                    <span className="font-medium">per-trade budget</span> to USDT to estimate USD-M margin vs ATR stop (simplified isolated model).
                  </div>
                );
              }
              if (u.kind === "incomplete" || u.kind === "no_price") {
                return (
                  <div className="mt-2 text-[10px] leading-snug text-slate-500">
                    <span className="font-semibold text-slate-600 dark:text-slate-400">Liquidation preview</span> — set per-trade budget and max
                    daily loss, then wait for chart price for a futures estimate.
                  </div>
                );
              }
              if (u.kind === "no_fut_wallet") {
                return (
                  <div className="mt-2 rounded-md border border-amber-800/40 bg-amber-950/25 px-2 py-2 text-[10px] text-amber-100/90">
                    <span className="font-semibold">Liquidation preview</span> — futures wallet balance not loaded yet (or zero). Connect / fund
                    USD-M margin for an estimate.
                  </div>
                );
              }
              if (u.kind === "tier_zero") {
                return (
                  <div className="mt-2 text-[10px] text-slate-500">
                    <span className="font-semibold text-slate-600 dark:text-slate-400">Liquidation preview</span> — AI confidence tier would block
                    opens at the current score; no sizing preview.
                  </div>
                );
              }
              const p = u.preview;
              const fmtP = (x: number) => (Math.abs(x) >= 1 ? x.toFixed(4) : x.toPrecision(5));
              const mmPct = (DEFAULT_MAINTENANCE_MARGIN_RATE * 100).toFixed(2);
              return (
                <div
                  className={`mt-2 rounded-md border px-2 py-2 text-[10px] leading-snug ${
                    p.ok
                      ? "border-emerald-800/45 bg-emerald-950/25 text-emerald-100/95"
                      : "border-rose-800/55 bg-rose-950/35 text-rose-100/95"
                  }`}
                >
                  <div className={`font-semibold ${p.ok ? "text-emerald-200" : "text-rose-200"}`}>
                    Liquidation {p.ok ? "(safe)" : "(risk)"}
                  </div>
                  <div className="mt-1 font-mono text-[10px] opacity-95">
                    Next long (BUY) vs ATR stop @ ~{fmtP(p.entryPx)} · {p.leverage}x · est. notional ~{p.notionalUsd.toFixed(2)} USDT · est. margin ~
                    {p.marginUsd != null ? `${p.marginUsd.toFixed(2)} USDT` : "—"}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] opacity-95">
                    Est. liq {p.liqPx != null ? fmtP(p.liqPx) : "—"} · ATR SL {fmtP(p.stopLoss)} (isolated model, maint. ≈ {mmPct}%)
                  </div>
                  <div className="mt-1 text-[10px] opacity-90">
                    Rule: long — liquidation must sit <span className="font-medium">below</span> stop-loss so the stop triggers first.
                  </div>
                  {!p.ok && p.hints.length ? (
                    <ul className="mt-1 list-inside list-disc space-y-0.5 text-[10px] text-rose-100/90">
                      {p.hints.map((h, i) => (
                        <li key={i}>{h}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              );
            })()}
        </div>
      </div>

      {showManualOrders && (
        <div className="mt-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40 p-3">
          <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">Manual trade</div>
          <div className="mt-1 text-[10px] leading-snug text-slate-600 dark:text-slate-500">
            Stop-loss and take-profit are <span className="font-medium text-slate-600 dark:text-slate-400">percent of price</span> (e.g.{" "}
            <span className="font-mono text-slate-600 dark:text-slate-400">1</span> = 1%, <span className="font-mono text-slate-600 dark:text-slate-400">2.5</span> = 2.5%).
            Allowed range: ~0.1%–20% SL and ~0.1%–50% TP. A trailing % is optional (e.g. 0.2 or 0.2%).
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
              <span className="text-slate-600 dark:text-slate-400">Stop-loss %</span>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                className={numericInputClass}
                value={slPctStr}
                onChange={(e) => setSlPctStr(e.target.value)}
                title="Percent from entry (e.g. 1 = 1%)"
              />
            </label>
            <label className="grid grid-cols-[110px_1fr] items-center gap-2">
              <span className="text-slate-600 dark:text-slate-400">Take-profit %</span>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                className={numericInputClass}
                value={tpPctStr}
                onChange={(e) => setTpPctStr(e.target.value)}
                title="Percent from entry (e.g. 1.5 = 1.5%)"
              />
            </label>
            <div className="mt-2 flex gap-2">
              <button
                disabled={manualOrderBusy}
                className="flex-1 rounded-md bg-emerald-600/80 px-3 py-2 font-semibold hover:bg-emerald-600 disabled:opacity-50"
                onClick={() => {
                  if (manualOrderBusy) return;
                  const amountUsd = parseFloat(amountUsdStr.replace(/,/g, "."));
                  const slPctUi = parseManualPercentField(slPctStr);
                  const tpPctUi = parseManualPercentField(tpPctStr);
                  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
                    pushLog({ level: "warn", msg: "Enter a valid amount (USD)" });
                    return;
                  }
                  if (slPctUi == null || tpPctUi == null) {
                    pushLog({ level: "warn", msg: "Enter valid stop-loss and take-profit %" });
                    return;
                  }
                  const stopLossPct = slPctUi / 100;
                  const takeProfitPct = tpPctUi / 100;
                  if (stopLossPct < 0.001 || stopLossPct > 0.2) {
                    pushLog({ level: "warn", msg: "Stop-loss: use ~0.1%–20% of price (e.g. 0.1–20 in the % fields)" });
                    return;
                  }
                  if (takeProfitPct < 0.001 || takeProfitPct > 0.5) {
                    pushLog({ level: "warn", msg: "Take-profit: use ~0.1%–50% of price (e.g. 0.1–50 in the % fields)" });
                    return;
                  }
                  deferTask(() => {
                    void (async () => {
                      setManualOrderBusy(true);
                      try {
                        const out = await api.manualTrade({
                          side: "BUY",
                          amountUsd,
                          stopLossPct,
                          takeProfitPct,
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
                  const slPctUi = parseManualPercentField(slPctStr);
                  const tpPctUi = parseManualPercentField(tpPctStr);
                  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
                    pushLog({ level: "warn", msg: "Enter a valid amount (USD)" });
                    return;
                  }
                  if (slPctUi == null || tpPctUi == null) {
                    pushLog({ level: "warn", msg: "Enter valid stop-loss and take-profit %" });
                    return;
                  }
                  const stopLossPct = slPctUi / 100;
                  const takeProfitPct = tpPctUi / 100;
                  if (stopLossPct < 0.001 || stopLossPct > 0.2) {
                    pushLog({ level: "warn", msg: "Stop-loss: use ~0.1%–20% of price (e.g. 0.1–20 in the % fields)" });
                    return;
                  }
                  if (takeProfitPct < 0.001 || takeProfitPct > 0.5) {
                    pushLog({ level: "warn", msg: "Take-profit: use ~0.1%–50% of price (e.g. 0.1–50 in the % fields)" });
                    return;
                  }
                  deferTask(() => {
                    void (async () => {
                      setManualOrderBusy(true);
                      try {
                        const out = await api.manualTrade({
                          side: "SELL",
                          amountUsd,
                          stopLossPct,
                          takeProfitPct,
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
            {manualFuturesLiqUi && manualFuturesLiqUi.buy && manualFuturesLiqUi.sell ? (
              <div className="mt-2 rounded-md border border-slate-300/80 dark:border-slate-700 bg-slate-200/40 dark:bg-slate-950/50 px-2 py-2 text-[10px] leading-snug text-slate-700 dark:text-slate-200">
                <div className="font-semibold text-slate-800 dark:text-slate-100">Futures margin & liquidation (est.)</div>
                <div className="mt-1 text-slate-600 dark:text-slate-400">
                  At Amount, SL%, and ~{manualFuturesLiqUi.lev}x (same leverage as min-notional hints). Not financial advice — simplified Binance USD-M
                  isolated approximation (maint. ≈ {(DEFAULT_MAINTENANCE_MARGIN_RATE * 100).toFixed(2)}%).
                </div>
                {(["BUY", "SELL"] as const).map((side) => {
                  const row = side === "BUY" ? manualFuturesLiqUi.buy! : manualFuturesLiqUi.sell!;
                  const fmtP = (x: number) => (Math.abs(x) >= 1 ? x.toFixed(4) : x.toPrecision(5));
                  return (
                    <div
                      key={side}
                      className={`mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-t border-slate-300/50 pt-1 dark:border-slate-700/60`}
                    >
                      <span className="font-medium text-slate-800 dark:text-slate-100">{side}</span>
                      <span className={row.safe ? "text-emerald-600 dark:text-emerald-300" : "text-rose-600 dark:text-rose-300"}>
                        {row.safe ? "Liquidation safe" : "Liquidation risk"}
                      </span>
                      <span className="font-mono text-slate-600 dark:text-slate-400">
                        margin ~{row.marginUsd != null ? `${row.marginUsd.toFixed(2)} USDT` : "—"} · liq {row.liqPx != null ? fmtP(row.liqPx) : "—"} · SL{" "}
                        {fmtP(row.stopPx)}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      )}

      <UniverseCustomCoinsModal
        open={customUniverseOpen}
        initialSymbols={cfg.universeCustomSymbols}
        onClose={() => setCustomUniverseOpen(false)}
        onSave={async (symbols) => {
          await api.botConfig({ universeCustomSymbols: symbols });
          pushLog({ level: "info", msg: "Custom coin base saved", detail: { count: symbols.length } });
          await api.universeScan(true);
        }}
      />
    </div>
  );
}

