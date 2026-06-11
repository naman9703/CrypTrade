import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { deferTask } from "../lib/deferTask";
import { patchInstanceInByMode, useAppStore } from "../ws/store";
import { UniverseCustomCoinsModal } from "./UniverseCustomCoinsModal";
import { TrailPreviewModal, type TrailPreviewCfg } from "./TrailPreviewModal";
import { ChartErrorBoundary } from "./ChartErrorBoundary";
import { RangeSliderReleaseCommit } from "./RangeSliderReleaseCommit";
import {
  buildAutotradeLongLiquidationPreview,
  DEFAULT_MAINTENANCE_MARGIN_RATE,
  manualMarketLiquidationPreview,
  riskTierMultPreview,
} from "../lib/futuresLiquidation";
import { DEFAULT_TRAIL_FEE_BE_MULTIPLIER } from "../lib/trailingFeeLadder";
import { mergeMarketDecisionConfig } from "../lib/marketDecision/configDefaults";
import type { MarketDecisionEngineConfig } from "../lib/marketDecision/types";
import { MarketDecisionConfigPanel } from "./MarketDecisionConfigPanel";
import { tradingModeToApiModeSlug } from "../lib/tradingModeSlug";
import type { InstanceOperationalPatch } from "../types/instance";
import {
  TREND_HTF_ST_BNB_CHOP_SAFE,
  TREND_HTF_ST_BNB_HIGH_WR,
  TREND_HTF_ST_BNB_MAX_RETURN,
  TREND_HTF_ST_OPTIMAL_BNB,
  TREND_HTF_ST_OPTIMAL_BTC,
  TREND_HTF_ST_BNB_SURGICAL,
} from "../lib/trendHtfStPresets";
import { SUPERTREND_INTEL_80WR, SUPERTREND_INTEL_TRAIL } from "../lib/supertrendIntelPresets";
import {
  SUPERTREND_ELITE_AUTO_1H,
  SUPERTREND_ELITE_ADX_1H,
  SUPERTREND_ELITE_ATR_1H,
  SUPERTREND_ELITE_BNB_1H,
  SUPERTREND_ELITE_BTC_1H,
  SUPERTREND_ELITE_BTC_1H_ADX,
  SUPERTREND_ELITE_LINK_1H,
  SUPERTREND_ELITE_CALIBRATED_1H,
  SUPERTREND_ELITE_PERCENTILE_1H,
  UNIFIED_ELITE_ADX_1H,
  UNIFIED_ELITE_BNB_1H,
  UNIFIED_ELITE_BTC_1H,
} from "../lib/supertrendElitePresets";
import { SAFE_INTRADAY_BNB_15M } from "../lib/safeIntradayPresets";
import { CRT_TBS_BNB_15M } from "../lib/crtTbsPresets";
import { TOKYO_SESSION_BNB_15M } from "../lib/tokyoSessionPresets";
import {
  INTRADAY_PRO_5M,
  INTRADAY_PRO_15M,
  INTRADAY_PRO_FIB_15M,
  INTRADAY_PRO_BIGMOVE_15M,
  INTRADAY_PRO_SR_APLUS_15M,
  INTRADAY_PRO_LIQ_DAILY_15M,
  BNB_SITUATION_ROUTER_15M,
  INTRADAY_PRO_ICT_15M,
  INTRADAY_PRO_ICT_FULL_15M,
  INTRADAY_PRO_ICT_RESEARCH_15M,
  INTRADAY_PRO_ICT_RESEARCH_1H,
  SR_INTRADAY_BTC_15M,
} from "../lib/srIntradayPresets";
import {
  VOLUME_PROFILE_15M,
  VOLUME_PROFILE_TIER_A_15M,
  VOLUME_PROFILE_BALANCED_15M,
  VOLUME_PROFILE_BTC_15M,
  VOLUME_PROFILE_5M,
} from "../lib/volumeProfilePresets";
import { IntradayGatesPanel } from "./IntradayGatesPanel";
import { isIntradayGateChecked, normalizeIntradayGatesOnBot } from "../lib/intradayGatesUi";
import {
  clearStagedStrategyBotPatch,
  flushStagedStrategyBotPatch,
  stageStrategyBotPatch,
} from "../lib/stagedStrategyBotPatch";
import { useGuardedCheckbox } from "./useGuardedCheckbox";

function TrendHtfStPresetButton({
  label,
  patch,
  pushLog,
  highlight,
}: {
  label: string;
  patch: Record<string, unknown>;
  pushLog: (msg: { level: string; msg: string }) => void;
  highlight?: boolean;
}) {
  return (
    <button
      type="button"
      className={
        highlight
          ? "rounded border-2 border-sky-500 bg-sky-100 dark:bg-sky-900/50 px-2 py-0.5 text-[10px] font-bold hover:bg-sky-200 dark:hover:bg-sky-800/60"
          : "rounded border border-sky-400 dark:border-sky-600 bg-white/80 dark:bg-sky-950/50 px-2 py-0.5 text-[10px] font-semibold hover:bg-sky-100 dark:hover:bg-sky-900/50"
      }
      onClick={() => {
        void api
          .botConfig(patch)
          .then(() => pushLog({ level: "info", msg: `Applied: ${label}` }))
          .catch((e: unknown) => {
            const detail =
              e && typeof e === "object" && "message" in e
                ? String((e as { message?: string }).message)
                : String(e ?? "unknown");
            pushLog({ level: "error", msg: `Failed: ${label} — ${detail}` });
          });
      }}
    >
      {label}
    </button>
  );
}

/** Binance kline intervals allowed by `POST /api/bot/config` (must match backend `allowedTimeframes`). */
const BOT_TRADING_TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"] as const;

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
  className,
  title,
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
  className?: string;
  title?: string;
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
      title={title}
      className={className ?? numericInputClass}
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

type TrailMetricKey =
  | "trailOpenFeeRate"
  | "trailCloseFeeRate"
  | "trailFeeBeMultiplier"
  | "trailBufferRate"
  | "trailActivationSlippageFrac"
  | "trailT01LockSlippageFrac"
  | "trailBufferAtrMult"
  | "trailMinSlDistFrac"
  | "trailMinGapFromMarkFrac"
  | "trailMaintMarginRate"
  | "trailPostT02SpacingFrac"
  | "trailPostT02MaxExtraTiers"
  | "trailPostT02ActivationBufferRate";

interface TrailMetricItem {
  key: TrailMetricKey;
  label: string;
  tip: string;
  min: number;
  max: number;
  step: number;
  decimals: number;
  pct: boolean;
}

/** Renders a labelled group of trail metric inputs with formula tooltips. */
function TrailMetricGroup({
  title,
  items,
  cfg,
  onChange,
  disabled,
}: {
  title: string;
  items: TrailMetricItem[];
  cfg: Record<string, number | unknown>;
  onChange: (key: TrailMetricKey, storedValue: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="ml-4 space-y-1 rounded border border-sky-200/50 bg-white/60 px-2 py-1.5 dark:border-sky-800/30 dark:bg-slate-950/50">
      <div className="text-[9px] font-semibold uppercase tracking-wide text-sky-800/70 dark:text-sky-300/50">{title}</div>
      {items.map(({ key, label, tip, min, max, decimals, pct }) => {
        const raw0 = Number(cfg[key]);
        const raw = Number.isFinite(raw0) ? raw0 : 0;
        const displayVal = pct ? +(raw * 100).toFixed(decimals) : +raw.toFixed(decimals);
        return (
          <div key={key} className="grid grid-cols-[1fr_76px] items-center gap-2">
            <label
              className="min-w-0 text-[10px] leading-snug text-slate-700 dark:text-slate-300"
              title={tip}
            >
              {label}
            </label>
            <NumericTextInput
              value={displayVal}
              disabled={disabled}
              min={min}
              max={max}
              title={tip}
              inputMode="decimal"
              className="w-full rounded border border-sky-200 bg-white px-1.5 py-0.5 text-right text-[10px] tabular-nums dark:border-sky-700 dark:bg-slate-900"
              onCommit={(v) => {
                onChange(key, pct ? v / 100 : v);
              }}
            />
          </div>
        );
      })}
    </div>
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

/**
 * Futures: `marginUsdt` is **initial margin** (USDT-M), same as backend `riskPlan` / `resolveFixedUsdtRiskForOrder`.
 * Quote notional ≈ margin × leverage; cap vs ~90% of wallet buying power (free margin × leverage).
 */
function effectiveFuturesOrderNotionalUsdt(marginUsdt: number, freeBalance: number | null, leverage: number): number | null {
  if (!Number.isFinite(marginUsdt) || marginUsdt <= 0) return null;
  if (freeBalance == null || !Number.isFinite(freeBalance) || freeBalance <= 0) return null;
  const lev = Math.max(1, Math.min(100, Number(leverage) || 1));
  const notionalFromMargin = marginUsdt * lev;
  const walletNotionalCap = freeBalance * lev * 0.9;
  return Math.min(notionalFromMargin, walletNotionalCap);
}

function effectiveSpotOrderNotionalUsdt(riskUsdt: number, freeBalance: number | null): number | null {
  if (!Number.isFinite(riskUsdt) || riskUsdt <= 0) return null;
  if (freeBalance == null || !Number.isFinite(freeBalance) || freeBalance <= 0) return null;
  return Math.min(riskUsdt, freeBalance * 0.9);
}

/** True when backend `capitalCycleModeActive()` — frozen cycle list applies (matches server). */
function capitalCycleModeActiveFromBot(bot: any): boolean {
  if (String(bot?.universeCoinSelectMode || "").toUpperCase() !== "MULTIPLE") return false;
  const m = String(bot?.multiBudgetSplitMode || "").toUpperCase();
  const splitModeNow =
    m === "FULL" || m === "EQUAL" || m === "CUSTOM_USDT" || m === "CUSTOM_PCT_ALLOWED"
      ? m
      : bot?.capitalSplitAcrossCoins === true
        ? "EQUAL"
        : "FULL";
  const multiSizingImplied =
    splitModeNow === "EQUAL" || splitModeNow === "CUSTOM_USDT" || splitModeNow === "CUSTOM_PCT_ALLOWED";
  const multiSizing = bot?.multiCoinCapitalSizingActive === true || multiSizingImplied;
  return multiSizing && multiSizingImplied;
}

/** Ranked top-table symbols used for multi budget UI / EQUAL divisor (matches backend list used for sizing). */
function multiBudgetSymbolsForUi(bot: any): string[] {
  if (String(bot?.universeCoinSelectMode || "").toUpperCase() !== "MULTIPLE") return [];
  const cycleSyms = Array.isArray(bot?.capitalCycleSymbols)
    ? [...new Set((bot.capitalCycleSymbols as unknown[]).map((s) => String(s || "").trim().toUpperCase()).filter(Boolean))]
    : [];
  if (capitalCycleModeActiveFromBot(bot) && cycleSyms.length > 0) return cycleSyms.slice(0, 10);
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

function usableBufferPctFromBot(bot: any): number {
  const n = Number(bot?.usableCapitalBufferPct);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 90;
}

function multiCoinSizingActiveFromBot(bot: any): boolean {
  if (bot?.multiCoinCapitalSizingActive === false) return false;
  if (bot?.multiCoinCapitalSizingActive === true) return true;
  const m = String(bot?.multiBudgetSplitMode || "").toUpperCase();
  return (
    bot?.capitalSplitAcrossCoins === true || m === "EQUAL" || m === "CUSTOM_USDT" || m === "CUSTOM_PCT_ALLOWED"
  );
}

/** Net PnL (quote USDT) on a CLOSE row when the payload carries it (same fields as portfolio). */
function closeNetPnlUsdFromTrade(t: any): number | null {
  if (String(t?.type || "").toUpperCase() !== "CLOSE") return null;
  const m = t?.meta && typeof t.meta === "object" ? t.meta : {};
  const net = Number(t?.pnl ?? m.pnl ?? m.realizedPnl ?? m.realized_pnl);
  return Number.isFinite(net) ? net : null;
}

/** Row time for filtering compound P&L vs `allowedBudgetPnlAnchorMs` (close / ledger time). */
function capitalCloseTradeTsMs(t: any): number {
  const ts = t?.ts ?? t?.closedAt ?? t?.openedAt;
  if (ts == null) return 0;
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  const ms = Date.parse(String(ts));
  return Number.isFinite(ms) ? ms : 0;
}

function positionOpenedAtMsForCapital(p: any): number | null {
  const raw = p?.openedAt ?? p?.meta?.openedAt;
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Signed sum of net P&L on CLOSE rows at/after anchor (net ≈ profit − fees when backend stores it that way).
 * `anchorMs` null = include all closes (legacy sessions with no anchor yet).
 */
function cumulativeSignedClosePnlUsd(trades: readonly any[] | undefined, anchorMs: number | null): number {
  if (!Array.isArray(trades)) return 0;
  let sum = 0;
  for (const t of trades) {
    const net = closeNetPnlUsdFromTrade(t);
    if (net == null || !Number.isFinite(net)) continue;
    if (anchorMs != null && Number.isFinite(anchorMs) && capitalCloseTradeTsMs(t) < anchorMs) continue;
    sum += net;
  }
  return sum;
}

/**
 * Sum venue unrealized P&L (USDT) for positions in market mode; when `anchorMs` is set, only positions opened at/after anchor
 * (so unrealized from legs opened before the last allowed-cap edit does not move the headline).
 */
function sumUnrealizedPnlUsdtForUi(positions: any[] | undefined, marketMode: string, anchorMs: number | null): number {
  const mm = String(marketMode || "AUTO").toUpperCase();
  const rows = Array.isArray(positions) ? positions : [];
  let sum = 0;
  for (const p of rows) {
    const ven = String(p?.venue || "").toUpperCase();
    if (mm === "SPOT" && ven !== "SPOT") continue;
    if (mm === "FUTURES" && ven !== "FUTURES") continue;
    if (mm === "AUTO" && ven && ven !== "SPOT" && ven !== "FUTURES") continue;
    if (anchorMs != null && Number.isFinite(anchorMs)) {
      const opened = positionOpenedAtMsForCapital(p);
      if (opened == null || opened < anchorMs) continue;
    }
    const u = Number(p?.unrealizedPnl ?? p?.unRealizedProfit ?? NaN);
    if (Number.isFinite(u)) sum += u;
  }
  return sum;
}

/** Sums winning vs losing realized net on close rows (session trade list for this mode). */
function aggregateRealizedPnlBySign(trades: readonly any[] | undefined): {
  profitUsdt: number;
  lossUsdt: number;
  closesWithPnl: number;
} {
  let profitUsdt = 0;
  let lossUsdt = 0;
  let closesWithPnl = 0;
  if (!Array.isArray(trades)) return { profitUsdt, lossUsdt, closesWithPnl };
  for (const t of trades) {
    const net = closeNetPnlUsdFromTrade(t);
    if (net == null) continue;
    closesWithPnl += 1;
    if (net > 0) profitUsdt += net;
    else if (net < 0) lossUsdt += -net;
  }
  return { profitUsdt, lossUsdt, closesWithPnl };
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

/** Open initial margin (USDT) for one symbol, same venue rules as `sumOpenMarginUsedUsdtForUi`. */
function sumMarginUsedForSymbolUsdt(positions: any[] | undefined, marketMode: string, symbol: string): number {
  const mm = String(marketMode || "AUTO").toUpperCase();
  const sym = String(symbol || "").trim().toUpperCase();
  const rows = Array.isArray(positions) ? positions : [];
  let sum = 0;
  for (const p of rows) {
    const ps = String(p?.symbol || "").trim().toUpperCase();
    if (ps !== sym) continue;
    const ven = String(p?.venue || "").toUpperCase();
    if (mm === "SPOT" && ven !== "SPOT") continue;
    if (mm === "FUTURES" && ven !== "FUTURES") continue;
    if (mm === "AUTO" && ven && ven !== "SPOT" && ven !== "FUTURES") continue;
    sum += positionMarginUsedUsdtForUi(p);
  }
  return sum;
}

function futuresPositionNotionalUsdtForUi(p: any): number {
  const qty = Math.abs(Number(p?.qty ?? p?.positionAmt ?? 0));
  if (!(qty > 0)) return 0;
  const px = Number(p?.markPrice ?? p?.mark ?? p?.entryPrice ?? 0);
  return Number.isFinite(px) && px > 0 ? qty * px : 0;
}

function sumOpenFuturesNotionalUsdtForUi(positions: any[] | undefined): number {
  const rows = Array.isArray(positions) ? positions : [];
  let sum = 0;
  for (const p of rows) {
    if (String(p?.venue || "").toUpperCase() !== "FUTURES") continue;
    sum += futuresPositionNotionalUsdtForUi(p);
  }
  return sum;
}

function sumFuturesNotionalForSymbolUsdtForUi(positions: any[] | undefined, symbol: string): number {
  const sym = String(symbol || "").trim().toUpperCase();
  const rows = Array.isArray(positions) ? positions : [];
  let sum = 0;
  for (const p of rows) {
    if (String(p?.symbol || "").trim().toUpperCase() !== sym) continue;
    if (String(p?.venue || "").toUpperCase() !== "FUTURES") continue;
    sum += futuresPositionNotionalUsdtForUi(p);
  }
  return sum;
}

/** Matches backend `useFuturesNotionalAllotment` for USD-M sizing pool (notional, not margin). */
function useFuturesNotionalAllotmentForUi(bot: any, orderSymbol: string, positions: any[] | undefined): boolean {
  const mm = String(bot?.marketMode || "AUTO").toUpperCase();
  if (mm === "SPOT") return false;
  if (mm === "FUTURES") return true;
  const sym = String(orderSymbol || "").trim().toUpperCase();
  const rows = Array.isArray(positions) ? positions : [];
  for (const p of rows) {
    if (String(p?.symbol || "").toUpperCase() !== sym) continue;
    return String(p?.venue || "").toUpperCase() === "FUTURES";
  }
  return sym === String(bot?.symbol || "").toUpperCase();
}

type LevCfg = {
  futuresLeverage: number;
  futuresLeverageMode: string;
  riskPerTradeUnit?: string;
  maxDailyLossUnit?: string;
};

/** Free margin for capping — matches backend `walletFreeMarginUsdtForAllowedCap` (null when no balance). */
function walletFreeMarginUsdtForAllowedCapUi(account: any, marketMode: string): number | null {
  if (account == null) return null;
  const mm = String(marketMode || "AUTO").toUpperCase();
  const v = account?.venues;
  if (v && (v.spot != null || v.futures != null)) {
    const spotF =
      v.spot && v.spot.freeBalance != null && Number.isFinite(Number(v.spot.freeBalance))
        ? Math.max(0, Number(v.spot.freeBalance))
        : 0;
    const futF =
      v.futures && v.futures.freeBalance != null && Number.isFinite(Number(v.futures.freeBalance))
        ? Math.max(0, Number(v.futures.freeBalance))
        : 0;
    if (mm === "SPOT") return spotF > 0 ? spotF : null;
    if (mm === "FUTURES") return futF > 0 ? futF : null;
    const sum = spotF + futF;
    return sum > 0 ? sum : null;
  }
  const fb = Number(account.freeBalance);
  return Number.isFinite(fb) && fb > 0 ? fb : null;
}

/** Same rule as backend `futuresLeverageForSizingResolve` (not `decideFuturesLeverage` on orders). */
function futuresLeverageForSizingResolveUi(bot: any, cfg: LevCfg, futuresLevDraft: number | null): number {
  const mode = String(cfg.futuresLeverageMode || "AUTO").toUpperCase();
  if (mode === "MANUAL") {
    if (futuresLevDraft != null && Number.isFinite(futuresLevDraft)) {
      return clampNum(Math.floor(futuresLevDraft), 1, 100);
    }
    return clampNum(Math.floor(Number(cfg.futuresLeverage) || 1), 1, 100);
  }
  const p = clampNum(Number(bot?.lastAi?.gateProbability ?? bot?.lastAi?.probability ?? 0.5), 0, 1);
  const a = Math.max(0, Number(bot?.lastRegime?.atrPct ?? 0));
  const reg = String(bot?.lastRegime?.type ?? "").toUpperCase();
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

/** `allowed` after wallet cap — matches backend `resolveFixedUsdtRiskForOrder` (pool in margin USDT). */
function computeResolveAllowedFixedUsdt(
  bot: any,
  account: any,
  symbol: string,
  positions: any[] | undefined,
  levSizing: number,
): number {
  const walletCap = walletFreeMarginUsdtForAllowedCapUi(account, bot?.marketMode);
  const allowedRaw = Number(bot?.allowedBudgetUsdt);
  let allowed = Number.isFinite(allowedRaw) && allowedRaw > 0 ? allowedRaw : 0;
  if (walletCap != null && Number.isFinite(walletCap) && walletCap > 0) {
    allowed = Math.min(allowed, walletCap);
  }
  return allowed;
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

/**
 * Strategy allowed **margin** pool (USDT), clamped to free margin — mirrors backend `effectivePolicyAllowedPoolUsdt`
 * (allowed budget first, then USDT risk fallback, then % of wallet, then min(wallet)).
 */
function effectiveAllowedPoolUsdt(bot: any, account: any): number {
  const mm = String(bot?.marketMode || "AUTO").toUpperCase();
  const raw = Number(bot?.allowedBudgetUsdt);
  let poolNominal = Number.isFinite(raw) && raw > 0 ? raw : 0;
  if (!(poolNominal > 0) && String(bot?.riskPerTradeUnit || "").toUpperCase() === "USDT") {
    poolNominal = Math.max(0, Number(bot?.riskPerTrade ?? 0));
  }
  if (!(poolNominal > 0)) {
    const walletCap = walletFreeMarginUsdt(account, mm);
    const wpct = clampNum(Number(bot?.allowedBudgetWalletPct || 0), 0.5, 100);
    if (walletCap > 0 && wpct > 0) poolNominal = Math.max(1, Math.round((walletCap * wpct) / 100));
  }
  if (!Number.isFinite(poolNominal) || poolNominal <= 0) return 0;
  const cap = walletFreeMarginUsdt(account, mm);
  if (!Number.isFinite(cap) || cap <= 0) return poolNominal;
  return Math.min(poolNominal, cap);
}

/**
 * Per-symbol **initial margin** USDT for `riskPlan` (futures USD-M), matching backend `resolveFixedUsdtRiskForOrder`.
 * Quote notional ≈ margin × leverage. `levSizing` must match `futuresLeverageForSizingResolve` on the server.
 */
function previewFixedUsdtRiskUsdt(
  bot: any,
  symbol: string,
  positions: any[] | undefined,
  account: any,
  levSizing: number,
): number {
  if (String(bot?.riskPerTradeUnit || "").toUpperCase() !== "USDT") return Number(bot?.riskPerTrade ?? 0);
  const bufferPct = usableBufferPctFromBot(bot);
  const isMultiple = String(bot?.universeCoinSelectMode || "").toUpperCase() === "MULTIPLE";
  const mode = derivedMultiBudgetSplitMode(bot);
  const splitModeCycle = mode === "EQUAL" || mode === "CUSTOM_USDT" || mode === "CUSTOM_PCT_ALLOWED";
  const multiSizing = isMultiple && multiCoinSizingActiveFromBot(bot) === true;
  const cycleMode = multiSizing && splitModeCycle;
  const capEnabled = bot?.perTradeBudgetCapEnabled !== false && !multiSizing;
  const rawCap = Number(bot?.riskPerTrade) || 0;
  const usePctCap = String(bot?.perTradeBudgetInputMode || "USDT").toUpperCase() === "PCT_OF_USABLE";
  const mm = String(bot?.marketMode || "AUTO").toUpperCase();
  const allowed = computeResolveAllowedFixedUsdt(bot, account, symbol, positions, levSizing);

  const invested = sumOpenMarginUsedUsdtForUi(positions, mm);
  const headroom = Math.max(0, allowed - invested);
  const totalUsableBuffered = headroom * (bufferPct / 100);
  const usePct = bot?.multiTradeUsePctOfUsable === true;
  const p = clampNum(Number(bot?.multiTradePctOfUsable ?? 100), 0, 100);
  const sizedUsable = usePct ? (totalUsableBuffered * p) / 100 : totalUsableBuffered;
  const cycleAnchorRaw = Number(bot?.capitalCyclePoolAnchorUsdt ?? 0);
  const cycleAnchor = Number.isFinite(cycleAnchorRaw) && cycleAnchorRaw > 0 ? cycleAnchorRaw : allowed;
  const cycleSized = usePct ? (cycleAnchor * p) / 100 : cycleAnchor;
  const splitPool = cycleMode ? cycleSized : sizedUsable;
  const basePool = Number.isFinite(splitPool) && splitPool > 0 ? splitPool : 0;

  let perTradeCapUsdt = 1e15;
  if (capEnabled) {
    if (usePctCap) {
      perTradeCapUsdt = Math.max(0, (splitPool * clampNum(rawCap, 0, 100)) / 100);
    } else {
      perTradeCapUsdt = Math.max(0, rawCap);
    }
  }

  const marSym = (s: string) => sumMarginUsedForSymbolUsdt(positions, mm, s);
  const sym = String(symbol || "").trim().toUpperCase();

  const cappedLane = (laneRawMargin: number) => {
    const x = Math.max(0, laneRawMargin);
    return capEnabled ? Math.min(perTradeCapUsdt, x) : x;
  };

  const laneMarginFromUnits = (coinU: number, basePoolUnits: number) => {
    return Math.min(cappedLane(Math.max(0, coinU)), Math.max(0, basePoolUnits));
  };

  if (!isMultiple || !multiSizing) {
    const coinU = Math.max(0, splitPool - marSym(sym));
    return laneMarginFromUnits(coinU, basePool);
  }
  const list = multiBudgetSymbolsForUi(bot);
  const nDiv = Math.max(1, list.length);
  if (cycleMode && invested >= basePool - 1e-9) return 0;

  if (mode === "CUSTOM_USDT") {
    const m = (bot?.multiBudgetCoinUsdt as Record<string, number> | undefined) || {};
    const v = Number(m[sym]);
    const allocated = Number.isFinite(v) && v >= 0 ? v : 0;
    const coinU = Math.max(0, allocated - marSym(sym));
    return laneMarginFromUnits(coinU, basePool);
  }
  if (mode === "CUSTOM_PCT_ALLOWED") {
    const m = (bot?.multiBudgetCoinPct as Record<string, number> | undefined) || {};
    const pc = Number(m[sym]);
    const slice = Number.isFinite(pc) && pc >= 0 ? splitPool * (clampNum(pc, 0, 100) / 100) : 0;
    const coinU = Math.max(0, slice - marSym(sym));
    return laneMarginFromUnits(coinU, basePool);
  }
  if (mode === "EQUAL") {
    const equalSlot = nDiv > 0 ? splitPool / nDiv : 0;
    const coinU = Math.max(0, equalSlot - marSym(sym));
    const perSlot = Math.min(cappedLane(coinU), equalSlot);
    const riskPerTradeRaw = Math.max(0, perSlot * nDiv);
    return nDiv > 1 ? riskPerTradeRaw / nDiv : riskPerTradeRaw;
  }

  const coinU = Math.max(0, splitPool - marSym(sym));
  return laneMarginFromUnits(coinU, basePool);
}

/** Mirrors backend split divisor / per-leg sizing hint for min-notional and liquidation previews. */
function capitalSplitDivisorFromBot(bot: any): number {
  if (String(bot?.riskPerTradeUnit || "").toUpperCase() !== "USDT" || String(bot?.maxDailyLossUnit || "").toUpperCase() !== "USDT") {
    return 1;
  }
  if (String(bot?.universeCoinSelectMode || "").toUpperCase() !== "MULTIPLE") return 1;
  if (!multiCoinSizingActiveFromBot(bot)) return 1;
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

/**
 * Quote notional for the next auto futures open on `symbol` — matches backend `marginBase * lev` after
 * `resolveFixedUsdtRiskForOrder` (lane margin × order leverage, not the sizing-resolve ladder alone).
 */
function estimateFuturesOpenNotionalForOrderUi(
  bot: any,
  cfg: LevCfg,
  symbol: string,
  positions: any[] | undefined,
  account: any,
  futuresLevDraft: number | null,
): number | null {
  const merged = { ...cfg, ...bot };
  const levSizing = futuresLeverageForSizingResolveUi(merged, cfg, futuresLevDraft);
  const margin = previewFixedUsdtRiskUsdt(merged, symbol, positions, account, levSizing);
  if (!useFuturesNotionalAllotmentForUi(merged, symbol, positions)) return null;
  const levOrder = futuresLeverageUsedForMarginCap(merged, cfg, futuresLevDraft, { manualTrade: false });
  return Math.max(0, Number(margin) || 0) * levOrder;
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
 * Locked by default: unlock to drag; value commits on pointer release or when locking again.
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
  const unlockedRef = useRef(unlocked);
  const draftRef = useRef(draft);
  const removeUpRef = useRef<(() => void) | null>(null);
  const onCommitRef = useRef(onDebouncedCommit);
  onCommitRef.current = onDebouncedCommit;

  unlockedRef.current = unlocked;
  draftRef.current = draft;

  useEffect(() => {
    if (!unlocked) setDraft(clampNum(Math.round(serverSliderUnits), 0, 100));
  }, [serverSliderUnits, unlocked]);

  const shown = unlocked ? draft : clampNum(Math.round(serverSliderUnits), 0, 100);

  const clearUp = () => {
    removeUpRef.current?.();
    removeUpRef.current = null;
  };

  useEffect(() => () => clearUp(), []);

  const toggleLock = () => {
    if (disabled) return;
    if (unlocked) {
      clearUp();
      const toSave = clampNum(draftRef.current, 0, 100);
      deferTask(() => onCommitRef.current(toSave));
      setUnlocked(false);
    } else {
      setDraft(clampNum(Math.round(serverSliderUnits), 0, 100));
      setUnlocked(true);
    }
  };

  const onRangePointerDown = () => {
    if (disabled || !unlocked) return;
    clearUp();
    const up = () => {
      clearUp();
      if (unlockedRef.current) deferTask(() => onCommitRef.current(clampNum(draftRef.current, 0, 100)));
    };
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    removeUpRef.current = () => {
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  };

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
        onPointerDown={onRangePointerDown}
        onChange={(e) => {
          const v = Number(e.target.value);
          setDraft(v);
          draftRef.current = v;
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

function MultiBudgetCoinPctSliderRow({
  sym,
  pctVal,
  multiBudgetCoinPct,
  onCommitPatch,
}: {
  sym: string;
  pctVal: number;
  multiBudgetCoinPct: Record<string, number>;
  onCommitPatch: (patch: Record<string, unknown>) => void;
}) {
  const [preview, setPreview] = useState<number | null>(null);
  const display = preview ?? pctVal;
  return (
    <div className="flex items-center gap-1">
      <RangeSliderReleaseCommit
        min={0}
        max={100}
        step={1}
        value={clampNum(pctVal, 0, 100)}
        className="h-1.5 min-w-0 flex-1 cursor-pointer accent-emerald-600"
        onPreviewValue={setPreview}
        onCommit={(v) => {
          setPreview(null);
          onCommitPatch({
            multiBudgetCoinPct: { ...multiBudgetCoinPct, [sym]: v },
          });
        }}
      />
      <span className="w-8 shrink-0 text-right tabular-nums">{display}%</span>
    </div>
  );
}

/**
 * Numbered reference: these are **signal generators** (indicator-style paths) used by AUTO regime
 * rotation or as the fixed path in MANUAL — not separate named “strategies” in the product sense.
 * The saved **strategy version** + **instance** together define autotrade behavior.
 */
const NUMBERED_SIGNAL_SOURCES: { n: number; key: string; label: string }[] = [
  { n: 1, key: "SUPERTREND", label: "Supertrend (when Supertrend auto-trade is on, bar-close path)" },
  { n: 2, key: "CONFLUENCE", label: "Multi-indicator confluence (scored 0–100)" },
  { n: 3, key: "EMA_CROSS", label: "Trend following (EMA 12/26)" },
  { n: 4, key: "RSI_MEAN", label: "Mean reversion (RSI 14)" },
  { n: 5, key: "BREAKOUT_VOL", label: "Breakout (volume spike + range)" },
  { n: 6, key: "MOMENTUM_SURGE", label: "Momentum surge (multi-signal confirmation)" },
  { n: 7, key: "ENSEMBLE", label: "Ensemble (2+ base signals must agree)" },
  { n: 8, key: "SURF_PULSE_ML", label: "SurfPulse (trend + pullback; optional XGBoost gate)" },
  { n: 9, key: "TREND_PULLBACK", label: "Trend-Pullback Scalper (HTF trend + RSI oversold bounce)" },
  { n: 10, key: "HTF_RSI", label: "HTF RSI v3 ★ BNB 15m (~50% WR, up to ~191%)" },
  { n: 11, key: "HTF_LEG_RIDER", label: "HTF Leg Rider (trend + range breakout — big moves)" },
  { n: 12, key: "TREND_HTF_ST", label: "HTF Trend + Supertrend flip (trend legs)" },
  { n: 13, key: "SMART_REVERSAL", label: "Smart Reversal (liquidity sweep + HTF trend + RSI)" },
  { n: 14, key: "BTC_CONSENSUS", label: "BTC Consensus ★ BTC 1h (trend vote — not BNB HTF RSI)" },
  { n: 15, key: "APEX_TREND", label: "APEX Trend v2 (strict RSI zone — use HTF RSI ★ on BNB for best results)" },
  {
    n: 16,
    key: "SUPERTREND_ELITE",
    label: "Supertrend Elite ★ 1H — 4H+1H gates + ST trail (BNB ~73% WR · BTC ~64% WR Jan–May 26)",
  },
  {
    n: 20,
    key: "SAFE_INTRADAY",
    label: "Safe Intraday ★ 15m — Elite gates + session cap + 1% risk (~1%/mo target, not 1%/day)",
  },
  {
    n: 17,
    key: "SR_INTRADAY",
    label: "SR Intraday Sniper ★ 15m — session reclaim + multi-technique confluence",
  },
  {
    n: 22,
    key: "SITUATION_INTRADAY",
    label: "Situation Router ★ 15m — data-driven multi-playbook per market situation (BNB)",
  },
  {
    n: 18,
    key: "VOLUME_PROFILE",
    label: "Volume Profile ★ 15m — POC / VAH / VAL / HVN / LVN structure setups only",
  },
  {
    n: 19,
    key: "REGIME_ADAPTIVE",
    label: "Regime-Adaptive ★ 15m — one playbook per regime (trend/range/breakout) + risk overlay",
  },
  {
    n: 23,
    key: "CRT_TBS",
    label: "CRT + TBS ★ 15m — 4H candle range + turtle body soup (ICT reversal)",
  },
  {
    n: 24,
    key: "TOKYO_SESSION",
    label: "Tokyo Session ★ 15m — first-two-candle Asia bias + fixed R:R",
  },
  {
    n: 21,
    key: "UNIFIED_ELITE",
    label: "Unified Elite ★ 1H — Elite + regime gate + liq scale-up + RANGE LIQ/SR supplement",
  },
];

/** Fib gate only — brackets come from impulse swing, not fixed %. */
function isFibSoloGateOnly(cfg: {
  intradayGateFib?: boolean;
  intradayGateLiquidity?: boolean;
  intradayGateSession?: boolean;
  intradayGateVp?: boolean;
  intradayGateOrderFlow?: boolean;
  intradayGateHtfRegime?: boolean;
}) {
  return (
    cfg.intradayGateFib === true &&
    !cfg.intradayGateLiquidity &&
    !cfg.intradayGateSession &&
    !cfg.intradayGateVp &&
    !cfg.intradayGateOrderFlow &&
    !cfg.intradayGateHtfRegime
  );
}

/** SL/TP % fields are editable when Supertrend autotrade is on or any MANUAL signal path is selected. */
function slTpFieldsEditable(cfg: {
  supertrendFuturesAuto?: boolean;
  strategyMode?: string;
  intradayGateFib?: boolean;
  intradayGateLiquidity?: boolean;
  intradayGateSession?: boolean;
  intradayGateVp?: boolean;
  intradayGateOrderFlow?: boolean;
  intradayGateHtfRegime?: boolean;
}) {
  if (isFibSoloGateOnly(cfg)) return false;
  return Boolean(cfg.supertrendFuturesAuto) || String(cfg.strategyMode || "").toUpperCase() === "MANUAL";
}

/** Explicit boolean from bot WS snapshot (avoid `undefined !== false` treating missing as on). */
function trailToggleFromBot(
  bot: Record<string, unknown> | null | undefined,
  key: "futuresTrailingStFeeBreakeven" | "futuresTrailingStAdvanced",
  defaultVal = true,
): boolean {
  if (!bot || typeof bot !== "object") return defaultVal;
  const v = bot[key];
  return typeof v === "boolean" ? v : defaultVal;
}

export function TradingPanel() {
  const mode = useAppStore((s) => s.mode);
  const modeSlug = tradingModeToApiModeSlug(mode);
  const activeInstanceId = useAppStore((s) => s.activeInstanceByMode[modeSlug] ?? null);
  /** Store `bot` is liveBot + draft + WS in-flight guards — do not merge `liveBot` locally (stale WS reverts saved values). */
  const botRaw = useAppStore((s) => s.bot);
  const bot = useMemo(
    () =>
      normalizeIntradayGatesOnBot(
        botRaw && typeof botRaw === "object" && !Array.isArray(botRaw)
          ? (botRaw as Record<string, unknown>)
          : {},
      ),
    [botRaw],
  );
  const account = useAppStore((s) => s.account);
  const positions = useAppStore((s) => s.positions);
  const trades = useAppStore((s) => s.trades);
  const pushLog = useAppStore((s) => s.pushLog);
  const syncActiveInstanceOperational = useCallback(
    async (patch: InstanceOperationalPatch) => {
      if (!activeInstanceId) return;
      try {
        const inst = await api.patchInstanceOperationalConfig(activeInstanceId, patch);
        useAppStore.setState((s) => ({
          instancesByMode: patchInstanceInByMode(s.instancesByMode, activeInstanceId, inst),
        }));
      } catch (err) {
        pushLog({
          level: "warn",
          msg: `Instance DB not synced: ${String((err as Error)?.message || err)}`,
        });
      }
    },
    [activeInstanceId, pushLog],
  );
  const showMarketIntelligencePanel = useAppStore((s) => s.showMarketIntelligencePanel);
  const setShowMarketIntelligencePanel = useAppStore((s) => s.setShowMarketIntelligencePanel);
  const chartCandles = useAppStore((s) => s.candles);
  const marketSym = useAppStore((s) => String(s.market?.symbol || "").toUpperCase().trim() || null);
  const marketTf = useAppStore((s) => String(s.market?.timeframe || "").trim() || null);
  const strategyConfigDirty = useAppStore((s) => Boolean(s.strategyConfigDirtyByMode?.[modeSlug]));
  const marketAtrPct = useAppStore((s) => {
    const x = Number(s.market?.regime?.atrPct);
    return Number.isFinite(x) && x > 0 ? x : null;
  });
  const [top, setTop] = useState<any[]>([]);
  const [btLoading, setBtLoading] = useState(false);
  const [coinBusy, setCoinBusy] = useState(false);
  const [customUniverseOpen, setCustomUniverseOpen] = useState(false);
  const [trailPreviewOpen, setTrailPreviewOpen] = useState(false);
  const [trailPreviewSnap, setTrailPreviewSnap] = useState<{
    symbol: string;
    timeframe: string;
    candles: any[];
    atrPct: number | null;
  } | null>(null);
  // Bot configuration is always visible; this toggle only controls manual orders visibility below it.
  const [showManualOrders, setShowManualOrders] = useState(false);

  const [amountUsdStr, setAmountUsdStr] = useState("200");
  const [slPctStr, setSlPctStr] = useState("0.2");
  const [tpPctStr, setTpPctStr] = useState("1.5");
  const [manualUseSl, setManualUseSl] = useState(true);
  const [manualUseTp, setManualUseTp] = useState(true);
  const [manualOrderBusy, setManualOrderBusy] = useState(false);
  const [mqTuneBusy, setMqTuneBusy] = useState(false);
  const [strategySaveBusy, setStrategySaveBusy] = useState(false);
  const manualFormHydratedRef = useRef(false);
  const skipManualFormPersistRef = useRef(true);
  const saveGatedBotConfig = useCallback(async (patch: Record<string, unknown>) => {
    stageStrategyBotPatch(patch);
    return { ok: true };
  }, []);

  const [futuresUseFixedSl, setFuturesUseFixedSl] = useGuardedCheckbox(bot?.supertrendFuturesUseFixedSl !== false);
  const [futuresUseFixedTp, setFuturesUseFixedTp] = useGuardedCheckbox(bot?.supertrendFuturesUseFixedTp !== false);

  useEffect(() => {
    clearStagedStrategyBotPatch();
  }, [modeSlug]);

  useEffect(() => {
    const d = bot?.tradingFormDefaults as {
      amountUsdStr?: string;
      slPctStr?: string;
      tpPctStr?: string;
      manualUseSl?: boolean;
      manualUseTp?: boolean;
    } | undefined;
    if (!d || manualFormHydratedRef.current) return;
    if (typeof d.amountUsdStr === "string") setAmountUsdStr(d.amountUsdStr);
    if (typeof d.manualUseSl === "boolean") setManualUseSl(d.manualUseSl);
    if (typeof d.manualUseTp === "boolean") setManualUseTp(d.manualUseTp);
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
          tradingFormDefaults: { amountUsdStr, slPctStr, tpPctStr, manualUseSl, manualUseTp },
        })
        .catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [amountUsdStr, slPctStr, tpPctStr, manualUseSl, manualUseTp]);

  const cfg = useMemo(() => {
    return {
      aiThreshold: Number(bot?.aiThreshold ?? 0.65),
      riskPerTrade: Number(bot?.riskPerTrade ?? 1),
      maxDailyLoss: Number(bot?.maxDailyLoss ?? 5),
      riskPerTradeUnit: bot?.riskPerTradeUnit === "USDT" ? ("USDT" as const) : ("PCT" as const),
      maxDailyLossUnit: bot?.maxDailyLossUnit === "USDT" ? ("USDT" as const) : ("PCT" as const),
      perTradeBudgetCapEnabled: bot?.perTradeBudgetCapEnabled !== false,
      strategyMode: bot?.strategyMode ?? "AUTO",
      timeframe: (() => {
        const raw = String(bot?.timeframe ?? "1m").trim();
        return (BOT_TRADING_TIMEFRAMES as readonly string[]).includes(raw) ? raw : "1m";
      })(),
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
      supertrendMoveQualityGate: bot?.supertrendMoveQualityGate === true,
      supertrendHtf4hEnabled: bot?.supertrendHtf4hEnabled === true,
      supertrendHtf4hPeriod: Math.max(2, Math.min(50, Math.round(Number(bot?.supertrendHtf4hPeriod ?? 10)))),
      supertrendHtf4hMultiplier: Math.max(0.5, Number(bot?.supertrendHtf4hMultiplier ?? 3)),
      volumeProfileEnabled: bot?.volumeProfileEnabled === true,
      volumeProfileSoftGates: bot?.volumeProfileSoftGates !== false,
      volumeProfileGatesEnabled: bot?.volumeProfileGatesEnabled === true,
      intradayVpBrackets: bot?.intradayVpBrackets === true,
      intradayGateLiquidity: isIntradayGateChecked(bot as Record<string, unknown>, "intradayGateLiquidity"),
      intradayGateSession: isIntradayGateChecked(bot as Record<string, unknown>, "intradayGateSession"),
      intradayGateFib: isIntradayGateChecked(bot as Record<string, unknown>, "intradayGateFib"),
      intradayGateVp: isIntradayGateChecked(bot as Record<string, unknown>, "intradayGateVp"),
      intradayGateOrderFlow: isIntradayGateChecked(bot as Record<string, unknown>, "intradayGateOrderFlow"),
      intradayGateHtfRegime: isIntradayGateChecked(bot as Record<string, unknown>, "intradayGateHtfRegime"),
      intradayGateInstitutionalSr: isIntradayGateChecked(bot as Record<string, unknown>, "intradayGateInstitutionalSr"),
      intradayGateSmcIct: isIntradayGateChecked(bot as Record<string, unknown>, "intradayGateSmcIct"),
      intradaySmcIctProfile: String(bot?.intradaySmcIctProfile ?? "sweep"),
      intradaySmcPickMode: String(bot?.intradaySmcPickMode ?? "per_signal"),
      intradaySmcOneTradePerDay: bot?.intradaySmcOneTradePerDay === true,
      intradaySmcKillzoneMode: String(bot?.intradaySmcKillzoneMode ?? "LONDON_NY"),
      intradaySmcEntryZoneMode: String(bot?.intradaySmcEntryZoneMode ?? "EITHER"),
      intradaySmcHtfStrictness: String(bot?.intradaySmcHtfStrictness ?? "either"),
      intradaySmcMinAdx: Math.max(0, Math.min(100, Math.round(Number(bot?.intradaySmcMinAdx ?? 15)))),
      intradaySmcMinRr: Math.max(0, Math.min(10, Number(bot?.intradaySmcMinRr ?? 1.5))),
      intradaySmcSlMode: String(bot?.intradaySmcSlMode ?? "structure"),
      intradaySmcMaxTpRr: Math.max(0, Math.min(20, Number(bot?.intradaySmcMaxTpRr ?? 5))),
      intradaySmcMaxHoldBars: Math.max(0, Math.min(2000, Math.round(Number(bot?.intradaySmcMaxHoldBars ?? 48)))),
      intradaySmcRequireMss: bot?.intradaySmcRequireMss === true,
      intradaySmcRequireRetrace: bot?.intradaySmcRequireRetrace === true,
      intradaySmcRequireHtfBias: bot?.intradaySmcRequireHtfBias !== false,
      intradaySmcRequireChoch: bot?.intradaySmcRequireChoch === true,
      intradaySmcRequireBos: bot?.intradaySmcRequireBos === true,
      intradaySmcRequireConfirm: bot?.intradaySmcRequireConfirm === true,
      intradaySmcRequireFvgRetrace: bot?.intradaySmcRequireFvgRetrace === true,
      intradaySrAPlusMode: bot?.intradaySrAPlusMode === true,
      intradaySrMinVolRatio: Math.max(0, Math.min(5, Number(bot?.intradaySrMinVolRatio ?? 1.2))),
      intradaySrMinHtfSep: Math.max(0, Math.min(0.01, Number(bot?.intradaySrMinHtfSep ?? 0.0004))),
      intradaySrZoneWidthPct: Math.max(0.0001, Math.min(0.02, Number(bot?.intradaySrZoneWidthPct ?? 0.002))),
      intradaySrBosMaxBarsAfterReclaim: Math.max(
        0,
        Math.min(10, Math.round(Number(bot?.intradaySrBosMaxBarsAfterReclaim ?? 3))),
      ),
      intradaySrMinConfirmWick: Math.max(0, Math.min(1, Number(bot?.intradaySrMinConfirmWick ?? 0.38))),
      intradayLiqMinSweepExtensionPct: Math.max(
        0,
        Math.min(0.02, Number(bot?.intradayLiqMinSweepExtensionPct ?? 0.008)),
      ),
      intradayLiqTp1Enabled: bot?.intradayLiqTp1Enabled !== false,
      intradayLiqTp2Enabled: bot?.intradayLiqTp2Enabled !== false,
      intradayLiqBreakevenAfterPartial: bot?.intradayLiqBreakevenAfterPartial !== false,
      intradayLiqMinRr: Math.max(0, Math.min(5, Number(bot?.intradayLiqMinRr ?? 1.5))),
      intradayLiqMaxTpRr: (() => {
        if (bot != null && Object.prototype.hasOwnProperty.call(bot, "intradayLiqMaxTpRr")) {
          return Math.max(0, Math.min(20, Number(bot.intradayLiqMaxTpRr)));
        }
        return Math.max(0, Math.min(20, Number(bot?.intradaySmcMaxTpRr ?? 5)));
      })(),
      intradayLiqMaxHoldBars: Math.max(
        0,
        Math.min(2000, Math.round(Number(bot?.intradayLiqMaxHoldBars ?? 48))),
      ),
      vpLookbackBars: Math.max(48, Math.min(2000, Math.round(Number(bot?.vpLookbackBars ?? 672)))),
      vpMinRR: Math.max(0.8, Math.min(5, Number(bot?.vpMinRR ?? 1.5))),
      // SUPERTREND_ELITE gate params
      eliteStRequireHtf4hAlign: bot?.eliteStRequireHtf4hAlign === true,
      eliteStHtf4hPeriod: Math.max(2, Math.min(50, Math.round(Number(bot?.eliteStHtf4hPeriod ?? 10)))),
      eliteStHtf4hMultiplier: Math.max(0.5, Number(bot?.eliteStHtf4hMultiplier ?? 3)),
      eliteStRequireHtf1hEmaAlign: bot?.eliteStRequireHtf1hEmaAlign === true,
      eliteStHtf1hMinSep: Math.max(0, Number(bot?.eliteStHtf1hMinSep ?? 0.0003)),
      eliteStHtf1hSepMode: (() => {
        const m = String(bot?.eliteStHtf1hSepMode ?? "FIXED").toUpperCase();
        return ["FIXED", "ATR", "PERCENTILE", "ADX", "CALIBRATED"].includes(m) ? m : "FIXED";
      })(),
      eliteStHtf1hMinSepAtrMult: clampNum(Number(bot?.eliteStHtf1hMinSepAtrMult ?? 0.25), 0.05, 2),
      eliteStHtf1hMinSepFloor: clampNum(Number(bot?.eliteStHtf1hMinSepFloor ?? 0.0002), 0, 0.01),
      eliteStHtf1hMinSepCeil: clampNum(Number(bot?.eliteStHtf1hMinSepCeil ?? 0.0012), 0, 0.01),
      eliteStHtf1hSepPercentileLookback: clampNum(
        Math.round(Number(bot?.eliteStHtf1hSepPercentileLookback ?? 90)),
        20,
        200,
      ),
      eliteStHtf1hSepPercentileMult: clampNum(Number(bot?.eliteStHtf1hSepPercentileMult ?? 1), 0.5, 3),
      eliteStHtf1hSepAdxBase: clampNum(Number(bot?.eliteStHtf1hSepAdxBase ?? 0.0003), 0, 0.01),
      eliteStHtf1hSepAdxAlpha: clampNum(Number(bot?.eliteStHtf1hSepAdxAlpha ?? 1.5), 0, 5),
      eliteStHtf1hSepAdxRef: clampNum(Math.round(Number(bot?.eliteStHtf1hSepAdxRef ?? 25)), 1, 100),
      eliteStHtf1hSepCalibratePct: clampNum(Math.round(Number(bot?.eliteStHtf1hSepCalibratePct ?? 40)), 1, 99),
      eliteStHtf1hSepCalibrateBars: clampNum(
        Math.round(Number(bot?.eliteStHtf1hSepCalibrateBars ?? 90)),
        20,
        200,
      ),
      eliteStAutoCalibrate: bot?.eliteStAutoCalibrate === true,
      eliteStAutoFullTune: bot?.eliteStAutoFullTune !== false,
      eliteStAutoProfileBars: clampNum(Math.round(Number(bot?.eliteStAutoProfileBars ?? 90)), 40, 200),
      eliteStAutoBracketMode: (() => {
        const m = String(bot?.eliteStAutoBracketMode ?? "ATR").toUpperCase();
        return ["ATR", "OFF", "FIXED"].includes(m) ? m : "ATR";
      })(),
      eliteStAutoMinAdxFloor: clampNum(Math.round(Number(bot?.eliteStAutoMinAdxFloor ?? 15)), 0, 100),
      eliteStAutoMinAdxCeil: clampNum(Math.round(Number(bot?.eliteStAutoMinAdxCeil ?? 30)), 1, 100),
      eliteStMinAdx: clampNum(Math.round(Number(bot?.eliteStMinAdx ?? 0)), 0, 100),
      eliteStRequireAdxRising: bot?.eliteStRequireAdxRising === true,
      eliteStMinVolumeVsAvg: Math.max(0, Number(bot?.eliteStMinVolumeVsAvg ?? 0)),
      eliteStRequireAtrExpansion: bot?.eliteStRequireAtrExpansion === true,
      eliteStMinAtrExpansion: Math.max(1, Number(bot?.eliteStMinAtrExpansion ?? 1.15)),
      eliteStLiqSweepEnabled: bot?.eliteStLiqSweepEnabled === true,
      supertrendBigMoveGateEnabled: bot?.supertrendBigMoveGateEnabled === true,
      supertrendBigMoveMinStrength: clampNum(Math.round(Number(bot?.supertrendBigMoveMinStrength ?? 65)), 0, 100),
      supertrendBigMoveMinMoveSlRatio: Math.max(1, Number(bot?.supertrendBigMoveMinMoveSlRatio ?? 1.5)),
      supertrendBigMoveMinAdx: clampNum(Math.round(Number(bot?.supertrendBigMoveMinAdx ?? 22)), 0, 100),
      supertrendBigMoveMinScore: clampNum(Number(bot?.supertrendBigMoveMinScore ?? 0.55), 0, 1),
      supertrendBigMoveMaxCandlesSinceFlip: Math.max(0, Math.min(20, Math.floor(Number(bot?.supertrendBigMoveMaxCandlesSinceFlip ?? 2)))),
      supertrendBigMoveMinVolumeVsAvg: Math.max(0, Number(bot?.supertrendBigMoveMinVolumeVsAvg ?? 1.1)),
      supertrendBigMoveExpectedMoveAtrMult: Math.max(0.1, Number(bot?.supertrendBigMoveExpectedMoveAtrMult ?? 1.8)),
      supertrendMoveQualityMinScore: clampNum(Number(bot?.supertrendMoveQualityMinScore ?? 0.6), 0, 1),
      supertrendMoveQualityMinAdx: clampNum(Math.round(Number(bot?.supertrendMoveQualityMinAdx ?? 23)), 0, 100),
      supertrendMoveQualityMinMoveSlRatio: Math.max(1, Number(bot?.supertrendMoveQualityMinMoveSlRatio ?? 1.5)),
      supertrendMoveQualityExpectedMoveAtrMult: Math.max(0.1, Number(bot?.supertrendMoveQualityExpectedMoveAtrMult ?? 1.0)),
      supertrendMoveQualityMinAtrExpansion: Math.max(0, Number(bot?.supertrendMoveQualityMinAtrExpansion ?? 1.08)),
      supertrendMoveQualityMinBodyVsAvg: clampNum(Number(bot?.supertrendMoveQualityMinBodyVsAvg ?? 0.62), 0.15, 1),
      supertrendMoveQualityMinDirectionalBody: clampNum(Number(bot?.supertrendMoveQualityMinDirectionalBody ?? 0), 0, 1),
      supertrendMoveQualityMinVolumeVsAvg: Math.max(0, Number(bot?.supertrendMoveQualityMinVolumeVsAvg ?? 0)),
      marketDecisionEnabled:
        bot?.marketDecision != null &&
        typeof bot.marketDecision === "object" &&
        (bot.marketDecision as { enabled?: boolean }).enabled === true,
      marketDecisionMerged: mergeMarketDecisionConfig(
        bot?.marketDecision != null && typeof bot.marketDecision === "object"
          ? (bot.marketDecision as Partial<MarketDecisionEngineConfig>)
          : undefined,
      ),
      supertrendBreakoutConfirm: bot?.supertrendBreakoutConfirm === true,
      supertrendBreakoutMaxBars: Math.max(1, Math.min(20, Math.floor(Number(bot?.supertrendBreakoutMaxBars ?? 5)))),
      signalStrengthOpenMin: clampNum(Math.round(Number(bot?.signalStrengthOpenMin ?? 65)), 0, 100),
      supertrendFuturesMinAiProb: clampNum(Number(bot?.supertrendFuturesMinAiProb ?? 0.55), 0, 1),
      surfPulseMlGateEnabled: bot?.surfPulseMlGateEnabled !== false,
      surfPulseMlThreshold: clampNum(Number(bot?.surfPulseMlThreshold ?? 0.6), 0, 1),
      intelligenceGateEnabled: bot?.intelligenceGateEnabled === true,
      trailingStopLossAuto: bot?.trailingStopLossAuto === true,
      futuresTrailingStopMode:
        String(bot?.futuresTrailingStopMode || "SUPERTREND").toUpperCase() === "FEE_LADDER" ? "FEE_LADDER" : "SUPERTREND",
      futuresTrailingStFeeBreakeven: trailToggleFromBot(
        bot as Record<string, unknown> | undefined,
        "futuresTrailingStFeeBreakeven",
        false,
      ),
      futuresTrailingStAdvanced: trailToggleFromBot(bot as Record<string, unknown> | undefined, "futuresTrailingStAdvanced"),
      trailingStopExtraScalpingPcts: parseTrailingExtraPcts(bot),
      trailOpenFeeRate: clampNum(Number(bot?.trailOpenFeeRate ?? 0.0004), 0, 0.01),
      trailCloseFeeRate: clampNum(Number(bot?.trailCloseFeeRate ?? 0.0004), 0, 0.01),
      tradeHistoryMakerOpenFeeRate: clampNum(Number(bot?.tradeHistoryMakerOpenFeeRate ?? 0.0002), 0, 0.01),
      tradeHistoryMakerCloseFeeRate: clampNum(Number(bot?.tradeHistoryMakerCloseFeeRate ?? 0.0002), 0, 0.01),
      tradeHistoryTakerOpenFeeRate: clampNum(Number(bot?.tradeHistoryTakerOpenFeeRate ?? 0.0005), 0, 0.01),
      tradeHistoryTakerCloseFeeRate: clampNum(Number(bot?.tradeHistoryTakerCloseFeeRate ?? 0.0005), 0, 0.01),
      trailFeeBeMultiplier: clampNum(Number(bot?.trailFeeBeMultiplier ?? DEFAULT_TRAIL_FEE_BE_MULTIPLIER), 1, 2),
      trailBufferRate: clampNum(Number(bot?.trailBufferRate ?? 0.0015), 0, 0.05),
      trailActivationSlippageFrac: clampNum(Number(bot?.trailActivationSlippageFrac ?? 0), 0, 0.01),
      trailT01LockSlippageFrac: clampNum(Number(bot?.trailT01LockSlippageFrac ?? 0), 0, 0.01),
      trailBufferAtrMult: clampNum(Number(bot?.trailBufferAtrMult ?? 0), 0, 1),
      trailBufferMode: String(bot?.trailBufferMode || "PERCENT").toUpperCase() === "ATR" ? "ATR" : "PERCENT",
      trailMinSlDistFrac: clampNum(Number(bot?.trailMinSlDistFrac ?? 0.002), 0, 0.1),
      trailMinGapFromMarkFrac: clampNum(Number(bot?.trailMinGapFromMarkFrac ?? 0), 0, 0.2),
      trailMaintMarginRate: clampNum(Number(bot?.trailMaintMarginRate ?? 0.005), 0, 0.1),
      trailPostT02SpacingFrac:
        bot?.trailPostT02SpacingFrac != null && Number.isFinite(Number(bot.trailPostT02SpacingFrac))
          ? clampNum(Number(bot.trailPostT02SpacingFrac), 0, 0.05)
          : 0,
      trailPostT02MaxExtraTiers: Math.max(
        10,
        Math.min(500, Math.floor(Number(bot?.trailPostT02MaxExtraTiers ?? 150))),
      ),
      /**
       * Independent post-T02 activation buffer. 0 in the UI slider means "inherit T01/T02 buffer"
       * (backend stores that as `null`). Any positive value decouples the profit-rung cushion.
       */
      trailPostT02ActivationBufferRate:
        bot?.trailPostT02ActivationBufferRate != null &&
        Number.isFinite(Number(bot.trailPostT02ActivationBufferRate))
          ? clampNum(Number(bot.trailPostT02ActivationBufferRate), 0, 0.05)
          : 0,
      supertrendFuturesFixedSlPct: clampNum(Number(bot?.supertrendFuturesFixedSlPct ?? 0.002), 0.00005, 0.2),
      supertrendFuturesFixedTpPct: clampNum(Number(bot?.supertrendFuturesFixedTpPct ?? 0.015), 0.00005, 0.5),
      supertrendFuturesUseFixedSl: bot?.supertrendFuturesUseFixedSl !== false,
      supertrendFuturesUseFixedTp: bot?.supertrendFuturesUseFixedTp !== false,
      supertrendFuturesTwoWay: bot?.supertrendFuturesTwoWay === true,
      supertrendFuturesMaxEntrySlippagePct: clampNum(Number(bot?.supertrendFuturesMaxEntrySlippagePct ?? 0.15), 0, 5),
      supertrendFuturesEntryOpenStyle: (() => {
        const s = String(bot?.supertrendFuturesEntryOpenStyle || "AUTO").toUpperCase();
        if (s === "MARKET" || s === "LIMIT_IOC") return s;
        return "AUTO" as const;
      })(),
      supertrendFuturesEntryRecheckMs: Math.max(0, Math.floor(Number(bot?.supertrendFuturesEntryRecheckMs ?? 0))),
      supertrendFuturesIocFallbackMarket: bot?.supertrendFuturesIocFallbackMarket === true,
      supertrendFuturesRequireMarkPrice: bot?.supertrendFuturesRequireMarkPrice === true,
      supertrendFuturesRequireBookTicker: bot?.supertrendFuturesRequireBookTicker === true,
      supertrendFuturesMaxSignalLagMs: Math.max(0, Math.floor(Number(bot?.supertrendFuturesMaxSignalLagMs ?? 0))),
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
      multiCoinCapitalSizingActive: multiCoinSizingActiveFromBot(bot),
      perTradeBudgetInputMode: bot?.perTradeBudgetInputMode === "PCT_OF_USABLE" ? ("PCT_OF_USABLE" as const) : ("USDT" as const),
      usableCapitalBufferPct: usableBufferPctFromBot(bot),
      multiBudgetSplitMode: derivedMultiBudgetSplitMode(bot),
      multiBudgetCoinUsdt: (bot?.multiBudgetCoinUsdt && typeof bot.multiBudgetCoinUsdt === "object"
        ? (bot.multiBudgetCoinUsdt as Record<string, number>)
        : {}) as Record<string, number>,
      multiBudgetCoinPct: (bot?.multiBudgetCoinPct && typeof bot.multiBudgetCoinPct === "object"
        ? (bot.multiBudgetCoinPct as Record<string, number>)
        : {}) as Record<string, number>,
      capitalAllotmentCompoundPnlUi: bot?.capitalAllotmentCompoundPnlUi === true,
      capitalCycleStrategyBalanceUsdt: Math.max(0, Number(bot?.capitalCycleStrategyBalanceUsdt ?? 0)),
      capitalCyclePoolAnchorUsdt: Math.max(0, Number(bot?.capitalCyclePoolAnchorUsdt ?? 0)),
      capitalCycleRealizedPnlUsdt: Number(bot?.capitalCycleRealizedPnlUsdt ?? 0),
      capitalCycleSymbols: Array.isArray(bot?.capitalCycleSymbols) ? [...bot.capitalCycleSymbols] : [],
    };
  }, [bot]);

  const activeSymbol = useMemo(() => {
    const s = String(bot?.symbol || "").toUpperCase().trim();
    return s || "BTCUSDT";
  }, [bot?.symbol]);

  const trailPreviewSymbol = marketSym || activeSymbol;
  const trailPreviewTimeframe = marketTf || String(bot?.timeframe || "1h");
  const trailPostT02SpacingFracRaw =
    bot?.trailPostT02SpacingFrac != null && Number.isFinite(Number(bot.trailPostT02SpacingFrac))
      ? Number(bot.trailPostT02SpacingFrac)
      : null;
  const trailPreviewCfg: TrailPreviewCfg = useMemo(() => {
    return {
      futuresTrailingStopMode: cfg.futuresTrailingStopMode,
      futuresTrailingStFeeBreakeven: cfg.futuresTrailingStFeeBreakeven,
      futuresTrailingStAdvanced: cfg.futuresTrailingStAdvanced,
      trailOpenFeeRate: cfg.trailOpenFeeRate,
      trailCloseFeeRate: cfg.trailCloseFeeRate,
      trailFeeBeMultiplier: cfg.trailFeeBeMultiplier,
      trailActivationSlippageFrac: cfg.trailActivationSlippageFrac,
      trailT01LockSlippageFrac: cfg.trailT01LockSlippageFrac,
      trailBufferMode: cfg.trailBufferMode,
      trailBufferRate: cfg.trailBufferRate,
      trailBufferAtrMult: cfg.trailBufferAtrMult,
      trailMaintMarginRate: cfg.trailMaintMarginRate,
      trailMinSlDistFrac: cfg.trailMinSlDistFrac,
      trailMinGapFromMarkFrac: cfg.trailMinGapFromMarkFrac,
      trailPostT02SpacingFrac: trailPostT02SpacingFracRaw,
      trailPostT02MaxExtraTiers: cfg.trailPostT02MaxExtraTiers,
      /**
       * Preview modal's "inherit" toggle corresponds to `null` in the backend. In the local cfg we
       * keep a `0` sentinel (so the UI slider has a finite number), so translate here.
       */
      trailPostT02ActivationBufferRate:
        Number(cfg.trailPostT02ActivationBufferRate) > 0
          ? Number(cfg.trailPostT02ActivationBufferRate)
          : null,
      trailingStopExtraScalpingPcts: cfg.trailingStopExtraScalpingPcts,
    };
  }, [
    cfg.futuresTrailingStopMode,
    cfg.futuresTrailingStFeeBreakeven,
    cfg.futuresTrailingStAdvanced,
    cfg.trailOpenFeeRate,
    cfg.trailCloseFeeRate,
    cfg.trailFeeBeMultiplier,
    cfg.trailActivationSlippageFrac,
    cfg.trailT01LockSlippageFrac,
    cfg.trailBufferMode,
    cfg.trailBufferRate,
    cfg.trailBufferAtrMult,
    cfg.trailMaintMarginRate,
    cfg.trailMinSlDistFrac,
    cfg.trailMinGapFromMarkFrac,
    trailPostT02SpacingFracRaw,
    cfg.trailPostT02MaxExtraTiers,
    cfg.trailPostT02ActivationBufferRate,
    cfg.trailingStopExtraScalpingPcts,
  ]);

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
  /** USD-M MIN_NOTIONAL per symbol (from exchangeInfo) for multi-coin capital gate labels. */
  const [futuresMinNotionalBySymbol, setFuturesMinNotionalBySymbol] = useState<Record<string, number>>({});
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
    const sizingBot = { ...cfg, ...bot };
    const levSizingAt = futuresLeverageForSizingResolveUi(sizingBot, cfg, futuresLevDraft);
    const fixedCapital = cfg.riskPerTradeUnit === "USDT" && cfg.maxDailyLossUnit === "USDT";
    const effRiskUsdt =
      fixedCapital
        ? previewFixedUsdtRiskUsdt(sizingBot, activeSymbol, positions, account, levSizingAt)
        : cfg.riskPerTrade;
    if (cfg.riskPerTradeUnit === "USDT") {
      if (needFut && legs.fut) {
        const { min: futMin, qa: futQa } = legs.fut;
        const levForNom = fixedCapital ? levSizingAt : levFutures;
        const levLabel =
          String(cfg.futuresLeverageMode || "AUTO").toUpperCase() === "MANUAL"
            ? `Leverage × ${levForNom}`
            : `AUTO ~${levForNom}x`;
        const maxAff = futFree != null ? futFree * levForNom * 0.9 : null;
        const notionalFromMargin = effRiskUsdt * levForNom;
        const orderNom = maxAff != null ? Math.min(notionalFromMargin, maxAff) : notionalFromMargin;
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
    const levSizingAt = futuresLeverageForSizingResolveUi(bot, cfg, futuresLevDraft);
    const levForNom = fixedUsdt ? levSizingAt : lev;
    const prob = fixedUsdt ? 0.75 : Number(bot?.lastAi?.gateProbability ?? bot?.lastAi?.probability ?? 0.5);
    const tm = riskTierMultPreview(prob, fixedUsdt);
    if (tm <= 0) return { kind: "tier_zero" as const };

    const maxAff = futFree * levForNom * 0.9;
    const effRisk =
      fixedUsdt
        ? previewFixedUsdtRiskUsdt({ ...cfg, ...bot }, activeSymbol, positions, account, levSizingAt)
        : cfg.riskPerTrade;
    /** `effRisk` is initial margin USDT; notional = margin × leverage (same as `riskPlan` / liquidation preview). */
    const targetNom = Math.min(effRisk * tm * levForNom, maxAff);
    if (!(targetNom > 0)) return { kind: "incomplete" as const };

    const regime = String(bot?.lastRegime?.type || "RANGE");
    const p = buildAutotradeLongLiquidationPreview({
      entryPx: marketClose,
      leverage: levForNom,
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
    const merged = { ...cfg, ...bot };
    const bufferPct = cfg.usableCapitalBufferPct;
    const levSizing = futuresLeverageForSizingResolveUi(merged, cfg, futuresLevDraft);
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
    const splitDiv = capitalSplitDivisorFromBot(merged);
    const fixedUsd = cfg.riskPerTradeUnit === "USDT" && cfg.maxDailyLossUnit === "USDT";
    const splitMode = derivedMultiBudgetSplitMode(merged);
    const cycleMode =
      fixedUsd &&
      cfg.universeCoinSelectMode === "MULTIPLE" &&
      cfg.multiCoinCapitalSizingActive &&
      (splitMode === "EQUAL" || splitMode === "CUSTOM_USDT" || splitMode === "CUSTOM_PCT_ALLOWED");
    const baseAllowedPoolUsdt = fixedUsd
      ? computeResolveAllowedFixedUsdt(merged, account, activeSymbol, positions, levSizing)
      : effectiveAllowedPoolUsdt(merged, account);
    const compoundOn = cfg.capitalAllotmentCompoundPnlUi === true;
    const pnlAnchorRaw = Number(bot?.allowedBudgetPnlAnchorMs);
    const allowedBudgetPnlAnchorMs =
      Number.isFinite(pnlAnchorRaw) && pnlAnchorRaw > 0 ? Math.round(pnlAnchorRaw) : null;
    const compoundCloseNet = compoundOn ? cumulativeSignedClosePnlUsd(trades, allowedBudgetPnlAnchorMs) : 0;
    const compoundUnrealized = compoundOn ? sumUnrealizedPnlUsdtForUi(positions, mm, allowedBudgetPnlAnchorMs) : 0;
    const compoundTradingAdj = compoundCloseNet + compoundUnrealized;
    const cycleAnchor = Number(cfg.capitalCyclePoolAnchorUsdt) || 0;
    const cycleBase = cycleAnchor > 0 ? cycleAnchor : baseAllowedPoolUsdt;
    const allowedPoolUsdt = cycleMode ? cycleBase : baseAllowedPoolUsdt + compoundTradingAdj;
    const invested = sumOpenMarginUsedUsdtForUi(positions, mm);
    /** Raw headroom from allowed cap (can be negative if invested > allowed). */
    const usablePoolRaw = allowedPoolUsdt - invested;
    /** Buffered usable margin pool (matches server): max(0, headroom) × buffer%. */
    const usableBuffered = Math.max(0, usablePoolRaw) * (bufferPct / 100);
    /** Pool used for sizing after optional “% of usable” trim (never negative). */
    const usableStrategy = usableBuffered;
    const cycleSizedUsdt =
      cfg.multiTradeUsePctOfUsable === true
        ? (cycleBase * clampNum(Number(cfg.multiTradePctOfUsable ?? 100), 0, 100)) / 100
        : cycleBase;
    const sizedUsableUsdt = cycleMode
      ? Math.max(0, cycleSizedUsdt)
      : (cfg.multiTradeUsePctOfUsable === true
          ? (usableStrategy * clampNum(Number(cfg.multiTradePctOfUsable ?? 100), 0, 100)) / 100
          : usableStrategy);
    const laneBudget =
      cfg.riskPerTradeUnit === "USDT"
        ? previewFixedUsdtRiskUsdt(merged, activeSymbol, positions, account, levSizing)
        : cfg.riskPerTrade;
    /** `laneBudget` is initial margin (invested capital) per symbol (fixed USDT sizing). */
    const laneMarginApprox = Number(laneBudget) || 0;
    const allowedMain = `${allowedPoolUsdt.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDT`;
    const anchorHint =
      compoundOn && allowedBudgetPnlAnchorMs != null
        ? ` · P&L since allowed-budget edit ${new Date(allowedBudgetPnlAnchorMs).toLocaleString()}`
        : compoundOn
          ? " · No anchor yet — next change to allowed USDT / % / input mode starts the clock"
          : "";
    const compoundBreakdownLine = cycleMode
      ? `Cycle pool anchor ${cycleBase.toFixed(2)} USDT${cfg.capitalCycleRealizedPnlUsdt !== 0 ? ` · realized this cycle ${cfg.capitalCycleRealizedPnlUsdt >= 0 ? "+" : ""}${Number(cfg.capitalCycleRealizedPnlUsdt).toFixed(2)}` : ""}`
      : compoundOn && (compoundCloseNet !== 0 || compoundUnrealized !== 0 || baseAllowedPoolUsdt !== allowedPoolUsdt)
        ? `Base cap ${baseAllowedPoolUsdt.toFixed(2)} + closes (net, after anchor) ${compoundCloseNet >= 0 ? "+" : ""}${compoundCloseNet.toFixed(2)} + open uPnL (opens ≥ anchor) ${compoundUnrealized >= 0 ? "+" : ""}${compoundUnrealized.toFixed(2)}${anchorHint}`
        : compoundOn
          ? `Base cap ${baseAllowedPoolUsdt.toFixed(2)} (no post-anchor P&L in list / no qualifying open legs)${anchorHint}`
          : null;
    const allowedSub =
      fixedUsd && cfg.universeCoinSelectMode === "MULTIPLE" && cfg.multiCoinCapitalSizingActive && cfg.multiBudgetSplitMode === "EQUAL" && splitDiv > 1
        ? `Equal split target ≈ ${laneMarginApprox.toFixed(2)} USDT margin per active symbol (${splitDiv} in list)`
        : fixedUsd && cfg.universeCoinSelectMode === "MULTIPLE" && cfg.multiCoinCapitalSizingActive && cfg.multiBudgetSplitMode !== "FULL"
          ? `Mode: ${cfg.multiBudgetSplitMode.replace(/_/g, " ")} · per-symbol margin ≈ ${laneMarginApprox.toFixed(2)} USDT (${activeSymbol})`
          : cfg.riskPerTradeUnit === "PCT"
            ? `Per-trade ${clampNum(cfg.riskPerTrade, 0, 100).toFixed(2)}% of allowed pool at stop (before confidence tiers).`
            : null;
    const perTradeUsdtForDeploy =
      cfg.riskPerTradeUnit === "USDT"
        ? Number(laneBudget ?? cfg.riskPerTrade) || 0
        : allowedPoolUsdt > 0
          ? allowedPoolUsdt * (clampNum(cfg.riskPerTrade, 0, 100) / 100)
          : 0;
    const levForFixedDeploy = fixedUsd ? levSizing : lev;
    const effFut =
      futFree != null && perTradeUsdtForDeploy > 0
        ? effectiveFuturesOrderNotionalUsdt(perTradeUsdtForDeploy, futFree, levForFixedDeploy)
        : null;
    const effSpot =
      spotFree != null && perTradeUsdtForDeploy > 0 ? effectiveSpotOrderNotionalUsdt(perTradeUsdtForDeploy, spotFree) : null;
    const deployParts: string[] = [];
    if ((mm === "FUTURES" || mm === "AUTO") && effFut != null) {
      deployParts.push(`Futures order ≤ ~${effFut.toFixed(2)} USDT (after margin×lev ~90%)`);
    }
    if ((mm === "SPOT" || mm === "AUTO") && effSpot != null) {
      deployParts.push(`Spot order ≤ ~${effSpot.toFixed(2)} USDT`);
    }
    if (deployParts.length === 0) {
      deployParts.push(
        cfg.riskPerTradeUnit === "PCT" && perTradeUsdtForDeploy <= 0
          ? "Set allowed budget (above) to preview venue-capped deploy from % per-trade."
          : "Fund the venue wallet to see venue-capped deployable notional.",
      );
    }
    const usableFormula = cycleMode
      ? `cycle pool ${cycleBase.toFixed(2)}${cfg.multiTradeUsePctOfUsable === true ? ` × ${clampNum(Number(cfg.multiTradePctOfUsable ?? 100), 0, 100).toFixed(2)}%` : ""} (fixed until flat rebalance)`
      : `max(0, ${allowedPoolUsdt.toFixed(2)} − ${invested.toFixed(2)}) × ${bufferPct}%`;
    const usableSizingNote = cycleMode
      ? "Cycle mode: per-coin slots stay fixed during open positions (no cross-coin shrink). Rebalance happens after all positions are flat, using realized PnL."
      : usablePoolRaw < 0
        ? "Open margin exceeds allowed — raise allowed or close positions so headroom recovers."
        : usablePoolRaw === 0
          ? "No headroom at this cap until open margin drops below allowed."
          : `Buffered usable is ${bufferPct}% of headroom (tolerance below max deployment). Splits and per-trade caps use the sized pool row.`;
    const deployLine = deployParts.join(" · ");
    const sliderDenom = walletFreeMarginTotal;
    const walletSliderPct =
      sliderDenom > 0 && allowedPoolUsdt > 0
        ? clampNum((allowedPoolUsdt / sliderDenom) * 100, 0, 100)
        : cfg.allowedBudgetWalletPct;
    return {
      allowedMain,
      allowedSub,
      deployLine,
      walletFreeMarginTotal,
      walletSliderPct,
      fixedUsd,
      cycleMode,
      allowedPoolUsdt,
      allowedPoolUsdtBase: baseAllowedPoolUsdt,
      capitalAllotmentCompoundPnlUi: compoundOn,
      compoundCloseNet,
      compoundUnrealized,
      compoundBreakdownLine,
      allowedBudgetPnlAnchorMs,
      usableStrategy,
      sizedUsableUsdt,
      usablePoolRaw,
      usableBuffered,
      usableFormula,
      usableSizingNote,
      bufferPct,
      investedOpen: invested,
    };
  }, [cfg, bot, account, futuresLevDraft, positions, activeSymbol, trades]);

  /** Realized win/loss sums from CLOSE rows vs allowed margin pool (for capital context). */
  const realizedPnlVsAllowed = useMemo(() => {
    const allowed = Number(capitalAllotmentHeadline.allowedPoolUsdt) || 0;
    const { profitUsdt, lossUsdt, closesWithPnl } = aggregateRealizedPnlBySign(trades);
    const denom = allowed > 0 ? allowed : null;
    return {
      profitUsdt,
      lossUsdt,
      profitPct: denom != null ? (profitUsdt / denom) * 100 : null,
      lossPct: denom != null ? (lossUsdt / denom) * 100 : null,
      closesWithPnl,
      hasAllowed: allowed > 0,
    };
  }, [trades, capitalAllotmentHeadline.allowedPoolUsdt]);

  const capitalFieldCaps = useMemo(() => {
    const pool = Number(capitalAllotmentHeadline.allowedPoolUsdt) || 0;
    const su = Number(capitalAllotmentHeadline.sizedUsableUsdt) || 0;
    const showPool = pool > 0;
    const showSized = su > 0;
    const maxRiskUsdt =
      cfg.riskPerTradeUnit === "USDT"
        ? cfg.perTradeBudgetInputMode === "PCT_OF_USABLE"
          ? 100
          : showSized
            ? Math.min(10_000_000, su)
            : 10_000_000
        : 100;
    const maxDailyUsdt =
      cfg.maxDailyLossUnit === "USDT"
        ? showSized
          ? Math.min(10_000_000, su)
          : 10_000_000
        : 100;
    return { maxRiskUsdt, maxDailyUsdt, pool, showPool, sizedUsableUsdt: su, showSized };
  }, [capitalAllotmentHeadline, cfg.riskPerTradeUnit, cfg.maxDailyLossUnit]);

  const manualFuturesLiqUi = useMemo(() => {
    const mm = String(cfg.marketMode || "AUTO").toUpperCase();
    if (mm === "SPOT" || !showManualOrders) return null;
    if (!marketClose || marketClose <= 0) return null;
    if (manualAmountUsd == null || manualAmountUsd <= 0) return null;
    const sl = manualUseSl ? parseManualPercentField(slPctStr) : null;
    const tp = manualUseTp ? parseManualPercentField(tpPctStr) : null;
    if (manualUseSl && sl == null) return null;
    if (manualUseTp && tp == null) return null;
    if (!manualUseSl && !manualUseTp) {
      // still show lev preview without liq distance
    }
    if (!manualUseSl) {
      return { buy: null, sell: null, lev: futuresLeverageUsedForMarginCap(bot, cfg, futuresLevDraft, { manualTrade: true }) };
    }
    const lev = futuresLeverageUsedForMarginCap(bot, cfg, futuresLevDraft, { manualTrade: true });
    const slFrac = (sl ?? 0) / 100;
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
    manualUseSl,
    manualUseTp,
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

  /** Per-row USDT slice for EQUAL mode: sized usable ÷ N, or theoretical allowed ÷ N when usable is 0 (matches server pool units). */
  const equalSplitSlotUsdt = useMemo(() => {
    if (cfg.multiBudgetSplitMode !== "EQUAL" || capitalMultiSyms.length === 0) return null;
    const n = Math.max(1, capitalMultiSyms.length);
    const cycleAnchor = Number(cfg.capitalCyclePoolAnchorUsdt) || 0;
    if (cycleAnchor > 0) {
      const usePct = cfg.multiTradeUsePctOfUsable === true;
      const pct = clampNum(Number(cfg.multiTradePctOfUsable ?? 100), 0, 100);
      const cycleSized = usePct ? (cycleAnchor * pct) / 100 : cycleAnchor;
      return cycleSized / n;
    }
    const su = Number(capitalAllotmentHeadline.sizedUsableUsdt) || 0;
    const allow = Number(capitalAllotmentHeadline.allowedPoolUsdt) || 0;
    if (su > 0) return su / n;
    if (allow > 0) return allow / n;
    return 0;
  }, [
    cfg.multiBudgetSplitMode,
    capitalMultiSyms,
    capitalAllotmentHeadline.sizedUsableUsdt,
    capitalAllotmentHeadline.allowedPoolUsdt,
    cfg.capitalCyclePoolAnchorUsdt,
    cfg.multiTradeUsePctOfUsable,
    cfg.multiTradePctOfUsable,
  ]);

  const showFuturesMinNotionalGate =
    cfg.riskPerTradeUnit === "USDT" &&
    cfg.maxDailyLossUnit === "USDT" &&
    cfg.universeCoinSelectMode === "MULTIPLE" &&
    (cfg.marketMode === "FUTURES" || cfg.marketMode === "AUTO");

  const capitalAndRankedSymbolsKey = useMemo(
    () =>
      [...capitalMultiSyms].sort().join("|") +
      "§" +
      (Array.isArray(rankedCoins) ? rankedCoins.map((c: any) => String(c?.symbol || "").toUpperCase()).join("|") : ""),
    [capitalMultiSyms, rankedCoins],
  );

  useEffect(() => {
    let alive = true;
    if (!showFuturesMinNotionalGate) {
      setFuturesMinNotionalBySymbol({});
      return () => {
        alive = false;
      };
    }
    const syms = [
      ...new Set([
        ...capitalMultiSyms.map((s) => String(s).toUpperCase()),
        ...(Array.isArray(rankedCoins)
          ? rankedCoins.map((c: any) => String(c?.symbol || "").toUpperCase()).filter(Boolean)
          : []),
      ]),
    ].filter(Boolean);
    if (syms.length === 0) {
      setFuturesMinNotionalBySymbol({});
      return () => {
        alive = false;
      };
    }
    void (async () => {
      const next: Record<string, number> = {};
      const venueQ = cfg.marketMode === "AUTO" ? "BOTH" : "FUTURES";
      await Promise.all(
        syms.map(async (sym) => {
          try {
            const r = await api.symbolConstraints(sym, venueQ);
            const legs = constraintsLegs(r);
            const mn = legs.fut?.min;
            if (Number.isFinite(mn) && mn > 0) next[sym] = mn;
          } catch {
            /* ignore */
          }
        }),
      );
      if (alive) setFuturesMinNotionalBySymbol(next);
    })();
    return () => {
      alive = false;
    };
  }, [showFuturesMinNotionalGate, capitalAndRankedSymbolsKey, cfg.marketMode]);

  const capitalMultiSet = useMemo(() => new Set(capitalMultiSyms.map((s) => String(s).toUpperCase())), [capitalMultiSyms]);

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

  function persistBotSnapshotAfterSave() {
    void import("../lib/tradingUiPersistence")
      .then(({ tradingUiPersistBotSnapshot }) => {
        tradingUiPersistBotSnapshot(
          useAppStore.getState().mode,
          useAppStore.getState().bot as Record<string, unknown>,
          useAppStore.getState().authUiUserTag ?? null,
        );
      })
      .catch(() => {
        /* ignore */
      });
  }

  async function saveCurrentStrategyConfig() {
    try {
      setStrategySaveBusy(true);
      await flushStagedStrategyBotPatch();
      const out = await api.saveStrategyConfigForMode(modeSlug, {
        action: "save",
      });
      const vid = typeof out?.version?.id === "string" ? out.version.id : null;
      if (vid) {
        useAppStore.setState((s) => ({
          activeStrategyVersionByMode: { ...s.activeStrategyVersionByMode, [modeSlug]: vid },
        }));
      }
      if (out?.version) {
        useAppStore.getState().mergeStrategyVersionFromSaveResponse(modeSlug, out.version);
      } else {
        useAppStore.getState().markStrategyConfigCleanForMode(modeSlug);
      }
      clearStagedStrategyBotPatch();
      persistBotSnapshotAfterSave();
      pushLog({ level: "info", msg: "Strategy saved", category: "config", reason: "strategy_save" });
    } catch (e) {
      pushLog({ level: "error", msg: `Failed to save strategy: ${String((e as any)?.message || e)}` });
    } finally {
      setStrategySaveBusy(false);
    }
  }

  async function saveAsNewStrategyFromConfig() {
    const name = window.prompt("New strategy name", "New Strategy");
    if (name == null) return;
    const trimmed = String(name).trim();
    if (!trimmed) return;
    try {
      setStrategySaveBusy(true);
      await flushStagedStrategyBotPatch();
      const out = await api.saveStrategyConfigForMode(modeSlug, {
        action: "save_as_new",
        name: trimmed,
      });
      const vid = typeof out?.version?.id === "string" ? out.version.id : null;
      if (vid) {
        useAppStore.setState((s) => ({
          activeStrategyVersionByMode: { ...s.activeStrategyVersionByMode, [modeSlug]: vid },
        }));
      }
      if (out?.version) {
        useAppStore.getState().mergeStrategyVersionFromSaveResponse(modeSlug, out.version);
      } else {
        useAppStore.getState().markStrategyConfigCleanForMode(modeSlug);
      }
      clearStagedStrategyBotPatch();
      persistBotSnapshotAfterSave();
      pushLog({ level: "info", msg: `Saved as new strategy: ${trimmed}`, category: "config", reason: "strategy_save_as_new" });
    } catch (e) {
      pushLog({ level: "error", msg: `Failed to save as new strategy: ${String((e as any)?.message || e)}` });
    } finally {
      setStrategySaveBusy(false);
    }
  }

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">Trading</div>
          <div className="text-xs text-slate-600 dark:text-slate-400">
            Toggle: operational bot settings vs one-off manual trades. Autotrade <span className="text-slate-600 dark:text-slate-500">signal routing</span>{" "}
            (AUTO/MANUAL + path) lives in the strategy card below and is saved with your strategy version.
          </div>
        </div>
      </div>

      {/*
        ─────────────────────────────────────────────────────────────────
        Strategy / Instance split — what gets saved where
        ─────────────────────────────────────────────────────────────────
        Save routes each field to the right table:
          • SIGNAL BRAIN fields → strategy version (reusable across instances)
          • OPERATIONAL  fields → active instance (per-deployment overrides)
        Same strategy can run on BTC instance and ETH instance simultaneously
        because operational fields (symbol/risk/capital) live on the instance.
      */}
      <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50/70 p-3 text-[11px] leading-relaxed text-slate-700 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300">
        <div className="mb-1 font-semibold text-slate-800 dark:text-slate-200">How saving works</div>
        <div>
          <span className="mr-1 inline-flex items-center rounded bg-sky-500/15 px-1.5 py-[1px] font-mono text-[10px] uppercase tracking-wide text-sky-700 dark:text-sky-300">
            Strategy
          </span>
          Signal brain — routing mode &amp; fixed path (#1–#8), indicator params, AI/ML, MDE filter, signal gates, entry rules, exit/trailing, leverage. Reusable across instances.
        </div>
        <div className="mt-1">
          <span className="mr-1 inline-flex items-center rounded bg-emerald-500/15 px-1.5 py-[1px] font-mono text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
            Instance
          </span>
          Operational deployment — symbol, timeframe, market mode, universe, risk per trade, max daily loss, capital allotment. Owned by the active instance.
        </div>
        <div className="mt-2 border-t border-slate-200 pt-2 text-[10px] text-slate-500 dark:border-slate-700">
          The amber <span className="font-medium text-amber-700 dark:text-amber-300">Save</span> bar appears when{" "}
          <span className="font-medium">signal-brain</span> fields differ from your bound strategy version (mode-level active version, or the active instance&apos;s strategy). Symbol, timeframe, risk, and capital tweaks alone do not show it — those live on the instance and persist when changed.
        </div>
      </div>

      <div className="mb-3 rounded-lg border border-sky-200 bg-sky-50/60 p-3 dark:border-sky-900/45 dark:bg-sky-950/25">
        <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">Signal source</div>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-600 dark:text-slate-400">
          Choose whether the bot <span className="font-medium text-slate-700 dark:text-slate-300">rotates strategies by regime (AUTO)</span> or{" "}
          <span className="font-medium text-slate-700 dark:text-slate-300">always uses one listed strategy (MANUAL)</span>. This is part of your strategy
          brain — use <span className="font-medium">Save</span> if you want it stored on the active strategy version.
        </p>
        <div className="mt-2 grid gap-2 text-xs">
          <label className="grid grid-cols-[108px_1fr] items-center gap-2">
            <span className="text-slate-600 dark:text-slate-400">Mode</span>
            <select
              className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 px-2 py-1 text-slate-900 dark:text-slate-100"
              value={cfg.strategyMode}
              onChange={(e) => {
                const v = e.target.value;
                deferTask(() => {
                  void (async () => {
                    try {
                      await saveGatedBotConfig({ strategyMode: v });
                    } catch {
                      pushLog({ level: "error", msg: "Failed to set routing mode" });
                    }
                  })();
                });
              }}
            >
              <option value="AUTO">AUTO — regime picks among paths #1–#8</option>
              <option value="MANUAL">MANUAL — always use the path below</option>
            </select>
          </label>
          <label className="grid grid-cols-[108px_1fr] items-center gap-2">
            <span className="text-slate-600 dark:text-slate-400">Path (MANUAL)</span>
            {cfg.strategyMode === "AUTO" ? (
              <div className="rounded-md border border-slate-200/90 dark:border-slate-800/80 bg-white/80 dark:bg-slate-950/60 px-2 py-1 text-[11px] text-slate-600 dark:text-slate-500">
                Only used in MANUAL. In AUTO the regime engine picks the path each bar.
              </div>
            ) : (
              <select
                className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 px-2 py-1 text-slate-900 dark:text-slate-100"
                value={cfg.manualStrategy}
                onChange={(e) => {
                  const v = e.target.value;
                  deferTask(() => {
                    void (async () => {
                      try {
                        await saveGatedBotConfig({ manualStrategy: v });
                      } catch {
                        pushLog({ level: "error", msg: "Failed to set fixed signal path" });
                      }
                    })();
                  });
                }}
              >
                {[...NUMBERED_SIGNAL_SOURCES].sort((a, b) => a.n - b.n).map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.n}. {s.key} — {s.label}
                  </option>
                ))}
              </select>
            )}
          </label>
        </div>
        {cfg.strategyMode === "MANUAL" && cfg.manualStrategy === "REGIME_ADAPTIVE" && (
          <div className="mt-2 rounded-lg border border-violet-300 dark:border-violet-700 bg-violet-50 dark:bg-violet-950/30 px-3 py-2 text-[11px] text-violet-900 dark:text-violet-200 space-y-2">
            <div className="font-semibold">★ Regime-Adaptive — one playbook per market regime + institutional risk overlay</div>
            <div className="text-violet-700 dark:text-violet-300">
              Classifies each bar (TREND/RANGE/SQUEEZE/VOLATILE) and runs exactly one playbook. A/B graded, 2–3 trades/day, London/NY only. Best on BTC/ETH 15m.
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <label className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase opacity-70">Min grade</span>
                <select
                  className="rounded border border-violet-300 dark:border-violet-700 bg-white/80 dark:bg-violet-950/40 px-1 py-0.5"
                  value={String(cfg.regimeAdaptiveMinGrade ?? "A")}
                  onChange={(e) => void api.botConfig({ regimeAdaptiveMinGrade: e.currentTarget.value }).catch(() => pushLog("Failed to update min grade"))}
                >
                  <option value="A">A only</option>
                  <option value="B">A or B</option>
                </select>
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase opacity-70">Max trades/day</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  className="rounded border border-violet-300 dark:border-violet-700 bg-white/80 dark:bg-violet-950/40 px-1 py-0.5"
                  value={Number(cfg.regimeAdaptiveMaxTradesPerDay ?? 2)}
                  onChange={(e) => void api.botConfig({ regimeAdaptiveMaxTradesPerDay: Number(e.currentTarget.value) }).catch(() => pushLog("Failed to update max trades/day"))}
                />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase opacity-70">Confidence floor</span>
                <input
                  type="number"
                  step={0.05}
                  min={0}
                  max={1}
                  className="rounded border border-violet-300 dark:border-violet-700 bg-white/80 dark:bg-violet-950/40 px-1 py-0.5"
                  value={Number(cfg.regimeAdaptiveConfidenceFloor ?? 0.45)}
                  onChange={(e) => void api.botConfig({ regimeAdaptiveConfidenceFloor: Number(e.currentTarget.value) }).catch(() => pushLog("Failed to update confidence floor"))}
                />
              </label>
            </div>

            <div className="flex flex-wrap gap-3">
              {([
                ["regimeAdaptiveEnableTrend", "Trend"],
                ["regimeAdaptiveEnableRange", "Range"],
                ["regimeAdaptiveEnableBreakout", "Breakout"],
              ] as const).map(([key, label]) => (
                <label key={key} className="flex cursor-pointer items-center gap-1">
                  <input
                    type="checkbox"
                    checked={cfg[key] !== false}
                    onChange={(e) => void api.botConfig({ [key]: e.currentTarget.checked }).catch(() => pushLog(`Failed to toggle ${label}`))}
                  />
                  <span>{label}</span>
                </label>
              ))}
              <label className="flex cursor-pointer items-center gap-1">
                <input
                  type="checkbox"
                  checked={cfg.volTargetSizing === true}
                  onChange={(e) => void api.botConfig({ volTargetSizing: e.currentTarget.checked }).catch(() => pushLog("Failed to toggle vol-target sizing"))}
                />
                <span>Vol-target sizing</span>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <label className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase opacity-70">Risk scale ×</span>
                <input
                  type="number"
                  step={0.1}
                  min={0.1}
                  max={5}
                  className="rounded border border-violet-300 dark:border-violet-700 bg-white/80 dark:bg-violet-950/40 px-1 py-0.5"
                  value={Number(cfg.riskScale ?? 1)}
                  onChange={(e) => void api.botConfig({ riskScale: Number(e.currentTarget.value) }).catch(() => pushLog("Failed to update risk scale"))}
                />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase opacity-70">Kill-switch DD%</span>
                <input
                  type="number"
                  step={1}
                  min={0}
                  max={100}
                  className="rounded border border-violet-300 dark:border-violet-700 bg-white/80 dark:bg-violet-950/40 px-1 py-0.5"
                  value={Number(cfg.riskKillSwitchDdPct ?? 0)}
                  onChange={(e) => void api.botConfig({ riskKillSwitchDdPct: Number(e.currentTarget.value) }).catch(() => pushLog("Failed to update kill switch"))}
                />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase opacity-70">Consec-loss stop</span>
                <input
                  type="number"
                  step={1}
                  min={0}
                  max={50}
                  className="rounded border border-violet-300 dark:border-violet-700 bg-white/80 dark:bg-violet-950/40 px-1 py-0.5"
                  value={Number(cfg.riskConsecutiveLossLimit ?? 0)}
                  onChange={(e) => void api.botConfig({ riskConsecutiveLossLimit: Number(e.currentTarget.value) }).catch(() => pushLog("Failed to update consec-loss limit"))}
                />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase opacity-70">Weekly DD cap%</span>
                <input
                  type="number"
                  step={1}
                  min={0}
                  max={100}
                  className="rounded border border-violet-300 dark:border-violet-700 bg-white/80 dark:bg-violet-950/40 px-1 py-0.5"
                  value={Number(cfg.riskWeeklyMaxLossPct ?? 0)}
                  onChange={(e) => void api.botConfig({ riskWeeklyMaxLossPct: Number(e.currentTarget.value) }).catch(() => pushLog("Failed to update weekly cap"))}
                />
              </label>
            </div>

            <div className="text-[10px] text-violet-700 dark:text-violet-400">
              Risk scale moves return AND drawdown ~1:1 — raise it for more aggression, lower it to protect capital.
            </div>
          </div>
        )}
        {cfg.strategyMode === "MANUAL" && cfg.manualStrategy === "HTF_RSI" && (
          <div className="mt-2 rounded-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 text-[11px] text-emerald-800 dark:text-emerald-300 space-y-1">
            <div className="font-semibold">★ HTF RSI v3 — BNBUSDT 15m only (HTF trend sep ≥ 0.12%)</div>
            <div className="text-amber-800 dark:text-amber-300">
              Do <b>not</b> use on BTC. Use <b>RISK_AT_SL</b>, SL <b>0.6%</b>, TP <b>1.8%</b>, lev <b>25×</b>.
            </div>
            <div className="text-emerald-700 dark:text-emerald-400">
              v3 Jan–May 2026: <b>50% WR</b> · Risk 5% → ~125% · Risk 6% → ~157% · Risk 7% → ~191%
            </div>
            <div className="flex flex-wrap gap-2 pt-0.5">
              <button
                type="button"
                className="rounded border border-emerald-400 dark:border-emerald-600 bg-white/80 dark:bg-emerald-950/50 px-2 py-0.5 text-[10px] font-semibold hover:bg-emerald-100 dark:hover:bg-emerald-900/50"
                onClick={() => {
                  void api
                    .botConfig({
                      trailingStopLossAuto: false,
                      futuresLeverage: 25,
                      riskPerTrade: 5,
                      riskPerTradeUnit: "PCT_EQUITY",
                      supertrendFuturesFixedSlPct: 0.006,
                      supertrendFuturesFixedTpPct: 0.018,
                    })
                    .catch(() => pushLog("Failed to apply HTF RSI v3 balanced preset"));
                }}
              >
                Apply balanced v3 (~125%, 50% WR)
              </button>
              <button
                type="button"
                className="rounded border-2 border-emerald-500 dark:border-emerald-400 bg-emerald-100/90 dark:bg-emerald-900/60 px-2 py-0.5 text-[10px] font-semibold hover:bg-emerald-200 dark:hover:bg-emerald-800/60"
                onClick={() => {
                  void api
                    .botConfig({
                      trailingStopLossAuto: false,
                      futuresLeverage: 25,
                      riskPerTrade: 6,
                      riskPerTradeUnit: "PCT_EQUITY",
                      supertrendFuturesFixedSlPct: 0.006,
                      supertrendFuturesFixedTpPct: 0.018,
                    })
                    .catch(() => pushLog("Failed to apply HTF RSI v3 max preset"));
                }}
              >
                Apply max v3 (~157%, 50% WR) ★
              </button>
              <button
                type="button"
                className="rounded border border-emerald-400 dark:border-emerald-600 bg-white/80 dark:bg-emerald-950/50 px-2 py-0.5 text-[10px] font-semibold hover:bg-emerald-100 dark:hover:bg-emerald-900/50"
                onClick={() => {
                  void api
                    .botConfig({
                      trailingStopLossAuto: false,
                      futuresLeverage: 25,
                      riskPerTrade: 7,
                      riskPerTradeUnit: "PCT_EQUITY",
                      supertrendFuturesFixedSlPct: 0.006,
                      supertrendFuturesFixedTpPct: 0.018,
                    })
                    .catch(() => pushLog("Failed to apply HTF RSI v3 aggressive preset"));
                }}
              >
                Apply aggressive v3 (~191%, 50% WR)
              </button>
            </div>
          </div>
        )}
        <div className="mt-2 rounded-lg border border-violet-400 dark:border-violet-600 bg-violet-50 dark:bg-violet-950/30 px-3 py-2 text-[11px] text-violet-900 dark:text-violet-200 space-y-1.5">
          <div className="font-semibold">Supertrend Elite — validated presets (1H only)</div>
          {cfg.strategyMode !== "MANUAL" || cfg.manualStrategy !== "SUPERTREND_ELITE" ? (
            <p className="text-amber-800 dark:text-amber-300">
              Presets set <b>MANUAL</b> + <b>SUPERTREND_ELITE</b>, turn off Supertrend auto-trade, enable 4H+1H gates + ST trailing.
              Current: <span className="font-mono">{cfg.strategyMode}</span>
              {cfg.strategyMode === "MANUAL" ? ` / ${cfg.manualStrategy}` : ""}.
            </p>
          ) : (
            <p>
              <b>★ Use 1H chart.</b> 15m is not profitable for this path. Use{" "}
              <b>Elite Auto</b> for any coin — thresholds scale from each symbol&apos;s volatility.
              Legacy FIXED presets are per-coin manual tuning only.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <TrendHtfStPresetButton
              label="★ Elite Auto 1H (any coin)"
              highlight
              patch={SUPERTREND_ELITE_AUTO_1H}
              pushLog={pushLog}
            />
            <TrendHtfStPresetButton
              label="ADX sep only"
              patch={SUPERTREND_ELITE_ADX_1H}
              pushLog={pushLog}
            />
            <TrendHtfStPresetButton
              label="Percentile sep"
              patch={SUPERTREND_ELITE_PERCENTILE_1H}
              pushLog={pushLog}
            />
            <TrendHtfStPresetButton
              label="ATR sep"
              patch={SUPERTREND_ELITE_ATR_1H}
              pushLog={pushLog}
            />
            <TrendHtfStPresetButton
              label="Calibrated sep"
              patch={SUPERTREND_ELITE_CALIBRATED_1H}
              pushLog={pushLog}
            />
            <TrendHtfStPresetButton
              label="BNB 1H FIXED"
              patch={SUPERTREND_ELITE_BNB_1H}
              pushLog={pushLog}
            />
            <TrendHtfStPresetButton
              label="BTC 1H FIXED (0.08%)"
              patch={SUPERTREND_ELITE_BTC_1H}
              pushLog={pushLog}
            />
            <TrendHtfStPresetButton
              label="BTC 1H + ADX20"
              patch={SUPERTREND_ELITE_BTC_1H_ADX}
              pushLog={pushLog}
            />
            <TrendHtfStPresetButton
              label="LINK 1H Auto"
              patch={SUPERTREND_ELITE_LINK_1H}
              pushLog={pushLog}
            />
          </div>
          {cfg.supertrendFuturesAuto === true && cfg.manualStrategy === "SUPERTREND_ELITE" ? (
            <p className="text-[10px] text-amber-800 dark:text-amber-300">
              Turn off <b>Futures Supertrend auto</b> — otherwise engine stays on plain SUPERTREND, not Elite gates.
            </p>
          ) : null}
        </div>
        <div className="mt-2 rounded-lg border border-cyan-500/60 bg-cyan-50 dark:bg-cyan-950/30 px-3 py-2 text-[11px] text-cyan-900 dark:text-cyan-200 space-y-1.5">
          <div className="font-semibold">Unified Elite — regime-gated Elite + liq scale-up + RANGE supplement</div>
          {cfg.strategyMode !== "MANUAL" || cfg.manualStrategy !== "UNIFIED_ELITE" ? (
            <p className="text-amber-800 dark:text-amber-300">
              Presets set <b>MANUAL</b> + <b>UNIFIED_ELITE</b>. Current:{" "}
              <span className="font-mono">{cfg.strategyMode}</span>
              {cfg.strategyMode === "MANUAL" ? ` / ${cfg.manualStrategy}` : ""}.
            </p>
          ) : (
            <p>
              <b>★ Use 1H chart.</b> Elite 5-gate signal + regime gate (skip VOLATILE/SQUEEZE) + 1.5× size on PDH/PDL
              sweeps + LIQ/SR A+ trades in RANGE. Run on BTC/ETH/BNB/LINK/XRP for ~7–10 trades/month portfolio.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <TrendHtfStPresetButton
              label="★ Any coin — Unified ADX sep"
              highlight
              patch={UNIFIED_ELITE_ADX_1H}
              pushLog={pushLog}
            />
            <TrendHtfStPresetButton
              label="BNB 1H Unified"
              patch={UNIFIED_ELITE_BNB_1H}
              pushLog={pushLog}
            />
            <TrendHtfStPresetButton
              label="BTC 1H Unified"
              patch={UNIFIED_ELITE_BTC_1H}
              pushLog={pushLog}
            />
          </div>
        </div>
        <div className="mt-2 rounded-lg border border-emerald-500/60 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 text-[11px] text-emerald-900 dark:text-emerald-200 space-y-1.5">
          <div className="font-semibold">Safe Intraday — conservative 15m (~1%/month target)</div>
          <p>
            <b>Not 1%/day.</b> Uses Elite 5-gate signals + London/NY session + max 2 trades/day + 1% risk, 10× lev,
            daily/weekly loss caps. Run on <b>15m</b> across BTC/ETH/BNB/LINK/XRP. See{" "}
            <span className="font-mono">docs/SAFE_INTRADAY_SETUP.md</span>.
          </p>
          <div className="flex flex-wrap gap-2">
            <TrendHtfStPresetButton
              label="★ Safe Intraday 15m"
              highlight
              patch={SAFE_INTRADAY_BNB_15M}
              pushLog={pushLog}
            />
          </div>
        </div>
        <div className="mt-2 rounded-lg border border-teal-400 dark:border-teal-600 bg-teal-50 dark:bg-teal-950/30 px-3 py-2 text-[11px] text-teal-900 dark:text-teal-200 space-y-1.5">
          <div className="font-semibold">Intraday Pro — loss vetoes + big-move tier</div>
          {cfg.strategyMode !== "MANUAL" ||
          (cfg.manualStrategy !== "SR_INTRADAY" && cfg.manualStrategy !== "SITUATION_INTRADAY") ? (
            <p className="text-amber-800 dark:text-amber-300">
              Presets set <b>MANUAL</b> + <b>SR_INTRADAY</b>. Each setup is scored (sweep, session S/R, Fib, VP,
              CVD); <b>learned rules block loss clusters</b> one-by-one. Tier-A = big-move trail. Use{" "}
              <b>15m</b>. Autopsy: <span className="font-mono">npm run backtest:intraday-autopsy</span>
            </p>
          ) : (
            <p>
              <b>★ BNB 15m Pro</b> — fixed TP + veto stack. <b>BNB 15m VP</b> — HVN/LVN structure gates + SL/TP at
              nodes. <b>BNB 15m Big Move</b> — tier-A only + ST trail.
              Run autopsy to see which losses each rule blocks.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <TrendHtfStPresetButton label="★ BNB 15m Pro" highlight patch={INTRADAY_PRO_15M} pushLog={pushLog} />
            <TrendHtfStPresetButton label="BNB 15m Fib" patch={INTRADAY_PRO_FIB_15M} pushLog={pushLog} />
            <TrendHtfStPresetButton label="BNB 15m Inst. A+" patch={INTRADAY_PRO_SR_APLUS_15M} pushLog={pushLog} />
            <TrendHtfStPresetButton label="BNB 15m LIQ Daily" patch={INTRADAY_PRO_LIQ_DAILY_15M} pushLog={pushLog} />
            <TrendHtfStPresetButton
              label="BNB 15m CRT + TBS"
              highlight
              patch={CRT_TBS_BNB_15M}
              pushLog={pushLog}
            />
            <TrendHtfStPresetButton
              label="BNB 15m Tokyo Session"
              highlight
              patch={TOKYO_SESSION_BNB_15M}
              pushLog={pushLog}
            />
            <TrendHtfStPresetButton
              label="BNB 15m Situation Router"
              highlight
              patch={BNB_SITUATION_ROUTER_15M}
              pushLog={pushLog}
            />
            <TrendHtfStPresetButton label="BNB 15m SMC Sweep" patch={INTRADAY_PRO_ICT_15M} pushLog={pushLog} />
            <TrendHtfStPresetButton
              label="BNB 15m SMC Research (frozen)"
              patch={INTRADAY_PRO_ICT_RESEARCH_15M}
              pushLog={pushLog}
            />
            <TrendHtfStPresetButton label="BNB 1H SMC Research (frozen)" patch={INTRADAY_PRO_ICT_RESEARCH_1H} pushLog={pushLog} />
            <TrendHtfStPresetButton label="BNB 15m SMC ICT Full" patch={INTRADAY_PRO_ICT_FULL_15M} pushLog={pushLog} />
            <TrendHtfStPresetButton label="BNB 15m Big Move" patch={INTRADAY_PRO_BIGMOVE_15M} pushLog={pushLog} />
            <TrendHtfStPresetButton label="BNB 5m" patch={INTRADAY_PRO_5M} pushLog={pushLog} />
            <TrendHtfStPresetButton label="BTC 15m" patch={SR_INTRADAY_BTC_15M} pushLog={pushLog} />
          </div>
          <p className="text-[10px] text-teal-800/90 dark:text-teal-200/80">
            Per-technique on/off toggles live in <b>Indicators</b> → <b>Intraday gates (8 techniques)</b> (first block in that section).
          </p>
        </div>
        {cfg.strategyMode === "MANUAL" && cfg.manualStrategy === "VOLUME_PROFILE" && (
          <div className="mt-2 rounded-lg border border-fuchsia-300 dark:border-fuchsia-700 bg-fuchsia-50 dark:bg-fuchsia-950/30 px-3 py-2 text-[11px] text-fuchsia-900 dark:text-fuchsia-200 space-y-1.5">
            <div className="font-semibold">Volume Profile strategy — BNB 15m recommended</div>
            <p>
              Standalone VP path: entries only on POC bounce, LVN vacuum, VAH breakout, HVN flip, or VA rejection.
              Backtest: <span className="font-mono">npm run backtest:volume-profile</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <TrendHtfStPresetButton label="★ BNB 15m VP (optimized)" highlight patch={VOLUME_PROFILE_15M} pushLog={pushLog} />
              <TrendHtfStPresetButton label="BNB Tier-A (same)" patch={VOLUME_PROFILE_TIER_A_15M} pushLog={pushLog} />
              <TrendHtfStPresetButton label="BNB balanced (~80% WR)" patch={VOLUME_PROFILE_BALANCED_15M} pushLog={pushLog} />
              <TrendHtfStPresetButton label="BTC 15m VP" patch={VOLUME_PROFILE_BTC_15M} pushLog={pushLog} />
              <TrendHtfStPresetButton label="BNB 5m VP" patch={VOLUME_PROFILE_5M} pushLog={pushLog} />
            </div>
          </div>
        )}
        <div className="mt-2 rounded-lg border border-sky-300 dark:border-sky-700 bg-sky-50 dark:bg-sky-950/30 px-3 py-2 text-[11px] text-sky-900 dark:text-sky-200 space-y-1.5">
          <div className="font-semibold">Trend + HTF Supertrend — research presets (15m)</div>
          {cfg.strategyMode !== "MANUAL" || cfg.manualStrategy !== "TREND_HTF_ST" ? (
            <p className="text-amber-800 dark:text-amber-300">
              Presets set <b>MANUAL</b> + <b>TREND_HTF_ST</b> (not raw SUPERTREND). Current:{" "}
              <span className="font-mono">{cfg.strategyMode}</span>
              {cfg.strategyMode === "MANUAL" ? ` / ${cfg.manualStrategy}` : ""}.
              {cfg.supertrendFuturesAuto === true ? (
                <span className="block mt-1">
                  Turn off <b>supertrendFuturesAuto</b> or use a preset — otherwise backtests may run the wrong engine.
                </span>
              ) : null}
            </p>
          ) : (
            <p>
              <b>★ Optimal BNB</b>: ~61% WR / ~840% Jan (best tested). <b>BTC</b>: use surgical preset (~42% WR Jan).
              Intel gate OFF for returns. Save strategy before backtest.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <TrendHtfStPresetButton
              label="★ BNB Optimal 10%"
              highlight
              patch={TREND_HTF_ST_OPTIMAL_BNB}
              pushLog={pushLog}
            />
            <TrendHtfStPresetButton
              label="BTC Optimal 10%"
              patch={TREND_HTF_ST_OPTIMAL_BTC}
              pushLog={pushLog}
            />
            <TrendHtfStPresetButton
              label="BNB High-WR 50%"
              patch={TREND_HTF_ST_BNB_HIGH_WR}
              pushLog={pushLog}
            />
            <TrendHtfStPresetButton
              label="BNB max return 10%"
              patch={TREND_HTF_ST_BNB_MAX_RETURN}
              pushLog={pushLog}
            />
            <TrendHtfStPresetButton
              label="BNB surgical 10%"
              patch={TREND_HTF_ST_BNB_SURGICAL}
              pushLog={pushLog}
            />
          </div>
          <p className="text-[10px] text-amber-800 dark:text-amber-300">
            80%+ WR on BTC 15m was not found in exhaustive sweeps — use BNB Optimal. Avoid intel gate + 50×/40% risk on BTC (last run -98%).
          </p>
        </div>
        {cfg.strategyMode === "MANUAL" && cfg.manualStrategy === "APEX_TREND" && (
          <div className="mt-2 rounded-lg border border-emerald-400 dark:border-emerald-500 bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/40 dark:to-teal-950/30 px-3 py-2 text-[11px] text-emerald-900 dark:text-emerald-200 space-y-1.5">
            <div className="font-bold text-[12px] text-amber-800 dark:text-amber-300">APEX v2 — experimental (use HTF RSI ★ on BNB instead)</div>
            <div className="text-slate-700 dark:text-slate-300">
              Last BTC run failed: v1 entered at RSI 67 (not a pullback). v2 fixes RSI zone 40–52. Too few trades on BTC.
            </div>
            <div className="text-emerald-700 dark:text-emerald-400">
              <b>Best validated:</b> BNB 15m + HTF RSI v3 (~191%, 50% WR) or Trend+ST max (~428% Jan–May, ~61% WR @ 7% risk).
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                className="rounded border-2 border-emerald-500 bg-emerald-100 dark:bg-emerald-900/60 px-2 py-0.5 text-[10px] font-bold hover:bg-emerald-200 dark:hover:bg-emerald-800/60"
                onClick={() => {
                  void saveGatedBotConfig({
                    manualStrategy: "APEX_TREND",
                    symbol: "BNBUSDT",
                    timeframe: "15m",
                    trailingStopLossAuto: false,
                    futuresLeverage: 25,
                    riskPerTrade: 5,
                    riskPerTradeUnit: "PCT_EQUITY",
                    supertrendFuturesFixedSlPct: 0.006,
                    supertrendFuturesFixedTpPct: 0.018,
                  }).catch(() => pushLog("Failed to apply APEX 15m balanced"));
                }}
              >
                Apply 15m balanced (SL 0.6 / TP 1.8)
              </button>
              <button
                type="button"
                className="rounded border-2 border-emerald-500 bg-emerald-100 dark:bg-emerald-900/60 px-2 py-0.5 text-[10px] font-bold hover:bg-emerald-200 dark:hover:bg-emerald-800/60"
                onClick={() => {
                  void saveGatedBotConfig({
                    manualStrategy: "APEX_TREND",
                    trailingStopLossAuto: false,
                    futuresLeverage: 25,
                    riskPerTrade: 7,
                    riskPerTradeUnit: "PCT_EQUITY",
                    supertrendPeriod: 7,
                    supertrendMultiplier: 2.5,
                    supertrendFuturesFixedSlPct: 0.007,
                    supertrendFuturesFixedTpPct: 0.021,
                  }).catch(() => pushLog("Failed to apply APEX 15m max"));
                }}
              >
                Apply 15m max (SL 0.7 / TP 2.1) ★
              </button>
              <button
                type="button"
                className="rounded border border-teal-500 dark:border-teal-400 bg-white/80 dark:bg-teal-950/40 px-2 py-0.5 text-[10px] font-semibold hover:bg-teal-50 dark:hover:bg-teal-900/40"
                onClick={() => {
                  void saveGatedBotConfig({
                    manualStrategy: "APEX_TREND",
                    timeframe: "1h",
                    trailingStopLossAuto: false,
                    futuresLeverage: 15,
                    riskPerTrade: 5,
                    riskPerTradeUnit: "PCT_EQUITY",
                    supertrendPeriod: 7,
                    supertrendMultiplier: 2.5,
                    supertrendFuturesFixedSlPct: 0.012,
                    supertrendFuturesFixedTpPct: 0.036,
                  }).catch(() => pushLog("Failed to apply APEX 1h swing"));
                }}
              >
                Apply 1h swing (SL 1.2 / TP 3.6 — big moves)
              </button>
            </div>
          </div>
        )}
        {cfg.strategyMode === "MANUAL" && cfg.manualStrategy === "BTC_CONSENSUS" && (
          <div className="mt-2 rounded-lg border border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-950/30 px-3 py-2 text-[11px] text-orange-900 dark:text-orange-200 space-y-1">
            <div className="font-semibold">★ BTC Consensus — BTCUSDT 1h (2 of 3 trend signals)</div>
            <div>Vote: Trend+ST + Leg Rider + Momentum. Do not use HTF RSI on BTC.</div>
            <div className="flex flex-wrap gap-2 pt-0.5">
              <button
                type="button"
                className="rounded border border-orange-400 px-2 py-0.5 text-[10px] font-semibold hover:bg-orange-100 dark:hover:bg-orange-900/50"
                onClick={() => {
                  void api
                    .botConfig({
                      manualStrategy: "BTC_CONSENSUS",
                      symbol: "BTCUSDT",
                      timeframe: "1h",
                      trailingStopLossAuto: false,
                      futuresLeverage: 20,
                      riskPerTrade: 5,
                      riskPerTradeUnit: "PCT_EQUITY",
                      supertrendFuturesFixedSlPct: 0.01,
                      supertrendFuturesFixedTpPct: 0.03,
                    })
                    .catch(() => pushLog("Failed to apply BTC Consensus 1h preset"));
                }}
              >
                Apply BTC 1h consensus
              </button>
              <button
                type="button"
                className="rounded border border-orange-400 px-2 py-0.5 text-[10px] font-semibold hover:bg-orange-100 dark:hover:bg-orange-900/50"
                onClick={() => {
                  void api
                    .botConfig({
                      manualStrategy: "BTC_CONSENSUS",
                      symbol: "BTCUSDT",
                      timeframe: "15m",
                      trailingStopLossAuto: false,
                      futuresLeverage: 20,
                      riskPerTrade: 5,
                      supertrendFuturesFixedSlPct: 0.008,
                      supertrendFuturesFixedTpPct: 0.024,
                    })
                    .catch(() => pushLog("Failed to apply BTC Consensus 15m preset"));
                }}
              >
                Apply BTC 15m consensus
              </button>
            </div>
          </div>
        )}
        {cfg.strategyMode === "MANUAL" && cfg.manualStrategy === "HTF_LEG_RIDER" && (
          <div className="mt-2 rounded-lg border border-violet-300 dark:border-violet-700 bg-violet-50 dark:bg-violet-950/30 px-3 py-2 text-[11px] text-violet-900 dark:text-violet-200 space-y-1">
            <div className="font-semibold">HTF Leg Rider — breakout in trend direction</div>
            <div>32-bar breakout · SL 1.5% · TP 5% → ~62% return on BNB (lower WR than HTF RSI).</div>
            <button
              type="button"
              className="rounded border border-violet-400 px-2 py-0.5 text-[10px] font-semibold"
              onClick={() => {
                void api
                  .botConfig({
                    manualStrategy: "HTF_LEG_RIDER",
                    trailingStopLossAuto: false,
                    futuresLeverage: 25,
                    riskPerTrade: 5,
                    supertrendFuturesFixedSlPct: 0.015,
                    supertrendFuturesFixedTpPct: 0.05,
                  })
                  .catch(() => pushLog("Failed to apply Leg Rider preset"));
              }}
            >
              Apply Leg Rider preset
            </button>
          </div>
        )}
        {cfg.strategyMode === "MANUAL" ? (
          <div className="mt-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-950/40">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 px-3 py-2">
              <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">Path scoreboard (last ~700 bars)</div>
              <div className="text-[11px] text-slate-600 dark:text-slate-500">{btLoading ? "running…" : "refresh 30s"}</div>
            </div>
            <div className="max-h-[180px] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-50 dark:bg-slate-950">
                  <tr className="text-left text-slate-600 dark:text-slate-400">
                    <th className="px-3 py-2">#</th>
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
                      <td className="px-3 py-3 text-slate-600 dark:text-slate-500" colSpan={6}>
                        No scoreboard rows yet
                      </td>
                    </tr>
                  ) : (
                    top.map((r) => {
                      const num = NUMBERED_SIGNAL_SOURCES.find((x) => x.key === r.key)?.n ?? "—";
                      return (
                        <tr key={r.key} className="border-t border-slate-200 dark:border-slate-900">
                          <td className="px-3 py-2 font-mono text-slate-500">{num}</td>
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              className="font-semibold text-slate-800 dark:text-slate-200 hover:text-emerald-300"
                              onClick={() => {
                                const key = r.key;
                                deferTask(() => {
                                  void (async () => {
                                    try {
                                      await saveGatedBotConfig({ manualStrategy: key });
                                    } catch {
                                      pushLog({ level: "error", msg: "Failed to set fixed signal path" });
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
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>

      {strategyConfigDirty ? (
        <div className="sticky top-0 z-20 mb-3 rounded-lg border border-amber-400/50 bg-amber-500/15 p-3 text-xs shadow-sm backdrop-blur-sm dark:bg-amber-950/40">
          <div className="font-semibold text-amber-300">Configuration changed</div>
          <div className="mt-1 text-slate-600 dark:text-slate-300">
            Save updates the current strategy version in place (same version row) and mirrors operational fields to the active instance. Save as New creates a separate strategy and points the instance at its first version.
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={strategySaveBusy}
              onClick={() => void saveCurrentStrategyConfig()}
              className="rounded-md border border-sky-500/60 px-2.5 py-1 font-semibold text-sky-300 disabled:opacity-60"
            >
              {strategySaveBusy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              disabled={strategySaveBusy}
              onClick={() => void saveAsNewStrategyFromConfig()}
              className="rounded-md border border-emerald-500/60 px-2.5 py-1 font-semibold text-emerald-300 disabled:opacity-60"
            >
              {strategySaveBusy ? "Saving…" : "Save as New"}
            </button>
          </div>
        </div>
      ) : null}

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
        <p className="mt-1 text-[11px] text-slate-600 dark:text-slate-500">
          <span className="font-medium text-slate-700 dark:text-slate-400">AUTO / MANUAL and the fixed path</span> are set in the{" "}
          <span className="font-medium">Signal source</span> card above (part of the strategy brain — Save to persist).
        </p>
        <div className="mt-2 grid gap-2 text-xs">
            <label className="grid grid-cols-[110px_1fr] items-center gap-2">
              <span className="text-slate-600 dark:text-slate-400">Timeframe</span>
              <select
                className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-slate-900 dark:text-slate-100"
                value={cfg.timeframe}
                title="Bar interval for the bot chart and Supertrend signals (Binance klines)."
                onChange={(e) => {
                  const v = e.target.value;
                  deferTask(() => {
                    void (async () => {
                      try {
                        await saveGatedBotConfig({ timeframe: v });
                        await syncActiveInstanceOperational({ timeframe: v });
                        pushLog({ level: "info", msg: "Trading timeframe set", timeframe: v });
                      } catch {
                        pushLog({ level: "error", msg: "Failed to set timeframe" });
                      }
                    })();
                  });
                }}
              >
                {BOT_TRADING_TIMEFRAMES.map((tf) => (
                  <option key={tf} value={tf}>
                    {tf}
                  </option>
                ))}
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
                        await saveGatedBotConfig({ universeCoinSelectMode: v, symbolMode: "AUTO" });
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
                        await saveGatedBotConfig({ marketMode: mode });
                        await syncActiveInstanceOperational({ marketMode: mode });
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

            {false && cfg.marketMode === "FUTURES" && (
              <>
              <div className="space-y-2 rounded-lg border border-emerald-900/45 bg-emerald-950/20 p-2">
                <div className="text-[11px] font-semibold text-emerald-200/95">Trade history fees (USD‑M · modeled)</div>
                <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-400">
                  Custom maker vs taker fee rates as <span className="text-slate-700 dark:text-slate-300">percent of notional</span>{" "}
                  (e.g. 0.05 = 0.05%). Used for Portfolio <span className="font-medium text-slate-700 dark:text-slate-300">trade history</span>{" "}
                  when the exchange did not attach commission on a row; fills from Binance still override when present. Liquidity class comes from{" "}
                  fill data when available, else order type / stop vs limit heuristics (defaults to taker).
                </p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="rounded-md border border-emerald-800/40 bg-white/40 px-2 py-1.5 dark:bg-slate-950/40">
                    <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-emerald-800/80 dark:text-emerald-300/70">
                      Maker (limit adds liquidity)
                    </div>
                    <div className="grid grid-cols-[108px_1fr] items-center gap-2 text-xs">
                      <span className="text-slate-600 dark:text-slate-400">Entry %</span>
                      <NumericTextInput
                        value={+(cfg.tradeHistoryMakerOpenFeeRate * 100).toFixed(4)}
                        inputMode="decimal"
                        min={0}
                        max={1}
                        parse={(raw) => parseFloat(raw)}
                        onCommit={async (v) => {
                          try {
                            await saveGatedBotConfig({ tradeHistoryMakerOpenFeeRate: clampNum(v / 100, 0, 0.01) });
                          } catch {
                            pushLog({ level: "error", msg: "Failed to set maker entry fee %" });
                          }
                        }}
                      />
                    </div>
                    <div className="mt-1 grid grid-cols-[108px_1fr] items-center gap-2 text-xs">
                      <span className="text-slate-600 dark:text-slate-400">Exit %</span>
                      <NumericTextInput
                        value={+(cfg.tradeHistoryMakerCloseFeeRate * 100).toFixed(4)}
                        inputMode="decimal"
                        min={0}
                        max={1}
                        parse={(raw) => parseFloat(raw)}
                        onCommit={async (v) => {
                          try {
                            await saveGatedBotConfig({ tradeHistoryMakerCloseFeeRate: clampNum(v / 100, 0, 0.01) });
                          } catch {
                            pushLog({ level: "error", msg: "Failed to set maker exit fee %" });
                          }
                        }}
                      />
                    </div>
                  </div>
                  <div className="rounded-md border border-emerald-800/40 bg-white/40 px-2 py-1.5 dark:bg-slate-950/40">
                    <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-emerald-800/80 dark:text-emerald-300/70">
                      Taker (market / takes liquidity)
                    </div>
                    <div className="grid grid-cols-[108px_1fr] items-center gap-2 text-xs">
                      <span className="text-slate-600 dark:text-slate-400">Entry %</span>
                      <NumericTextInput
                        value={+(cfg.tradeHistoryTakerOpenFeeRate * 100).toFixed(4)}
                        inputMode="decimal"
                        min={0}
                        max={1}
                        parse={(raw) => parseFloat(raw)}
                        onCommit={async (v) => {
                          try {
                            await saveGatedBotConfig({ tradeHistoryTakerOpenFeeRate: clampNum(v / 100, 0, 0.01) });
                          } catch {
                            pushLog({ level: "error", msg: "Failed to set taker entry fee %" });
                          }
                        }}
                      />
                    </div>
                    <div className="mt-1 grid grid-cols-[108px_1fr] items-center gap-2 text-xs">
                      <span className="text-slate-600 dark:text-slate-400">Exit %</span>
                      <NumericTextInput
                        value={+(cfg.tradeHistoryTakerCloseFeeRate * 100).toFixed(4)}
                        inputMode="decimal"
                        min={0}
                        max={1}
                        parse={(raw) => parseFloat(raw)}
                        onCommit={async (v) => {
                          try {
                            await saveGatedBotConfig({ tradeHistoryTakerCloseFeeRate: clampNum(v / 100, 0, 0.01) });
                          } catch {
                            pushLog({ level: "error", msg: "Failed to set taker exit fee %" });
                          }
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>
              <div className="space-y-2 rounded-lg border border-sky-800/50 bg-sky-950/25 p-2">
                <div className="text-[11px] font-semibold text-sky-200/95">Futures entry (Supertrend signal → order)</div>
                <p className="text-[10px] leading-snug text-slate-500 dark:text-slate-400">
                  Flow: bar-close signal uses the candle <span className="text-slate-600 dark:text-slate-300">close</span> as the
                  reference price → server fetches <span className="text-slate-600 dark:text-slate-300">live bid/ask, mark, mid</span> →
                  if any price is worse than your max slippage vs that close, the open is <span className="text-slate-600 dark:text-slate-300">skipped</span>{" "}
                  (better than a bad MARKET fill). With <span className="text-slate-600 dark:text-slate-300">AUTO</span> open style and slippage
                  &gt; 0, the first attempt is typically <span className="text-slate-600 dark:text-slate-300">LIMIT IOC</span> at close × (1±slippage).
                  Activity logs fill vs signal as bps. Values below are saved with bot config (server{" "}
                  <code className="text-slate-600 dark:text-slate-400">bot-trading-config.json</code>).
                </p>
                <div className="grid grid-cols-[118px_1fr] items-center gap-2 text-xs">
                  <span className="text-slate-600 dark:text-slate-400" title="Percent points vs signal candle close (0 = disable guard).">
                    Max slippage %
                  </span>
                  <NumericTextInput
                    value={Number(cfg.supertrendFuturesMaxEntrySlippagePct.toFixed(4))}
                    inputMode="decimal"
                    min={0}
                    max={5}
                    parse={(raw) => parseFloat(raw)}
                    onCommit={async (v) => {
                      try {
                        await saveGatedBotConfig({ supertrendFuturesMaxEntrySlippagePct: clampNum(v, 0, 5) });
                      } catch {
                        pushLog({ level: "error", msg: "Failed to set max entry slippage" });
                      }
                    }}
                  />
                </div>
                <label className="grid grid-cols-[118px_1fr] items-center gap-2 text-xs">
                  <span className="text-slate-600 dark:text-slate-400">Open style</span>
                  <select
                    className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-slate-900 dark:text-slate-100"
                    value={cfg.supertrendFuturesEntryOpenStyle}
                    onChange={(e) => {
                      const v = e.target.value as "AUTO" | "MARKET" | "LIMIT_IOC";
                      deferTask(() => {
                        void (async () => {
                          try {
                            await saveGatedBotConfig({ supertrendFuturesEntryOpenStyle: v });
                            pushLog({ level: "info", msg: `Futures entry open style: ${v}` });
                          } catch {
                            pushLog({ level: "error", msg: "Failed to set open style" });
                          }
                        })();
                      });
                    }}
                  >
                    <option value="AUTO">AUTO (LIMIT IOC if slippage &gt; 0)</option>
                    <option value="LIMIT_IOC">LIMIT IOC</option>
                    <option value="MARKET">MARKET</option>
                  </select>
                </label>
                <div className="grid grid-cols-[118px_1fr] items-center gap-2 text-xs">
                  <span className="text-slate-600 dark:text-slate-400" title="Wait, then re-fetch book/mark before placing.">
                    Recheck ms
                  </span>
                  <NumericTextInput
                    value={cfg.supertrendFuturesEntryRecheckMs}
                    inputMode="numeric"
                    min={0}
                    max={60000}
                    parse={(raw) => parseInt(raw, 10)}
                    onCommit={async (v) => {
                      try {
                        await saveGatedBotConfig({ supertrendFuturesEntryRecheckMs: Math.max(0, Math.min(60000, Math.floor(v))) });
                      } catch {
                        pushLog({ level: "error", msg: "Failed to set entry recheck ms" });
                      }
                    }}
                  />
                </div>
                <div className="grid grid-cols-[118px_1fr] items-center gap-2 text-xs">
                  <span className="text-slate-600 dark:text-slate-400" title="Skip if bar-close to order is too slow (AI/network).">
                    Max signal lag ms
                  </span>
                  <NumericTextInput
                    value={cfg.supertrendFuturesMaxSignalLagMs}
                    inputMode="numeric"
                    min={0}
                    max={3600000}
                    parse={(raw) => parseInt(raw, 10)}
                    onCommit={async (v) => {
                      try {
                        await saveGatedBotConfig({ supertrendFuturesMaxSignalLagMs: Math.max(0, Math.floor(v)) });
                      } catch {
                        pushLog({ level: "error", msg: "Failed to set max signal lag" });
                      }
                    }}
                  />
                </div>
                <label className="flex cursor-pointer items-start gap-2 text-[11px]">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={cfg.supertrendFuturesIocFallbackMarket}
                    onChange={(e) => {
                      const on = e.currentTarget.checked;
                      deferTask(() => {
                        void (async () => {
                          try {
                            await saveGatedBotConfig({ supertrendFuturesIocFallbackMarket: on });
                            pushLog({
                              level: "info",
                              msg: on
                                ? "IOC no-fill → may retry MARKET if still within slippage cap"
                                : "IOC no-fill → no MARKET fallback",
                            });
                          } catch {
                            pushLog({ level: "error", msg: "Failed to update IOC fallback" });
                          }
                        })();
                      });
                    }}
                  />
                  <span>
                    <span className="font-medium text-slate-700 dark:text-slate-200">IOC → MARKET fallback</span>
                    <span className="mt-0.5 block text-[10px] text-slate-500 dark:text-slate-400">
                      If LIMIT IOC does not fill, re-quote once; place MARKET only if still inside the slippage band (off = safer).
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2 text-[11px]">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={cfg.supertrendFuturesRequireMarkPrice}
                    onChange={(e) => {
                      const next = e.currentTarget.checked;
                      deferTask(() => {
                        void (async () => {
                          try {
                            await saveGatedBotConfig({ supertrendFuturesRequireMarkPrice: next });
                          } catch (err) {
                            pushLog({
                              level: "error",
                              msg: `Failed to update require mark: ${err instanceof Error ? err.message : String(err)}`,
                            });
                          }
                        })();
                      });
                    }}
                  />
                  <span>
                    Require mark price
                    <span className="mt-0.5 block text-[10px] text-slate-500 dark:text-slate-400">
                      Skip open if premium-index mark cannot be fetched (stricter).
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2 text-[11px]">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={cfg.supertrendFuturesRequireBookTicker}
                    onChange={(e) => {
                      const next = e.currentTarget.checked;
                      deferTask(() => {
                        void (async () => {
                          try {
                            await saveGatedBotConfig({ supertrendFuturesRequireBookTicker: next });
                          } catch (err) {
                            pushLog({
                              level: "error",
                              msg: `Failed to update require book: ${err instanceof Error ? err.message : String(err)}`,
                            });
                          }
                        })();
                      });
                    }}
                  />
                  <span>
                    Require book ticker
                    <span className="mt-0.5 block text-[10px] text-slate-500 dark:text-slate-400">
                      Skip open if best bid/ask snapshot fails while slippage guard is active.
                    </span>
                  </span>
                </label>
              </div>
              </>
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
                            await saveGatedBotConfig({ futuresLeverageMode: v });
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
                          await saveGatedBotConfig({ futuresLeverage: v });
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
                  <span
                    className="text-slate-600 dark:text-slate-400"
                    title={
                      (isFibSoloGateOnly(cfg)
                        ? "Fibonacci-only: SL/TP are set from the impulse swing (beyond swing extreme / leg target), not this field. "
                        : "Default stop distance for Supertrend futures when the AI confidence filter is OFF — maps to supertrendFuturesFixedSlPct (e.g. 0.2 = 0.2%). ") +
                      "When the AI filter is ON, the risk engine uses ATR/regime-based brackets instead, so displayed SL distance can differ from this field. " +
                      "After entry, tick size rounding, mark vs fill, and trailing can move the working stop vs this nominal %."
                    }
                  >
                    SL %
                  </span>
                  <div className="flex min-w-0 items-center gap-2">
                    <label
                      className="flex shrink-0 items-center gap-1 text-[10px] text-slate-600 dark:text-slate-400"
                      title="Check to open without a stop-loss bracket (exit via flip/trail/manual close)"
                    >
                      <input
                        type="checkbox"
                        checked={!futuresUseFixedSl}
                        disabled={!slTpFieldsEditable(cfg)}
                        onChange={(e) => {
                          const off = e.target.checked;
                          setFuturesUseFixedSl(!off);
                          void saveGatedBotConfig({ supertrendFuturesUseFixedSl: !off }).catch(() => {
                            pushLog({ level: "error", msg: "Failed to update SL bracket toggle" });
                          });
                        }}
                      />
                      Off
                    </label>
                    <NumericTextInput
                      value={Number((cfg.supertrendFuturesFixedSlPct * 100).toFixed(8))}
                      min={0.005}
                      max={20}
                      disabled={!slTpFieldsEditable(cfg) || !futuresUseFixedSl}
                      onCommit={async (v) => {
                        try {
                          await saveGatedBotConfig({ supertrendFuturesFixedSlPct: v / 100, supertrendFuturesUseFixedSl: true });
                          setFuturesUseFixedSl(true);
                        } catch {
                          pushLog({ level: "error", msg: "Failed to set SL %" });
                        }
                      }}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-[110px_1fr] items-center gap-2">
                  <span
                    className="text-slate-600 dark:text-slate-400"
                    title={
                      isFibSoloGateOnly(cfg)
                        ? "Fibonacci-only: take-profit is the impulse leg target (swing high/low), not this field."
                        : "Take-profit distance as % of price (e.g. 1.5 = 1.5%)."
                    }
                  >
                    TP %
                  </span>
                  <div className="flex min-w-0 items-center gap-2">
                    <label
                      className="flex shrink-0 items-center gap-1 text-[10px] text-slate-600 dark:text-slate-400"
                      title="Check to open without a take-profit bracket"
                    >
                      <input
                        type="checkbox"
                        checked={!futuresUseFixedTp}
                        disabled={!slTpFieldsEditable(cfg)}
                        onChange={(e) => {
                          const off = e.target.checked;
                          setFuturesUseFixedTp(!off);
                          void saveGatedBotConfig({ supertrendFuturesUseFixedTp: !off }).catch(() => {
                            pushLog({ level: "error", msg: "Failed to update TP bracket toggle" });
                          });
                        }}
                      />
                      Off
                    </label>
                    <NumericTextInput
                      value={Number((cfg.supertrendFuturesFixedTpPct * 100).toFixed(8))}
                      min={0.005}
                      max={50}
                      disabled={!slTpFieldsEditable(cfg) || !futuresUseFixedTp}
                      onCommit={async (v) => {
                        try {
                          await saveGatedBotConfig({ supertrendFuturesFixedTpPct: v / 100, supertrendFuturesUseFixedTp: true });
                          setFuturesUseFixedTp(true);
                        } catch {
                          pushLog({ level: "error", msg: "Failed to set TP %" });
                        }
                      }}
                    />
                  </div>
                </div>
                <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-500">
                  <span className="text-slate-600 dark:text-slate-400">Off</span> = no exchange SL/TP on open (use flip, trail, or manual close).{" "}
                  <span className="text-slate-600 dark:text-slate-400">SL</span> / <span className="text-slate-600 dark:text-slate-400">TP</span> % apply to{" "}
                  <span className="text-slate-600 dark:text-slate-400">MANUAL</span> signal paths and backtests. Supertrend autotrade with the AI
                  confidence filter <span className="text-slate-600 dark:text-slate-400">on</span> may use ATR brackets instead.{" "}
                  <span className="font-mono text-slate-600 dark:text-slate-500">0.8</span> = 0.8% distance.
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
                                  await saveGatedBotConfig({ universePinnedSymbols: [] });
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
                              await saveGatedBotConfig({ universeCoinBase: v });
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
                                  await saveGatedBotConfig({ universePinControl: "AUTO" });
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
                                  await saveGatedBotConfig({ universePinControl: "MANUAL" });
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
                                await saveGatedBotConfig({ universeAutoCoinPick: v });
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
                            const estOpenRank = estimateFuturesOpenNotionalForOrderUi(bot, cfg, symU, positions, account, futuresLevDraft);
                            const belowMinRanked =
                              capitalMultiSet.has(symU) &&
                              showFuturesMinNotionalGate &&
                              estOpenRank != null &&
                              Number.isFinite(futuresMinNotionalBySymbol[symU]) &&
                              futuresOrderNotionalBelowMin(estOpenRank, futuresMinNotionalBySymbol[symU]);
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
                                  <div className="flex min-w-0 flex-col gap-0.5">
                                    <div className="flex flex-wrap items-center gap-x-1.5">
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
                                    </div>
                                    {belowMinRanked ? (
                                      <div className="max-w-[15rem] text-[9px] font-medium leading-snug text-amber-800 dark:text-amber-200/90">
                                        Won&apos;t be used to trade: below min notional value
                                      </div>
                                    ) : null}
                                  </div>
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
                                                await saveGatedBotConfig({ universePinnedSymbols: next });
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
                                                await saveGatedBotConfig({ universePinnedSymbols: next });
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
                                              await saveGatedBotConfig({ universePinnedSymbol: null });
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
                                              await saveGatedBotConfig({ universePinnedSymbol: sym });
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

            {cfg.marketMode === "FUTURES" && (
              <>
                <div className="space-y-2 rounded-lg border border-emerald-900/45 bg-emerald-950/20 p-2">
                  <div className="text-[11px] font-semibold text-emerald-200/95">Trade history fees (USD‑M · modeled)</div>
                  <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-400">
                    Custom maker vs taker fee rates as <span className="text-slate-700 dark:text-slate-300">percent of notional</span>{" "}
                    (e.g. 0.05 = 0.05%). Used for Portfolio <span className="font-medium text-slate-700 dark:text-slate-300">trade history</span>{" "}
                    when the exchange did not attach commission on a row; fills from Binance still override when present. Liquidity class comes from{" "}
                    fill data when available, else order type / stop vs limit heuristics (defaults to taker).
                  </p>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="rounded-md border border-emerald-800/40 bg-white/40 px-2 py-1.5 dark:bg-slate-950/40">
                      <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-emerald-800/80 dark:text-emerald-300/70">
                        Maker (limit adds liquidity)
                      </div>
                      <div className="grid grid-cols-[108px_1fr] items-center gap-2 text-xs">
                        <span className="text-slate-600 dark:text-slate-400">Entry %</span>
                        <NumericTextInput
                          value={+(cfg.tradeHistoryMakerOpenFeeRate * 100).toFixed(4)}
                          inputMode="decimal"
                          min={0}
                          max={1}
                          parse={(raw) => parseFloat(raw)}
                          onCommit={async (v) => {
                            try {
                              await saveGatedBotConfig({ tradeHistoryMakerOpenFeeRate: clampNum(v / 100, 0, 0.01) });
                            } catch {
                              pushLog({ level: "error", msg: "Failed to set maker entry fee %" });
                            }
                          }}
                        />
                      </div>
                      <div className="mt-1 grid grid-cols-[108px_1fr] items-center gap-2 text-xs">
                        <span className="text-slate-600 dark:text-slate-400">Exit %</span>
                        <NumericTextInput
                          value={+(cfg.tradeHistoryMakerCloseFeeRate * 100).toFixed(4)}
                          inputMode="decimal"
                          min={0}
                          max={1}
                          parse={(raw) => parseFloat(raw)}
                          onCommit={async (v) => {
                            try {
                              await saveGatedBotConfig({ tradeHistoryMakerCloseFeeRate: clampNum(v / 100, 0, 0.01) });
                            } catch {
                              pushLog({ level: "error", msg: "Failed to set maker exit fee %" });
                            }
                          }}
                        />
                      </div>
                    </div>
                    <div className="rounded-md border border-emerald-800/40 bg-white/40 px-2 py-1.5 dark:bg-slate-950/40">
                      <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-emerald-800/80 dark:text-emerald-300/70">
                        Taker (market / takes liquidity)
                      </div>
                      <div className="grid grid-cols-[108px_1fr] items-center gap-2 text-xs">
                        <span className="text-slate-600 dark:text-slate-400">Entry %</span>
                        <NumericTextInput
                          value={+(cfg.tradeHistoryTakerOpenFeeRate * 100).toFixed(4)}
                          inputMode="decimal"
                          min={0}
                          max={1}
                          parse={(raw) => parseFloat(raw)}
                          onCommit={async (v) => {
                            try {
                              await saveGatedBotConfig({ tradeHistoryTakerOpenFeeRate: clampNum(v / 100, 0, 0.01) });
                            } catch {
                              pushLog({ level: "error", msg: "Failed to set taker entry fee %" });
                            }
                          }}
                        />
                      </div>
                      <div className="mt-1 grid grid-cols-[108px_1fr] items-center gap-2 text-xs">
                        <span className="text-slate-600 dark:text-slate-400">Exit %</span>
                        <NumericTextInput
                          value={+(cfg.tradeHistoryTakerCloseFeeRate * 100).toFixed(4)}
                          inputMode="decimal"
                          min={0}
                          max={1}
                          parse={(raw) => parseFloat(raw)}
                          onCommit={async (v) => {
                            try {
                              await saveGatedBotConfig({ tradeHistoryTakerCloseFeeRate: clampNum(v / 100, 0, 0.01) });
                            } catch {
                              pushLog({ level: "error", msg: "Failed to set taker exit fee %" });
                            }
                          }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
                <div className="space-y-2 rounded-lg border border-sky-800/50 bg-sky-950/25 p-2">
                  <div className="text-[11px] font-semibold text-sky-200/95">Futures entry (Supertrend signal → order)</div>
                  <p className="text-[10px] leading-snug text-slate-500 dark:text-slate-400">
                    Flow: bar-close signal uses the candle <span className="text-slate-600 dark:text-slate-300">close</span> as the
                    reference price → server fetches <span className="text-slate-600 dark:text-slate-300">live bid/ask, mark, mid</span> →
                    if any price is worse than your max slippage vs that close, the open is <span className="text-slate-600 dark:text-slate-300">skipped</span>{" "}
                    (better than a bad MARKET fill). With <span className="text-slate-600 dark:text-slate-300">AUTO</span> open style and slippage
                    &gt; 0, the first attempt is typically <span className="text-slate-600 dark:text-slate-300">LIMIT IOC</span> at close × (1±slippage).
                    Activity logs fill vs signal as bps. Values below are saved with bot config (server{" "}
                    <code className="text-slate-600 dark:text-slate-400">bot-trading-config.json</code>).
                  </p>
                  <div className="grid grid-cols-[118px_1fr] items-center gap-2 text-xs">
                    <span className="text-slate-600 dark:text-slate-400" title="Percent points vs signal candle close (0 = disable guard).">
                      Max slippage %
                    </span>
                    <NumericTextInput
                      value={Number(cfg.supertrendFuturesMaxEntrySlippagePct.toFixed(4))}
                      inputMode="decimal"
                      min={0}
                      max={5}
                      parse={(raw) => parseFloat(raw)}
                      onCommit={async (v) => {
                        try {
                          await saveGatedBotConfig({ supertrendFuturesMaxEntrySlippagePct: clampNum(v, 0, 5) });
                        } catch {
                          pushLog({ level: "error", msg: "Failed to set max entry slippage" });
                        }
                      }}
                    />
                  </div>
                  <label className="grid grid-cols-[118px_1fr] items-center gap-2 text-xs">
                    <span className="text-slate-600 dark:text-slate-400">Open style</span>
                    <select
                      className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-slate-900 dark:text-slate-100"
                      value={cfg.supertrendFuturesEntryOpenStyle}
                      onChange={(e) => {
                        const v = e.target.value as "AUTO" | "MARKET" | "LIMIT_IOC";
                        deferTask(() => {
                          void (async () => {
                            try {
                              await saveGatedBotConfig({ supertrendFuturesEntryOpenStyle: v });
                              pushLog({ level: "info", msg: `Futures entry open style: ${v}` });
                            } catch {
                              pushLog({ level: "error", msg: "Failed to set open style" });
                            }
                          })();
                        });
                      }}
                    >
                      <option value="AUTO">AUTO (LIMIT IOC if slippage &gt; 0)</option>
                      <option value="LIMIT_IOC">LIMIT IOC</option>
                      <option value="MARKET">MARKET</option>
                    </select>
                  </label>
                  <div className="grid grid-cols-[118px_1fr] items-center gap-2 text-xs">
                    <span className="text-slate-600 dark:text-slate-400" title="Wait, then re-fetch book/mark before placing.">
                      Recheck ms
                    </span>
                    <NumericTextInput
                      value={cfg.supertrendFuturesEntryRecheckMs}
                      inputMode="numeric"
                      min={0}
                      max={60000}
                      parse={(raw) => parseInt(raw, 10)}
                      onCommit={async (v) => {
                        try {
                          await saveGatedBotConfig({ supertrendFuturesEntryRecheckMs: Math.max(0, Math.min(60000, Math.floor(v))) });
                        } catch {
                          pushLog({ level: "error", msg: "Failed to set entry recheck ms" });
                        }
                      }}
                    />
                  </div>
                  <div className="grid grid-cols-[118px_1fr] items-center gap-2 text-xs">
                    <span className="text-slate-600 dark:text-slate-400" title="Skip if bar-close to order is too slow (AI/network).">
                      Max signal lag ms
                    </span>
                    <NumericTextInput
                      value={cfg.supertrendFuturesMaxSignalLagMs}
                      inputMode="numeric"
                      min={0}
                      max={3600000}
                      parse={(raw) => parseInt(raw, 10)}
                      onCommit={async (v) => {
                        try {
                          await saveGatedBotConfig({ supertrendFuturesMaxSignalLagMs: Math.max(0, Math.floor(v)) });
                        } catch {
                          pushLog({ level: "error", msg: "Failed to set max signal lag" });
                        }
                      }}
                    />
                  </div>
                  <label className="flex cursor-pointer items-start gap-2 text-[11px]">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={cfg.supertrendFuturesIocFallbackMarket}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        deferTask(() => {
                          void (async () => {
                            try {
                              await saveGatedBotConfig({ supertrendFuturesIocFallbackMarket: on });
                              pushLog({
                                level: "info",
                                msg: on
                                  ? "IOC no-fill → may retry MARKET if still within slippage cap"
                                  : "IOC no-fill → no MARKET fallback",
                              });
                            } catch {
                              pushLog({ level: "error", msg: "Failed to update IOC fallback" });
                            }
                          })();
                        });
                      }}
                    />
                    <span>
                      <span className="font-medium text-slate-700 dark:text-slate-200">IOC → MARKET fallback</span>
                      <span className="mt-0.5 block text-[10px] text-slate-500 dark:text-slate-400">
                        If LIMIT IOC does not fill, re-quote once; place MARKET only if still inside the slippage band (off = safer).
                      </span>
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2 text-[11px]">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={cfg.supertrendFuturesRequireMarkPrice}
                      onChange={(e) => {
                        const next = e.currentTarget.checked;
                        deferTask(() => {
                          void (async () => {
                            try {
                              await saveGatedBotConfig({ supertrendFuturesRequireMarkPrice: next });
                            } catch (err) {
                              pushLog({
                                level: "error",
                                msg: `Failed to update require mark: ${err instanceof Error ? err.message : String(err)}`,
                              });
                            }
                          })();
                        });
                      }}
                    />
                    <span>
                      Require mark price
                      <span className="mt-0.5 block text-[10px] text-slate-500 dark:text-slate-400">
                        Skip open if premium-index mark cannot be fetched (stricter).
                      </span>
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2 text-[11px]">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={cfg.supertrendFuturesRequireBookTicker}
                      onChange={(e) => {
                        const next = e.currentTarget.checked;
                        deferTask(() => {
                          void (async () => {
                            try {
                              await saveGatedBotConfig({ supertrendFuturesRequireBookTicker: next });
                            } catch (err) {
                              pushLog({
                                level: "error",
                                msg: `Failed to update require book: ${err instanceof Error ? err.message : String(err)}`,
                              });
                            }
                          })();
                        });
                      }}
                    />
                    <span>
                      Require book ticker
                      <span className="mt-0.5 block text-[10px] text-slate-500 dark:text-slate-400">
                        Skip open if best bid/ask snapshot fails while slippage guard is active.
                      </span>
                    </span>
                  </label>
                </div>
              </>
            )}

            <label className="grid grid-cols-[110px_1fr] items-center gap-2">
              <span className="text-slate-600 dark:text-slate-400">AI threshold</span>
              <NumericTextInput
                value={cfg.aiThreshold}
                min={0}
                max={1}
                onCommit={async (v) => {
                  try {
                    await saveGatedBotConfig({ aiThreshold: v });
                  } catch {
                    pushLog({ level: "error", msg: "Failed to set AI threshold" });
                  }
                }}
              />
            </label>

            

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
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold text-sky-900 dark:text-sky-100">Trailing stop (futures autotrade)</div>
                    <button
                      className="rounded border border-sky-200 bg-white px-2 py-1 text-[10px] font-semibold text-sky-900 hover:bg-sky-50 dark:border-sky-800 dark:bg-slate-900 dark:text-sky-100 dark:hover:bg-slate-800"
                      onClick={() => {
                        const sym = String(trailPreviewSymbol || activeSymbol).toUpperCase();
                        const tf = String(trailPreviewTimeframe || bot?.timeframe || "1h");
                        setTrailPreviewSnap({
                          symbol: sym,
                          timeframe: tf,
                          candles: Array.isArray(chartCandles) ? chartCandles : [],
                          atrPct: marketAtrPct,
                        });
                        setTrailPreviewOpen(true);
                      }}
                      title="Preview trail gates and locks on a mini chart (cached candles only)."
                      type="button"
                    >
                      Preview
                    </button>
                  </div>
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
                              await saveGatedBotConfig({ trailingStopLossAuto: on });
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
                                await saveGatedBotConfig({ futuresTrailingStopMode: "SUPERTREND" });
                                pushLog({ level: "info", msg: "Futures trailing: Supertrend line + fee activation (chart ST, breakeven floor)" });
                              } catch {
                                pushLog({ level: "error", msg: "Failed to set trailing mode" });
                              }
                            })();
                          });
                        }}
                      />
                      <span>
                        <span className="font-semibold text-slate-800 dark:text-slate-200">Supertrend-based</span> — Uses the chart Supertrend line and/or
                        a fee breakeven floor (see toggles below). At least one sub-option stays on; both on matches the classic behavior. Includes a rough
                        liquidation-vs-breakeven guard.
                      </span>
                    </label>
                    {cfg.futuresTrailingStopMode === "SUPERTREND" ? (
                      <div className="ml-6 space-y-2 rounded-md border border-sky-200/90 bg-sky-50/70 px-2 py-1.5 dark:border-sky-800/50 dark:bg-slate-900/60">
                        <div className="text-[10px] font-semibold text-sky-900 dark:text-sky-200">Supertrend-based (apply any combination)</div>

                        {/* ── Fee Breakeven toggle + its metrics ── */}
                        <label className="flex cursor-pointer items-start gap-2 text-[10px] leading-snug text-slate-700 dark:text-slate-300">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={cfg.futuresTrailingStFeeBreakeven}
                            onChange={(e) => {
                              const on = e.currentTarget.checked;
                              if (!on && !cfg.futuresTrailingStAdvanced) {
                                pushLog({
                                  level: "info",
                                  msg: "At least one Supertrend trail mode must stay on — Advanced will remain enabled.",
                                });
                              }
                              void saveGatedBotConfig({ futuresTrailingStFeeBreakeven: on }).catch(() =>
                                pushLog({ level: "error", msg: "Failed to update fee breakeven trailing" }),
                              );
                            }}
                          />
                          <span>
                            <span className="font-semibold text-slate-800 dark:text-slate-200">Fee breakeven (T01 / T02)</span>
                            {" — "}
                            {cfg.futuresTrailingStAdvanced ? (
                              <>
                                With Advanced on: <span className="font-mono text-sky-800 dark:text-sky-200">T01</span> locks SL
                                to entry after mark passes entry × (1 + buffer). Then{" "}
                                <span className="font-mono text-sky-800 dark:text-sky-200">T02</span> locks at padded
                                round-trip breakeven after mark passes entry × (1 + padded fee + buffer). Supertrend tiers
                                continue as T1, T2…
                              </>
                            ) : (
                              <>
                                When mark crosses activation (padded round-trip fee + buffer), SL locks at the padded
                                breakeven level. No Supertrend line needed.
                              </>
                            )}
                          </span>
                        </label>
                        {cfg.futuresTrailingStFeeBreakeven && (
                          <>
                            <TrailMetricGroup
                              title="Fee breakeven parameters"
                              items={[
                                {
                                  key: "trailOpenFeeRate",
                                  label: "Open fee rate (%)",
                                  tip: `Taker/maker fee paid when opening the position.\nUsed in: T0 SL = entry × (1 + openFee + closeFee) × multiplier\nDefault: ${(cfg.trailOpenFeeRate * 100).toFixed(4)}%`,
                                  min: 0, max: 1, step: 0.01, decimals: 4, pct: true,
                                },
                                {
                                  key: "trailCloseFeeRate",
                                  label: "Close fee rate (%)",
                                  tip: `Taker fee paid when the SL exit fires.\nRound-trip = openFee + closeFee.\nT0 SL = entry × (1 + round-trip × multiplier)\nDefault: ${(cfg.trailCloseFeeRate * 100).toFixed(4)}%`,
                                  min: 0, max: 1, step: 0.01, decimals: 4, pct: true,
                                },
                                {
                                  key: "trailFeeBeMultiplier",
                                  label: "Safety multiplier ×",
                                  tip: `Safety × on round-trip fee for the T02 lock.\nT02 SL = entry × (1 ± round-trip × multiplier).\nT02 activation = entry × (1 ± (padded fee + buffer)).\n1.0 = exact break-even (gross = fees, net ≈ 0 — matches spec).\n>1.0 (e.g. 1.25) over-covers fees to absorb stop-market slippage, but T02 fires later and gross > fees.\nCurrent: ${cfg.trailFeeBeMultiplier.toFixed(2)}`,
                                  min: 1, max: 2, step: 0.05, decimals: 2, pct: false,
                                },
                                {
                                  key: "trailActivationSlippageFrac",
                                  label: "BE slippage add-on (%)",
                                  tip: `Added to the padded round-trip fee for Supertrend tiered gates only (T02 lock/activation and later); caps at 2% combined.\nUse a small value (e.g. 0.01–0.03%) to approximate execution vs theoretical fees.\nDefault: ${(cfg.trailActivationSlippageFrac * 100).toFixed(3)}%`,
                                  min: 0, max: 1, step: 0.01, decimals: 3, pct: true,
                                },
                                {
                                  key: "trailT01LockSlippageFrac",
                                  label: "T01 lock slippage (%)",
                                  tip: `Tiered Supertrend **T01 lock** offset from entry.\nT01 SL = entry × (1 ± this).\nDefault **0** — T01 locks AT entry (zero-loss point per spec: gross 0, net = -fees).\nRaise slightly (e.g. 0.02 %) only if you want a tick or two past entry to avoid sub-tick mark noise.\nMust stay **below** T02 lock offset (paddedFee); otherwise T01 lock ≥ T02 and T02 never fires.\nCurrent: ${(cfg.trailT01LockSlippageFrac * 100).toFixed(3)} %`,
                                  min: 0, max: 1, step: 0.01, decimals: 3, pct: true,
                                },
                              ]}
                              cfg={cfg}
                              onChange={(k, v) => void saveGatedBotConfig({ [k]: v }).catch(() =>
                                pushLog({ level: "error", msg: `Failed to update ${k}` }),
                              )}
                            />
                            <div className="ml-4 mt-1 space-y-1.5 rounded border border-sky-200/50 bg-white/60 px-2 py-1.5 dark:border-sky-800/30 dark:bg-slate-950/50">
                              <div className="text-[9px] font-semibold uppercase tracking-wide text-sky-800/70 dark:text-sky-300/50">
                                Activation buffer
                              </div>
                              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-700 dark:text-slate-300">
                                <label className="flex cursor-pointer items-center gap-1.5">
                                  <input
                                    type="radio"
                                    name="trailBufferMode"
                                    className="mt-0.5"
                                    checked={cfg.trailBufferMode === "PERCENT"}
                                    onChange={() =>
                                      void saveGatedBotConfig({ trailBufferMode: "PERCENT" }).catch(() =>
                                        pushLog({ level: "error", msg: "Failed to update buffer mode" }),
                                      )
                                    }
                                  />
                                  Fixed %
                                </label>
                                <label className="flex cursor-pointer items-center gap-1.5">
                                  <input
                                    type="radio"
                                    name="trailBufferMode"
                                    className="mt-0.5"
                                    checked={cfg.trailBufferMode === "ATR"}
                                    onChange={() =>
                                      void saveGatedBotConfig({ trailBufferMode: "ATR" }).catch(() =>
                                        pushLog({ level: "error", msg: "Failed to update buffer mode" }),
                                      )
                                    }
                                  />
                                  ATR × multiplier
                                </label>
                              </div>
                              <TrailMetricGroup
                                title="Buffer settings"
                                items={
                                  cfg.trailBufferMode === "ATR"
                                    ? [
                                        {
                                          key: "trailBufferAtrMult",
                                          label: "ATR multiplier · T01 / T02",
                                          tip: `T01/T02 activation buffer when atrPct is available: buffer = min(5%, atrPct × this).\nIf ATR is missing, the fallback % below is used.\nPost-T02 rungs use the separate "Post-T02 activation buffer" (Advanced panel).\nDefault: ${cfg.trailBufferAtrMult.toFixed(2)}`,
                                          min: 0, max: 1, step: 0.05, decimals: 2, pct: false,
                                        },
                                        {
                                          key: "trailBufferRate",
                                          label: "Fallback buffer (%) · T01 / T02",
                                          tip: `Used when lastRegime.atrPct is not available or multiplier is 0.\nApplies to T01 / T02 only; post-T02 rungs have their own buffer in Advanced.\nDefault: ${(cfg.trailBufferRate * 100).toFixed(3)}%`,
                                          min: 0, max: 5, step: 0.01, decimals: 3, pct: true,
                                        },
                                      ]
                                    : [
                                        {
                                          key: "trailBufferRate",
                                          label: "Activation buffer (%) · T01 / T02",
                                          tip: `Applies to the T01 (zero-loss) and T02 (fee break-even) tiers ONLY.\nWith Advanced + Fee BE: T01 activation = entry × (1 + buffer); T02 adds padded fee on top.\nFee BE only (no Advanced): single activation = entry × (1 + paddedFee + buffer).\nPost-T02 rungs (T1, T2, T3…) use the independent "Post-T02 activation buffer" in Advanced trailing parameters below.\nDefault: ${(cfg.trailBufferRate * 100).toFixed(3)}%`,
                                          min: 0, max: 5, step: 0.01, decimals: 3, pct: true,
                                        },
                                      ]
                                }
                                cfg={cfg}
                                onChange={(k, v) => void saveGatedBotConfig({ [k]: v }).catch(() =>
                                  pushLog({ level: "error", msg: `Failed to update ${k}` }),
                                )}
                              />
                            </div>
                          </>
                        )}

                        {/* ── Advanced trailing toggle + its metrics ── */}
                        <label className="flex cursor-pointer items-start gap-2 text-[10px] leading-snug text-slate-700 dark:text-slate-300">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={cfg.futuresTrailingStAdvanced}
                            onChange={(e) => {
                              const on = e.currentTarget.checked;
                              if (!on && !cfg.futuresTrailingStFeeBreakeven) {
                                pushLog({
                                  level: "info",
                                  msg: "At least one Supertrend trail mode must stay on — Advanced will remain enabled.",
                                });
                              }
                              void saveGatedBotConfig({ futuresTrailingStAdvanced: on }).catch(() =>
                                pushLog({ level: "error", msg: "Failed to update advanced Supertrend trailing" }),
                              );
                            }}
                          />
                          <span>
                            <span className="font-semibold text-slate-800 dark:text-slate-200">Advanced trailing (T1, T2…)</span>
                            {" — "}Continuously ratchets SL to the live Supertrend line (with T02 padded fee floor when Fee
                            breakeven is also on). With both on, discrete gates run first:{" "}
                            <span className="font-mono text-sky-700 dark:text-sky-300">T01 → T02 → T1 → T2…</span>
                            {" "}Post‑T02 tiers use equal spacing from the T02 lock (not the fee ladder’s T0/T1 interval).
                          </span>
                        </label>
                        {cfg.futuresTrailingStAdvanced && (
                          <TrailMetricGroup
                            title="Advanced trailing parameters"
                            items={[
                              {
                                key: "trailPostT02ActivationBufferRate",
                                label: "Post‑T02 activation buffer (%)",
                                tip: `Independent activation buffer for every post-T02 profit rung (T1, T2, T3…).\nFormula: activation_k = lock_k × (1 ± postT02Buffer).\nSet to 0 to inherit the T01/T02 buffer value (legacy single-buffer behaviour); any value > 0 decouples the profit-rung pull-back cushion from the fee-recovery cushion.\nTypical split: keep T01/T02 tight (fast loss protection) while giving profit rungs a larger cushion to ride out noise.\nCurrent: ${cfg.trailPostT02ActivationBufferRate > 0 ? `${(cfg.trailPostT02ActivationBufferRate * 100).toFixed(3)}%` : `inheriting T01/T02 (${(cfg.trailBufferRate * 100).toFixed(3)}%)`}`,
                                min: 0, max: 5, step: 0.01, decimals: 3, pct: true,
                              },
                              {
                                key: "trailMinSlDistFrac",
                                label: "Min SL distance (%)",
                                tip: `Minimum fractional improvement from the current mark to move the SL.\nFormula: |mark − newSL| / mark ≥ minSlDistFrac\nPrevents ratchet spam on tiny ST fluctuations.\nDefault: ${(cfg.trailMinSlDistFrac * 100).toFixed(3)}%`,
                                min: 0, max: 10, step: 0.01, decimals: 3, pct: true,
                              },
                              {
                                key: "trailMinGapFromMarkFrac",
                                label: "Min gap from mark (%)",
                                tip: `Minimum distance between mark and trailing SL (fraction of mark).\nLONG: SL ≤ mark × (1 − gap). SHORT: SL ≥ mark × (1 + gap).\n0 = off. Gives room for pullbacks so a tight ST line does not stop you immediately.\nExample: 0.5% at mark 100 → long SL capped at 99.5 or below.`,
                                min: 0, max: 20, step: 0.05, decimals: 3, pct: true,
                              },
                              {
                                key: "trailMaintMarginRate",
                                label: "Maint margin rate (%)",
                                tip: `Liquidation zone guard used at order-open time.\nFormula: liqPrice = entry × (1 − 1/leverage + maintMarginRate)  [LONG]\nOpen is rejected if liqPrice ≥ T0_breakeven (money lost to fees before liq).\nDefault: ${(cfg.trailMaintMarginRate * 100).toFixed(3)}%`,
                                min: 0, max: 10, step: 0.05, decimals: 3, pct: true,
                              },
                              {
                                key: "trailPostT02SpacingFrac",
                                label: "Post‑T02 step (% entry)",
                                tip: `Spacing between successive post‑T02 lock prices (T1, T2, …) as a percent of entry.\n0 = automatic: min(2%, max(2× round-trip fee, 0.04%)) per entry.\nEach tier’s activation is still that lock × (1 ± buffer).`,
                                min: 0, max: 5, step: 0.01, decimals: 3, pct: true,
                              },
                              {
                                key: "trailPostT02MaxExtraTiers",
                                label: "Max post‑T02 tiers",
                                tip: `How many equidistant rungs after T02 the engine may model (T1 … Tn). Total trail steps cap ≈ 3 + this (floored/clamped server-side).`,
                                min: 10, max: 500, step: 1, decimals: 0, pct: false,
                              },
                            ]}
                            cfg={cfg}
                            onChange={(k, v) => {
                              if (k === "trailPostT02SpacingFrac") {
                                void api
                                  .botConfig({ trailPostT02SpacingFrac: v <= 0 ? null : v })
                                  .catch(() => pushLog({ level: "error", msg: `Failed to update ${k}` }));
                                return;
                              }
                              if (k === "trailPostT02ActivationBufferRate") {
                                /**
                                 * 0 in the UI = "inherit T01/T02 buffer" — backend uses `null` for that state.
                                 * Any positive value decouples the post-T02 activation cushion from the main buffer.
                                 */
                                void api
                                  .botConfig({ trailPostT02ActivationBufferRate: v <= 0 ? null : v })
                                  .catch(() => pushLog({ level: "error", msg: `Failed to update ${k}` }));
                                return;
                              }
                              void saveGatedBotConfig({ [k]: v }).catch(() =>
                                pushLog({ level: "error", msg: `Failed to update ${k}` }),
                              );
                            }}
                          />
                        )}
                      </div>
                    ) : null}

                    {/* ── Fee Ladder radio + its metrics ── */}
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
                                await saveGatedBotConfig({ futuresTrailingStopMode: "FEE_LADDER" });
                                pushLog({ level: "info", msg: "Futures trailing: Fee ladder — discrete locks" });
                              } catch {
                                pushLog({ level: "error", msg: "Failed to set trailing mode" });
                              }
                            })();
                          });
                        }}
                      />
                      <span>
                        <span className="font-semibold text-slate-800 dark:text-slate-200">Fee ladder</span>
                        {" — "}Discrete price locks using high/low watermark (no Supertrend needed):{" "}
                        <span className="font-mono text-slate-500 dark:text-slate-400">T0</span> = round-trip breakeven,{" "}
                        <span className="font-mono text-slate-500 dark:text-slate-400">T1</span> = 2× round-trip,{" "}
                        <span className="font-mono text-slate-500 dark:text-slate-400">T2/T3/T4</span> = optional % of entry locks.
                      </span>
                    </label>
                    {cfg.futuresTrailingStopMode === "FEE_LADDER" && (
                      <div className="ml-6 space-y-2 rounded-md border border-slate-200/80 bg-slate-50/70 px-2 py-1.5 dark:border-slate-700/60 dark:bg-slate-900/60">
                        <TrailMetricGroup
                          title="Fee rates (T0 and T1 calculation)"
                          items={[
                            {
                              key: "trailOpenFeeRate",
                              label: "Open fee rate (%)",
                              tip: `Taker/maker fee for opening the position.\nT0 lock = entry × (1 + (openFee + closeFee) × multiplier)\nT1 lock = entry × (1 + 2 × (openFee + closeFee))\nDefault: ${(cfg.trailOpenFeeRate * 100).toFixed(4)}%`,
                              min: 0, max: 1, step: 0.01, decimals: 4, pct: true,
                            },
                            {
                              key: "trailCloseFeeRate",
                              label: "Close fee rate (%)",
                              tip: `Taker fee for the SL exit.\nRound-trip = openFee + closeFee.\nT0 = entry × (1 + roundTrip)\nT1 = entry × (1 + 2 × roundTrip)\nDefault: ${(cfg.trailCloseFeeRate * 100).toFixed(4)}%`,
                              min: 0, max: 1, step: 0.01, decimals: 4, pct: true,
                            },
                            {
                              key: "trailFeeBeMultiplier",
                              label: "T0 safety multiplier ×",
                              tip: `Safety margin on the T0 (breakeven) lock only.\nT0 = entry × (1 + roundTrip × multiplier)\nT1 onwards use exact round-trip (no multiplier).\n1.0 = exact round-trip breakeven.\nDefault: ${cfg.trailFeeBeMultiplier.toFixed(2)}`,
                              min: 1, max: 2, step: 0.05, decimals: 2, pct: false,
                            },
                          ]}
                          cfg={cfg}
                          onChange={(k, v) => void saveGatedBotConfig({ [k]: v }).catch(() =>
                            pushLog({ level: "error", msg: `Failed to update ${k}` }),
                          )}
                        />
                        <div className="space-y-1 border-t border-slate-200/60 pt-2 dark:border-slate-700/40">
                          <p className="text-[10px] text-slate-600 dark:text-slate-500">
                            <span className="font-semibold">T2 / T3 / T4</span> — Extra scalp locks at % of entry (T2, T3, T4). Leave blank to skip.
                          </p>
                          {([0, 1, 2] as const).map((idx) => (
                            <div key={idx} className="grid grid-cols-[80px_1fr] items-center gap-2">
                              <span
                                className="text-[10px] text-slate-600 dark:text-slate-500"
                                title={`T${2 + idx} lock = entry × (1 ± pct/100). Activates when high/low watermark crosses this price.`}
                              >
                                T{2 + idx} lock (%)
                              </span>
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
                                    await saveGatedBotConfig({ trailingStopExtraScalpingPcts: next });
                                  } catch {
                                    pushLog({ level: "error", msg: "Failed to set trailing extra scalping" });
                                  }
                                }}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </fieldset>
                </div>
              </div>
            )}

            {(
              <div className="mb-3 rounded-xl border-2 border-violet-600/35 bg-gradient-to-br from-violet-50/95 via-white to-slate-50/90 p-3 shadow-md dark:border-violet-500/35 dark:from-violet-950/45 dark:via-slate-950 dark:to-slate-900/90">
                <div className="flex flex-wrap items-start justify-between gap-2 border-b border-violet-800/15 pb-2 dark:border-violet-300/10">
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold tracking-tight text-slate-900 dark:text-slate-50">Indicators</h3>
                    <p className="mt-0.5 max-w-[28rem] text-[10px] leading-snug text-slate-600 dark:text-slate-400">
                      Supertrend autotrade filters (AI confidence, signal strength) plus{" "}
                      <span className="font-semibold text-amber-800 dark:text-amber-200">six intraday technique toggles</span> for
                      SR_INTRADAY — first block below.
                    </p>
                  </div>
                </div>

                <IntradayGatesPanel
                  id="intraday-gates"
                  cfg={{
                    intradayGateLiquidity: cfg.intradayGateLiquidity,
                    intradayGateSession: cfg.intradayGateSession,
                    intradayGateInstitutionalSr: cfg.intradayGateInstitutionalSr,
                    intradayGateSmcIct: cfg.intradayGateSmcIct,
                    intradayGateFib: cfg.intradayGateFib,
                    intradayGateVp: cfg.intradayGateVp,
                    intradayGateOrderFlow: cfg.intradayGateOrderFlow,
                    intradayGateHtfRegime: cfg.intradayGateHtfRegime,
                  }}
                  liq={{
                    intradayLiqTp1Enabled: cfg.intradayLiqTp1Enabled,
                    intradayLiqTp2Enabled: cfg.intradayLiqTp2Enabled,
                    intradayLiqBreakevenAfterPartial: cfg.intradayLiqBreakevenAfterPartial,
                    intradayLiqMinRr: cfg.intradayLiqMinRr,
                    intradayLiqMaxTpRr: cfg.intradayLiqMaxTpRr,
                    intradayLiqMaxHoldBars: cfg.intradayLiqMaxHoldBars,
                  }}
                  sr={{
                    intradaySrAPlusMode: cfg.intradaySrAPlusMode,
                    intradaySrMinVolRatio: cfg.intradaySrMinVolRatio,
                    intradaySrMinHtfSep: cfg.intradaySrMinHtfSep,
                    intradaySrZoneWidthPct: cfg.intradaySrZoneWidthPct,
                    intradaySrBosMaxBarsAfterReclaim: cfg.intradaySrBosMaxBarsAfterReclaim,
                    intradaySrMinConfirmWick: cfg.intradaySrMinConfirmWick,
                    intradayLiqMinSweepExtensionPct: cfg.intradayLiqMinSweepExtensionPct,
                  }}
                  smc={{
                    intradaySmcIctProfile: cfg.intradaySmcIctProfile,
                    intradaySmcPickMode: cfg.intradaySmcPickMode,
                    intradaySmcKillzoneMode: cfg.intradaySmcKillzoneMode,
                    intradaySmcEntryZoneMode: cfg.intradaySmcEntryZoneMode,
                    intradaySmcHtfStrictness: cfg.intradaySmcHtfStrictness,
                    intradaySmcMinAdx: cfg.intradaySmcMinAdx,
                    intradaySmcMinRr: cfg.intradaySmcMinRr,
                    intradaySmcRequireMss: cfg.intradaySmcRequireMss,
                    intradaySmcRequireRetrace: cfg.intradaySmcRequireRetrace,
                    intradaySmcRequireHtfBias: cfg.intradaySmcRequireHtfBias,
                    intradaySmcRequireChoch: cfg.intradaySmcRequireChoch,
                    intradaySmcRequireBos: cfg.intradaySmcRequireBos,
                    intradaySmcRequireConfirm: cfg.intradaySmcRequireConfirm,
                    intradaySmcRequireFvgRetrace: cfg.intradaySmcRequireFvgRetrace,
                    intradaySmcUseOrderFlow: cfg.intradaySmcUseOrderFlow,
                  }}
                  of={{
                    intradayOfKillzoneMode: cfg.intradayOfKillzoneMode,
                    intradayOfRequireKeyLevel: cfg.intradayOfRequireKeyLevel,
                    intradayOfRequirePremiumDiscount: cfg.intradayOfRequirePremiumDiscount,
                    intradayOfRequireConfirmation: cfg.intradayOfRequireConfirmation,
                    intradayOfMinStackBars: cfg.intradayOfMinStackBars,
                    intradayOfMinConfluence: cfg.intradayOfMinConfluence,
                    intradayOfUseOrderBook: cfg.intradayOfUseOrderBook,
                    intradayOfAllowProxy: cfg.intradayOfAllowProxy,
                    intradayOfVetoMode: cfg.intradayOfVetoMode,
                    intradayOfConfluenceMode: cfg.intradayOfConfluenceMode,
                    intradayOfAllowCvdOnly: cfg.intradayOfAllowCvdOnly,
                    intradayOfTp1Enabled: cfg.intradayOfTp1Enabled,
                    intradayOfTp2Enabled: cfg.intradayOfTp2Enabled,
                    intradayOfBreakevenAfterPartial: cfg.intradayOfBreakevenAfterPartial,
                    intradayOfExitOnDeltaAgainst: cfg.intradayOfExitOnDeltaAgainst,
                  }}
                  onStagePatch={stageStrategyBotPatch}
                />

                {(cfg.marketMode === "SPOT" || cfg.marketMode === "FUTURES" || cfg.marketMode === "AUTO") && (
                  <div
                    className={`mt-3 space-y-2 rounded-lg p-2 ${
                      cfg.marketMode === "FUTURES"
                        ? "border border-amber-900/40 bg-amber-950/15"
                        : cfg.marketMode === "SPOT"
                          ? "border border-emerald-900/40 bg-emerald-950/15"
                          : "border border-violet-800/40 bg-gradient-to-br from-amber-950/12 via-slate-950/25 to-emerald-950/12"
                    }`}
                  >
                    {cfg.marketMode === "AUTO" ? (
                      <div className="space-y-2">
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                          Both venues (market AUTO)
                        </div>
                        <label className="flex cursor-pointer items-start gap-2 text-xs">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={cfg.supertrendSpotAuto}
                            onChange={(e) => {
                              const autoOn = e.currentTarget.checked;
                              deferTask(() => {
                                void (async () => {
                                  try {
                                    await saveGatedBotConfig({ supertrendSpotAuto: autoOn });
                                    pushLog({
                                      level: "info",
                                      msg: autoOn
                                        ? "Supertrend spot autotrading ON — bar-close signals on spot; start the bot."
                                        : "Supertrend spot autotrading OFF",
                                    });
                                  } catch {
                                    pushLog({ level: "error", msg: "Failed to update Supertrend spot" });
                                  }
                                })();
                              });
                            }}
                          />
                          <span>
                            <span className="font-semibold text-emerald-200">Spot · Autotrade with Supertrend</span>
                            <span className="mt-0.5 block text-[11px] text-slate-600 dark:text-slate-500">
                              BUY / full-quote and SELL / full exit on bar close when the active lane is spot.
                            </span>
                          </span>
                        </label>
                        <label className="flex cursor-pointer items-start gap-2 text-xs">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={cfg.supertrendFuturesAuto}
                            onChange={(e) => {
                              const autoOn = e.currentTarget.checked;
                              deferTask(() => {
                                void (async () => {
                                  try {
                                    await saveGatedBotConfig(
                                      autoOn
                                        ? { supertrendFuturesAuto: true }
                                        : { supertrendFuturesAuto: false, supertrendFuturesAiConfidenceFilter: true },
                                    );
                                    pushLog({
                                      level: "info",
                                      msg: autoOn
                                        ? "Supertrend futures autotrading ON — /predict confidence for sizing when the lane is USD-M."
                                        : "Supertrend futures autotrading OFF",
                                    });
                                  } catch {
                                    pushLog({ level: "error", msg: "Failed to update Supertrend futures" });
                                  }
                                })();
                              });
                            }}
                          />
                          <span>
                            <span className="font-semibold text-amber-200">Futures · Autotrade with Supertrend</span>
                            <span className="mt-0.5 block text-[11px] text-slate-600 dark:text-slate-500">
                              Bar-close signals on USD-M; AI confidence and gates below apply when this is on.
                            </span>
                          </span>
                        </label>
                      </div>
                    ) : (
                      <label className="flex cursor-pointer items-start gap-2 text-xs">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={cfg.marketMode === "SPOT" ? cfg.supertrendSpotAuto : cfg.supertrendFuturesAuto}
                          onChange={(e) => {
                            const autoOn = e.currentTarget.checked;
                            const mm = cfg.marketMode;
                            deferTask(() => {
                              void (async () => {
                                try {
                                  if (mm === "SPOT") {
                                    await saveGatedBotConfig({ supertrendSpotAuto: autoOn });
                                    pushLog({
                                      level: "info",
                                      msg: autoOn
                                        ? "Supertrend spot autotrading ON — BUY uses ~all available spot quote; SELL closes full base on signal (bar close). Start the bot. AI path is paused."
                                        : "Supertrend spot autotrading OFF",
                                    });
                                  } else {
                                    await saveGatedBotConfig(
                                      autoOn
                                        ? { supertrendFuturesAuto: true }
                                        : { supertrendFuturesAuto: false, supertrendFuturesAiConfidenceFilter: true },
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
                          <span className={cfg.marketMode === "FUTURES" ? "font-semibold text-amber-200" : "font-semibold text-emerald-200"}>
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
                    )}
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
                                    await saveGatedBotConfig({ supertrendFuturesTwoWay: false });
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
                                    await saveGatedBotConfig({ supertrendFuturesTwoWay: true });
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
                    <div className="grid grid-cols-[110px_1fr] items-center gap-2 text-xs">
                      <span className="text-slate-600 dark:text-slate-400">ATR period</span>
                      <NumericTextInput
                        value={cfg.supertrendPeriod}
                        inputMode="numeric"
                        min={2}
                        max={100}
                        parse={(raw) => parseInt(raw, 10)}
                        disabled={
                          cfg.marketMode === "SPOT"
                            ? !cfg.supertrendSpotAuto
                            : cfg.marketMode === "FUTURES"
                              ? !cfg.supertrendFuturesAuto
                              : !cfg.supertrendSpotAuto && !cfg.supertrendFuturesAuto
                        }
                        onCommit={async (v) => {
                          try {
                            await saveGatedBotConfig({ supertrendPeriod: v });
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
                          cfg.marketMode === "SPOT"
                            ? !cfg.supertrendSpotAuto
                            : cfg.marketMode === "FUTURES"
                              ? !cfg.supertrendFuturesAuto
                              : !cfg.supertrendSpotAuto && !cfg.supertrendFuturesAuto
                        }
                        onCommit={async (v) => {
                          try {
                            await saveGatedBotConfig({ supertrendMultiplier: v });
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
                          cfg.marketMode === "SPOT"
                            ? !cfg.supertrendSpotAuto
                            : cfg.marketMode === "FUTURES"
                              ? !cfg.supertrendFuturesAuto
                              : !cfg.supertrendSpotAuto && !cfg.supertrendFuturesAuto
                        }
                        onChange={(e) => {
                          const checked = e.target.checked;
                          deferTask(() => {
                            void (async () => {
                              try {
                                await saveGatedBotConfig({ supertrendWilderAtr: checked });
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

                {(cfg.strategyMode === "AUTO" || cfg.manualStrategy === "SURF_PULSE_ML") && (
                  <div className="mt-3 rounded-md border border-slate-200/90 dark:border-slate-800/80 bg-white/85 dark:bg-slate-950/30 px-2 py-2">
                    <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">SurfPulse (#8) · XGBoost gate</div>
                    <p className="mt-0.5 text-[11px] leading-snug text-slate-600 dark:text-slate-500">
                      Minimum win probability from <span className="text-slate-600 dark:text-slate-400">/predict/surfpulse</span> to allow a SurfPulse
                      setup. In <span className="text-slate-600 dark:text-slate-400">AUTO</span> this applies when the regime picks path #8; in{" "}
                      <span className="text-slate-600 dark:text-slate-400">MANUAL</span> when #8 is your fixed path.
                    </p>
                    <div className="mt-2 flex items-center gap-2">
                      <label className="mr-2 inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-700 dark:text-slate-300">
                        <input
                          type="checkbox"
                          checked={cfg.surfPulseMlGateEnabled}
                          onChange={(e) => {
                            const on = e.currentTarget.checked;
                            deferTask(() => {
                              void api
                                .botConfig({ surfPulseMlGateEnabled: on })
                                .then(() => {
                                  pushLog({
                                    level: "info",
                                    msg: on ? "SurfPulse ML gate enabled" : "SurfPulse ML gate disabled",
                                  });
                                })
                                .catch(() => {
                                  pushLog({ level: "error", msg: "Failed to update SurfPulse gate toggle" });
                                });
                            });
                          }}
                        />
                        Enable
                      </label>
                      <span className="w-[7.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Min SurfPulse</span>
                      <ThresholdSliderWithLock
                        ariaLabel="Minimum SurfPulse ML win probability (percent)"
                        serverSliderUnits={Math.round(cfg.surfPulseMlThreshold * 100)}
                        formatDisplay={(u) => `${u}%`}
                        disabled={!cfg.surfPulseMlGateEnabled}
                        onDebouncedCommit={(u) => {
                          const p = clampNum(u / 100, 0, 1);
                          void saveGatedBotConfig({ surfPulseMlThreshold: Number(p.toFixed(3)) }).catch(() => {
                            pushLog({ level: "error", msg: "Failed to set SurfPulse threshold" });
                          });
                        }}
                      />
                    </div>
                  </div>
                )}

                <div className="mt-3 rounded-md border border-violet-800/25 bg-white/85 px-2 py-2 dark:border-violet-400/20 dark:bg-slate-950/50">
                  <div className="text-xs font-semibold text-violet-900 dark:text-violet-100">Market Intelligence</div>
                  <p className="mt-0.5 text-[11px] leading-snug text-slate-600 dark:text-slate-500">
                    Layered signals under the chart order book on this instance view. Live updates via WebSocket. The gate affects Supertrend bar-close opens only when enabled (
                    server default off via <span className="font-mono text-[10px]">INTELLIGENCE_GATE_ENABLED</span>).
                  </p>
                  <label className="mt-2 flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={showMarketIntelligencePanel}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        setShowMarketIntelligencePanel(on);
                        pushLog({
                          level: "info",
                          msg: on ? "Market Intelligence panel shown under chart order book" : "Market Intelligence panel hidden",
                        });
                      }}
                    />
                    <span className="min-w-0 flex-1 text-xs leading-snug text-slate-700 dark:text-slate-300">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">Show panel under chart (order book)</span>
                      <span className="mt-0.5 block text-[11px] text-slate-600 dark:text-slate-500">
                        Tracks the chart symbol when you switch tabs; polls periodically if WS misses a beat.
                      </span>
                    </span>
                  </label>
                  <label className="mt-2 flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={cfg.intelligenceGateEnabled}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        deferTask(() => {
                          void api
                            .botConfig({ intelligenceGateEnabled: on })
                            .then(() => {
                              pushLog({
                                level: "info",
                                msg: on ? "Market intelligence gate enabled for Supertrend opens" : "Market intelligence gate disabled",
                              });
                            })
                            .catch(() => {
                              pushLog({ level: "error", msg: "Failed to update intelligence gate" });
                            });
                        });
                      }}
                    />
                    <span className="min-w-0 flex-1 text-xs leading-snug text-slate-700 dark:text-slate-300">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">Intelligence gate on Supertrend opens</span>
                      <span className="mt-0.5 block text-[11px] text-slate-600 dark:text-slate-500">
                        High-confidence opposing composite score blocks the open. Independent from showing the panel.
                      </span>
                    </span>
                  </label>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <TrendHtfStPresetButton
                      label="★ ST + Intel 80% WR"
                      highlight
                      patch={SUPERTREND_INTEL_80WR}
                      pushLog={pushLog}
                    />
                    <TrendHtfStPresetButton
                      label="ST + Intel + Trail"
                      patch={SUPERTREND_INTEL_TRAIL}
                      pushLog={pushLog}
                    />
                  </div>
                  <p className="mt-1 text-[10px] text-amber-800 dark:text-amber-300">
                    <b>80% WR preset:</b> MANUAL + SUPERTREND + intel gate + SL 1.5% / TP 0.7% — validated BNBUSDT 15m Jan–May 2026:
                    ~87% WR, ~+18% return (15 trades). Sweep did not find 1000%+ return at WR≥80%; use for high WR, not max compounding.
                  </p>
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
                                await saveGatedBotConfig({ supertrendFuturesAiConfidenceFilter: filterOn });
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
                          void saveGatedBotConfig({ supertrendFuturesMinAiProb: Number(p.toFixed(3)) }).catch(() => {
                            pushLog({ level: "error", msg: "Failed to set min AI probability" });
                          });
                        }}
                      />
                    </div>
                  </div>
                )}

                <div className="mt-3 space-y-2 rounded-lg border border-indigo-800/20 bg-white/85 p-2 dark:border-indigo-400/15 dark:bg-slate-950/50">
                  <div className="text-[11px] font-semibold text-indigo-900 dark:text-indigo-100">Indicator-style signal sources</div>
                  <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-400">
                    Numbered paths the regime engine uses in <span className="font-medium text-slate-700 dark:text-slate-300">AUTO</span>, or the single
                    pinned path in <span className="font-medium text-slate-700 dark:text-slate-300">MANUAL</span>. They are not separate saved strategies — your{" "}
                    <span className="font-medium">strategy version</span> stores routing (above) plus all gates and execution settings here.
                  </p>
                  <ol className="list-decimal space-y-1 pl-4 text-[10px] text-slate-700 dark:text-slate-300">
                    {[...NUMBERED_SIGNAL_SOURCES].sort((a, b) => a.n - b.n).map((s) => (
                      <li key={s.key}>
                        <span className="font-mono text-[10px] text-slate-600 dark:text-slate-400">{s.key}</span> — {s.label}
                      </li>
                    ))}
                  </ol>
                </div>

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
                              await saveGatedBotConfig({ signalStrengthGatesTrades: gatesOn });
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
                        void saveGatedBotConfig({ signalStrengthOpenMin: Math.round(clampNum(u, 0, 100)) }).catch(() => {
                          pushLog({ level: "error", msg: "Failed to set min signal strength" });
                        });
                      }}
                    />
                  </div>
                </div>

                <div className="mt-3 space-y-2 rounded-lg border border-violet-800/25 bg-white/85 p-2 dark:border-violet-400/20 dark:bg-slate-950/50">
                  <div className="text-[11px] font-semibold text-violet-900 dark:text-violet-100">
                    Market decision (regime · chop · score · fees)
                  </div>
                  <label className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={cfg.marketDecisionEnabled}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        deferTask(() => {
                          void (async () => {
                            try {
                              await saveGatedBotConfig({ marketDecision: { enabled: on } });
                              pushLog({
                                level: "info",
                                msg: on
                                  ? "Market decision engine ON — multi-coin snapshots use regime + fee gate (see tabs)"
                                  : "Market decision engine OFF — snapshots still show ALLOW/BLOCK/WAIT (hypothetical if enabled); filters not applied; supertrend Action stays authoritative",
                              });
                            } catch {
                              pushLog({ level: "error", msg: "Failed to update market decision config" });
                            }
                          })();
                        });
                      }}
                    />
                    <span className="min-w-0 flex-1 text-xs leading-snug text-slate-700 dark:text-slate-300">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        Enable regime + signal-quality pipeline
                      </span>
                      <span className="mt-0.5 block text-[11px] text-slate-600 dark:text-slate-500">
                        Server evaluates ADX/EMA regime, chop, composite score, entry timing, and fee vs expected move on each multi-coin bar-close
                        snapshot. Default off; does not replace the legacy signal-strength / move-quality engines.
                      </span>
                    </span>
                  </label>
                  <MarketDecisionConfigPanel
                    md={cfg.marketDecisionMerged}
                    onPatch={(patch) => {
                      const prev =
                        bot?.marketDecision != null && typeof bot.marketDecision === "object"
                          ? { ...(bot.marketDecision as Record<string, unknown>) }
                          : {};
                      void api
                        .botConfig({ marketDecision: { ...prev, ...patch } as Record<string, unknown> })
                        .catch(() => {
                          pushLog({ level: "error", msg: "Failed to update market decision layers" });
                        });
                    }}
                  />
                </div>
                <div className="mt-3 space-y-2 rounded-lg border border-cyan-800/25 bg-white/85 p-2 dark:border-cyan-400/20 dark:bg-slate-950/50">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold text-cyan-900 dark:text-cyan-100">
                      Move quality (ATR · ADX · body)
                    </div>
                    <button
                      type="button"
                      disabled={mqTuneBusy}
                      className="shrink-0 rounded-md border border-cyan-700/40 bg-cyan-50/90 px-2 py-1 text-[11px] font-semibold text-cyan-900 hover:bg-cyan-100/90 disabled:opacity-50 dark:border-cyan-500/35 dark:bg-cyan-950/40 dark:text-cyan-100 dark:hover:bg-cyan-900/50"
                      title="Suggest thresholds from logged Supertrend outcomes (mq-trade-outcomes.jsonl) and apply"
                      onClick={() => {
                        deferTask(() => {
                          void (async () => {
                            setMqTuneBusy(true);
                            try {
                              const data = await api.botTuneMoveQuality({ apply: true });
                              if (data?.ok) {
                                pushLog({ level: "info", msg: data.message || "Move quality tuned" });
                                const p = data.patch as Record<string, unknown> | undefined;
                                if (p) {
                                  pushLog({
                                    level: "info",
                                    msg: `Applied: score≥${Number(p.supertrendMoveQualityMinScore).toFixed(3)} ADX≥${String(p.supertrendMoveQualityMinAdx)} move/SL≥${Number(p.supertrendMoveQualityMinMoveSlRatio).toFixed(2)} ATR exp≥${Number(p.supertrendMoveQualityMinAtrExpansion).toFixed(3)} body≥${Number(p.supertrendMoveQualityMinBodyVsAvg).toFixed(3)} (${data.n} trades, ${data.nWins} wins)`,
                                  });
                                }
                              } else {
                                pushLog({
                                  level: "warn",
                                  msg: (data as { message?: string })?.message || "Tune failed",
                                });
                              }
                            } catch (e) {
                              pushLog({ level: "warn", msg: String((e as Error)?.message || e) });
                            } finally {
                              setMqTuneBusy(false);
                            }
                          })();
                        });
                      }}
                    >
                      {mqTuneBusy ? "Tuning…" : "Tune"}
                    </button>
                  </div>
                  <label className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={cfg.supertrendMoveQualityGate}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        deferTask(() => {
                          void (async () => {
                            try {
                              await saveGatedBotConfig({ supertrendMoveQualityGate: on });
                              pushLog({
                                level: "info",
                                msg: on
                                  ? "Move quality gate ON — opens require composite score + ATR/SL ratio + ADX/body checks (see thresholds below)"
                                  : "Move quality gate OFF — scores still appear in chart signal list for analysis",
                              });
                            } catch {
                              pushLog({ level: "error", msg: "Failed to update move quality gate" });
                            }
                          })();
                        });
                      }}
                    />
                    <span className="min-w-0 flex-1 text-xs leading-snug text-slate-700 dark:text-slate-300">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        Gate opens on move quality
                      </span>
                      <span className="mt-0.5 block text-[11px] text-slate-600 dark:text-slate-500">
                        Applies to live opens and backtests. Uses ATR-based expected move vs estimated SL%, ADX, body vs average, optional ATR expansion, directional body and volume.
                        When off, MQ is still computed and shown in the chart signal list (MQ score · verdict).
                      </span>
                    </span>
                  </label>
                  <div className="grid gap-2 pl-6 sm:grid-cols-2">
                    <div className="flex items-center gap-2">
                      <span className="w-[8.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Min score (0–1)</span>
                      <ThresholdSliderWithLock
                        ariaLabel="Minimum move quality composite score"
                        serverSliderUnits={Math.round(cfg.supertrendMoveQualityMinScore * 100)}
                        formatDisplay={(u) => `${(u / 100).toFixed(2)}`}
                        accentClassName="accent-cyan-600"
                        onDebouncedCommit={(u) => {
                          const p = clampNum(u / 100, 0, 1);
                          void saveGatedBotConfig({ supertrendMoveQualityMinScore: Number(p.toFixed(3)) }).catch(() => {
                            pushLog({ level: "error", msg: "Failed to set min move quality score" });
                          });
                        }}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-[8.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Min ADX</span>
                      <ThresholdSliderWithLock
                        ariaLabel="Minimum ADX at signal bar"
                        serverSliderUnits={cfg.supertrendMoveQualityMinAdx}
                        formatDisplay={(u) => `${u}`}
                        accentClassName="accent-cyan-600"
                        onDebouncedCommit={(u) => {
                          void saveGatedBotConfig({ supertrendMoveQualityMinAdx: Math.round(clampNum(u, 0, 100)) }).catch(() => {
                            pushLog({ level: "error", msg: "Failed to set min ADX" });
                          });
                        }}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-[8.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Move vs SL ×</span>
                      <ThresholdSliderWithLock
                        ariaLabel="Expected move must exceed SL% times this ratio"
                        serverSliderUnits={Math.round((cfg.supertrendMoveQualityMinMoveSlRatio - 1) * 20)}
                        formatDisplay={(u) => `${(1 + u / 20).toFixed(2)}×`}
                        accentClassName="accent-cyan-600"
                        onDebouncedCommit={(u) => {
                          const r = Math.max(1, 1 + u / 20);
                          void saveGatedBotConfig({ supertrendMoveQualityMinMoveSlRatio: Number(r.toFixed(2)) }).catch(() => {
                            pushLog({ level: "error", msg: "Failed to set move/SL ratio" });
                          });
                        }}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-[8.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">ATR expect mult</span>
                      <ThresholdSliderWithLock
                        ariaLabel="Expected move = ATR% × this; 1.0 = raw ATR% vs SL (no inflation)"
                        serverSliderUnits={Math.round(cfg.supertrendMoveQualityExpectedMoveAtrMult * 20)}
                        formatDisplay={(u) => `${(u / 20).toFixed(2)}×`}
                        accentClassName="accent-cyan-600"
                        onDebouncedCommit={(u) => {
                          const m = Math.max(0.1, u / 20);
                          void saveGatedBotConfig({ supertrendMoveQualityExpectedMoveAtrMult: Number(m.toFixed(2)) }).catch(() => {
                            pushLog({ level: "error", msg: "Failed to set ATR expect mult" });
                          });
                        }}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-[8.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Min ATR expand</span>
                      <ThresholdSliderWithLock
                        ariaLabel="0 = off; else ATR/avgATR must exceed"
                        serverSliderUnits={cfg.supertrendMoveQualityMinAtrExpansion >= 1 ? Math.round((cfg.supertrendMoveQualityMinAtrExpansion - 1) * 100) : 0}
                        formatDisplay={(u) => (u <= 0 ? "off" : `${(1 + u / 100).toFixed(2)}×`)}
                        accentClassName="accent-cyan-600"
                        onDebouncedCommit={(u) => {
                          const v = u <= 0 ? 0 : 1 + u / 100;
                          void saveGatedBotConfig({ supertrendMoveQualityMinAtrExpansion: Number(v.toFixed(3)) }).catch(() => {
                            pushLog({ level: "error", msg: "Failed to set min ATR expansion" });
                          });
                        }}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-[8.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Min body vs avg</span>
                      <ThresholdSliderWithLock
                        ariaLabel="Signal bar body / avg body"
                        serverSliderUnits={Math.round(cfg.supertrendMoveQualityMinBodyVsAvg * 100)}
                        formatDisplay={(u) => `${(u / 100).toFixed(2)}`}
                        accentClassName="accent-cyan-600"
                        onDebouncedCommit={(u) => {
                          const p = clampNum(u / 100, 0.15, 1);
                          void saveGatedBotConfig({ supertrendMoveQualityMinBodyVsAvg: Number(p.toFixed(3)) }).catch(() => {
                            pushLog({ level: "error", msg: "Failed to set min body ratio" });
                          });
                        }}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-[8.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Dir. body (0=off)</span>
                      <ThresholdSliderWithLock
                        ariaLabel="Signed candle body vs range; 0 disables"
                        serverSliderUnits={Math.round(cfg.supertrendMoveQualityMinDirectionalBody * 100)}
                        formatDisplay={(u) => (u <= 0 ? "off" : `${(u / 100).toFixed(2)}`)}
                        accentClassName="accent-cyan-600"
                        onDebouncedCommit={(u) => {
                          const p = clampNum(u / 100, 0, 1);
                          void api
                            .botConfig({ supertrendMoveQualityMinDirectionalBody: Number(p.toFixed(3)) })
                            .catch(() => {
                              pushLog({ level: "error", msg: "Failed to set directional body min" });
                            });
                        }}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-[8.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Vol vs avg (0=off)</span>
                      <ThresholdSliderWithLock
                        ariaLabel="Last vol ≥ SMA×this; 0 disables"
                        serverSliderUnits={Math.round(Math.max(0, cfg.supertrendMoveQualityMinVolumeVsAvg - 1) * 100)}
                        formatDisplay={(u) => (u <= 0 ? "off" : `${(1 + u / 100).toFixed(2)}×`)}
                        accentClassName="accent-cyan-600"
                        onDebouncedCommit={(u) => {
                          const v = u <= 0 ? 0 : 1 + u / 100;
                          void saveGatedBotConfig({ supertrendMoveQualityMinVolumeVsAvg: Number(v.toFixed(3)) }).catch(() => {
                            pushLog({ level: "error", msg: "Failed to set volume vs avg min" });
                          });
                        }}
                      />
                  </div>
                </div>
                </div>

                <div className="mt-3 space-y-2 rounded-lg border border-emerald-800/30 bg-white/85 p-2 dark:border-emerald-400/25 dark:bg-slate-950/50">
                  <div className="text-[11px] font-semibold text-emerald-900 dark:text-emerald-100">
                    Big-move filter (Supertrend + T1)
                  </div>
                  <label className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={cfg.supertrendBigMoveGateEnabled}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        deferTask(() => {
                          void (async () => {
                            try {
                              await saveGatedBotConfig({ supertrendBigMoveGateEnabled: on });
                              pushLog({
                                level: "info",
                                msg: on
                                  ? "Big-move gate ON — ST opens need signal strength + expected move ≥ T1 (1.5× SL); replaces separate strength/MQ gates"
                                  : "Big-move gate OFF — use Signal strength / Move quality gates individually",
                              });
                            } catch {
                              pushLog({ level: "error", msg: "Failed to update big-move gate" });
                            }
                          })();
                        });
                      }}
                    />
                    <span className="min-w-0 flex-1 text-xs leading-snug text-slate-700 dark:text-slate-300">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        Gate Supertrend on big-move + T1 potential
                      </span>
                      <span className="mt-0.5 block text-[11px] text-slate-600 dark:text-slate-500">
                        Indicator-section filter coupled to Supertrend (not Intelligence gate). Blocks weak flips and entries where
                        ATR-based expected move is below T1. Backtests use the same logic.
                      </span>
                    </span>
                  </label>
                  <div className="grid gap-2 pl-6 sm:grid-cols-2">
                    <div className="flex items-center gap-2">
                      <span className="w-[8.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Min strength</span>
                      <ThresholdSliderWithLock
                        ariaLabel="Minimum signal strength for big-move gate"
                        serverSliderUnits={cfg.supertrendBigMoveMinStrength}
                        formatDisplay={(u) => `${u}`}
                        accentClassName="accent-emerald-600"
                        onDebouncedCommit={(u) => {
                          void api
                            .botConfig({ supertrendBigMoveMinStrength: Math.round(clampNum(u, 0, 100)) })
                            .catch(() => pushLog({ level: "error", msg: "Failed to set big-move min strength" }));
                        }}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-[8.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Move / SL (T1)</span>
                      <ThresholdSliderWithLock
                        ariaLabel="Min expected move vs SL ratio (1.5 = T1)"
                        serverSliderUnits={Math.round((cfg.supertrendBigMoveMinMoveSlRatio - 1) * 100)}
                        formatDisplay={(u) => `${(1 + u / 100).toFixed(2)}×`}
                        accentClassName="accent-emerald-600"
                        onDebouncedCommit={(u) => {
                          void api
                            .botConfig({ supertrendBigMoveMinMoveSlRatio: Math.max(1, 1 + u / 100) })
                            .catch(() => pushLog({ level: "error", msg: "Failed to set big-move move/SL ratio" }));
                        }}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-[8.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Min ADX</span>
                      <ThresholdSliderWithLock
                        ariaLabel="Minimum ADX for big-move gate"
                        serverSliderUnits={cfg.supertrendBigMoveMinAdx}
                        formatDisplay={(u) => `${u}`}
                        accentClassName="accent-emerald-600"
                        onDebouncedCommit={(u) => {
                          void api
                            .botConfig({ supertrendBigMoveMinAdx: Math.round(clampNum(u, 0, 100)) })
                            .catch(() => pushLog({ level: "error", msg: "Failed to set big-move min ADX" }));
                        }}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-[8.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Min MQ score</span>
                      <ThresholdSliderWithLock
                        ariaLabel="Minimum move-quality composite score"
                        serverSliderUnits={Math.round(cfg.supertrendBigMoveMinScore * 100)}
                        formatDisplay={(u) => `${(u / 100).toFixed(2)}`}
                        accentClassName="accent-emerald-600"
                        onDebouncedCommit={(u) => {
                          const p = clampNum(u / 100, 0, 1);
                          void api
                            .botConfig({ supertrendBigMoveMinScore: Number(p.toFixed(3)) })
                            .catch(() => pushLog({ level: "error", msg: "Failed to set big-move min score" }));
                        }}
                      />
                    </div>
                  </div>
                </div>

                <div className="mt-3 space-y-2 rounded-lg border border-teal-800/30 bg-white/85 p-2 dark:border-teal-400/25 dark:bg-slate-950/50">
                  <div className="text-[11px] font-semibold text-teal-900 dark:text-teal-100">
                    4H Supertrend confirmation
                  </div>
                  <label className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={cfg.supertrendHtf4hEnabled}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        deferTask(() => {
                          void (async () => {
                            try {
                              await saveGatedBotConfig({ supertrendHtf4hEnabled: on });
                              pushLog({
                                level: "info",
                                msg: on
                                  ? "4H ST confirmation ON — BUY entries require 4H ST bullish; SELL require 4H ST bearish"
                                  : "4H ST confirmation OFF — entries not filtered by higher timeframe direction",
                              });
                            } catch {
                              pushLog({ level: "error", msg: "Failed to update 4H confirmation" });
                            }
                          })();
                        });
                      }}
                    />
                    <span className="min-w-0 flex-1 text-xs leading-snug text-slate-700 dark:text-slate-300">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        Require 4H Supertrend alignment
                      </span>
                      <span className="mt-0.5 block text-[11px] text-slate-600 dark:text-slate-500">
                        Blocks a Supertrend open when the 4H ST direction disagrees — e.g. no BUY if the 4H trend is
                        bearish. Works in backtests and live. Same ST period/multiplier as below.
                      </span>
                    </span>
                  </label>
                  <div className="grid gap-2 pl-6 sm:grid-cols-2">
                    <div className="flex items-center gap-2">
                      <span className="w-[7.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">4H ST period</span>
                      <ThresholdSliderWithLock
                        ariaLabel="4H Supertrend period"
                        serverSliderUnits={cfg.supertrendHtf4hPeriod}
                        formatDisplay={(u) => `${u}`}
                        accentClassName="accent-teal-600"
                        onDebouncedCommit={(u) => {
                          void api
                            .botConfig({ supertrendHtf4hPeriod: Math.max(2, Math.min(50, Math.round(u))) })
                            .catch(() => pushLog({ level: "error", msg: "Failed to set 4H ST period" }));
                        }}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-[7.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">4H ST multiplier</span>
                      <ThresholdSliderWithLock
                        ariaLabel="4H Supertrend multiplier"
                        serverSliderUnits={Math.round(cfg.supertrendHtf4hMultiplier * 10)}
                        formatDisplay={(u) => `${(u / 10).toFixed(1)}`}
                        accentClassName="accent-teal-600"
                        onDebouncedCommit={(u) => {
                          void api
                            .botConfig({ supertrendHtf4hMultiplier: Math.max(0.5, u / 10) })
                            .catch(() => pushLog({ level: "error", msg: "Failed to set 4H ST multiplier" }));
                        }}
                      />
                    </div>
                  </div>
                </div>

                <div className="mt-3 space-y-2 rounded-lg border border-fuchsia-800/30 bg-white/85 p-2 dark:border-fuchsia-400/25 dark:bg-slate-950/50">
                  <div className="text-[11px] font-semibold text-fuchsia-900 dark:text-fuchsia-100">
                    Volume Profile (POC / VAH / VAL / HVN)
                  </div>
                  <label className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={cfg.volumeProfileEnabled}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        deferTask(() => {
                          void (async () => {
                            try {
                              await saveGatedBotConfig({ volumeProfileEnabled: on });
                              pushLog({
                                level: "info",
                                msg: on
                                  ? "Volume Profile ON — POC/VAH/VAL scoring for SR Intraday / Intraday Pro"
                                  : "Volume Profile OFF — no VP structure filter on intraday signals",
                              });
                            } catch {
                              pushLog({ level: "error", msg: "Failed to update Volume Profile" });
                            }
                          })();
                        });
                      }}
                    />
                    <span className="min-w-0 flex-1 text-xs leading-snug text-slate-700 dark:text-slate-300">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">Enable Volume Profile</span>
                      <span className="mt-0.5 block text-[11px] text-slate-600 dark:text-slate-500">
                        Primary: <span className="font-mono">VOLUME_PROFILE</span> manual strategy (#18). For intraday confluence use{" "}
                        <span className="font-semibold">Intraday gates → Volume profile filter</span> above.
                      </span>
                    </span>
                  </label>
                  <div
                    className={`space-y-2 pl-6 ${
                      cfg.volumeProfileEnabled && cfg.manualStrategy === "VOLUME_PROFILE"
                        ? ""
                        : cfg.volumeProfileEnabled
                          ? ""
                          : "opacity-50 pointer-events-none"
                    }`}
                  >
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                      <input
                        type="checkbox"
                        checked={cfg.volumeProfileSoftGates && !cfg.volumeProfileGatesEnabled}
                        disabled={!cfg.volumeProfileEnabled}
                        onChange={(e) => {
                          const soft = e.currentTarget.checked;
                          deferTask(() => {
                            void api
                              .botConfig({
                                volumeProfileSoftGates: soft,
                                volumeProfileGatesEnabled: !soft,
                              })
                              .then(() =>
                                pushLog({
                                  level: "info",
                                  msg: soft
                                    ? "VP soft gates — score penalties, rare hard blocks only"
                                    : "VP strict gates — hard veto on VAH/VAL/POC/RR issues",
                                }),
                              )
                              .catch(() => pushLog({ level: "error", msg: "Failed to update VP gate mode" }));
                          });
                        }}
                      />
                      Soft gates (recommended) — penalize weak structure instead of blocking every signal
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-700 dark:text-slate-300">
                      <input
                        type="checkbox"
                        checked={cfg.intradayVpBrackets}
                        disabled={!cfg.intradayGateVp && !cfg.volumeProfileEnabled}
                        onChange={(e) => {
                          const on = e.currentTarget.checked;
                          deferTask(() => {
                            void api
                              .botConfig({ intradayVpBrackets: on })
                              .then(() =>
                                pushLog({
                                  level: "info",
                                  msg: on
                                    ? "VP structure SL/TP at HVN nodes (backtest + intraday)"
                                    : "VP brackets off — use fixed SL/TP %",
                                }),
                              )
                              .catch(() => pushLog({ level: "error", msg: "Failed to update VP brackets" }));
                          });
                        }}
                      />
                      Structure SL/TP at next HVN (instead of fixed %)
                    </label>
                    <div className="flex items-center gap-2">
                      <span className="w-[8.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Lookback (bars)</span>
                      <ThresholdSliderWithLock
                        ariaLabel="Volume profile lookback bars"
                        serverSliderUnits={cfg.vpLookbackBars}
                        formatDisplay={(u) => `${u}`}
                        accentClassName="accent-fuchsia-600"
                        disabled={!cfg.volumeProfileEnabled}
                        onDebouncedCommit={(u) => {
                          void api
                            .botConfig({ vpLookbackBars: Math.round(clampNum(u, 48, 2000)) })
                            .catch(() => pushLog({ level: "error", msg: "Failed to set VP lookback" }));
                        }}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-[8.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Min RR</span>
                      <ThresholdSliderWithLock
                        ariaLabel="Minimum risk-reward to next HVN"
                        serverSliderUnits={Math.round(cfg.vpMinRR * 100)}
                        formatDisplay={(u) => `${(u / 100).toFixed(2)}×`}
                        accentClassName="accent-fuchsia-600"
                        disabled={!cfg.volumeProfileEnabled}
                        onDebouncedCommit={(u) => {
                          void api
                            .botConfig({ vpMinRR: Math.max(0.8, u / 100) })
                            .catch(() => pushLog({ level: "error", msg: "Failed to set VP min RR" }));
                        }}
                      />
                    </div>
                  </div>
                </div>

                {/* ─── SUPERTREND_ELITE gate controls ─── */}
                {cfg.manualStrategy === "SUPERTREND_ELITE" && (
                  <div className="mt-3 space-y-2 rounded-lg border border-violet-600/40 bg-white/85 p-2 dark:border-violet-400/30 dark:bg-slate-950/50">
                    <div className="flex items-center gap-1.5">
                      <div className="text-[11px] font-semibold text-violet-800 dark:text-violet-300">
                        Supertrend Elite — 5-gate filters
                      </div>
                      <span className="rounded bg-violet-100 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                        1H TF recommended
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-500 dark:text-slate-500">
                      Use on 1H timeframe. Best results: BNBUSDT 73% WR +22% · BTCUSDT 64% WR +62% (Jan–May 2026, trailing stop)
                    </p>

                    {/* Gate 4 — 4H Supertrend alignment */}
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={cfg.eliteStRequireHtf4hAlign}
                        onChange={(e) => {
                          const on = e.currentTarget.checked;
                          deferTask(() => {
                            void saveGatedBotConfig({ eliteStRequireHtf4hAlign: on }).catch(() =>
                              pushLog({ level: "error", msg: "Failed to update 4H gate" }));
                          });
                        }}
                      />
                      <span className="min-w-0 flex-1 text-xs leading-snug text-slate-700 dark:text-slate-300">
                        <span className="font-semibold">Gate 4 — 4H ST alignment</span>
                        <span className="mt-0.5 block text-[10px] text-slate-500">
                          Block entries when 4H Supertrend disagrees with primary signal direction.
                        </span>
                      </span>
                    </label>

                    {/* Gate 3 — 1H EMA structure */}
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={cfg.eliteStRequireHtf1hEmaAlign}
                        onChange={(e) => {
                          const on = e.currentTarget.checked;
                          deferTask(() => {
                            void saveGatedBotConfig({ eliteStRequireHtf1hEmaAlign: on }).catch(() =>
                              pushLog({ level: "error", msg: "Failed to update 1H EMA gate" }));
                          });
                        }}
                      />
                      <span className="min-w-0 flex-1 text-xs leading-snug text-slate-700 dark:text-slate-300">
                        <span className="font-semibold">
                          Gate 3 — 1H EMA21/50 structure
                          {cfg.eliteStHtf1hSepMode !== "FIXED" ? ` (${cfg.eliteStHtf1hSepMode} sep)` : ""}
                        </span>
                        <span className="mt-0.5 block text-[10px] text-slate-500">
                          Block BUY when 1H EMA21 &lt; EMA50 (bearish structure). Block SELL when EMA21 &gt; EMA50.
                          Requires |EMA21−EMA50|/EMA50 ≥ min separation.
                        </span>
                      </span>
                    </label>

                    <label className="ml-6 flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={cfg.eliteStAutoCalibrate}
                        onChange={(e) => {
                          const on = e.currentTarget.checked;
                          deferTask(() => {
                            void saveGatedBotConfig({
                              eliteStAutoCalibrate: on,
                              ...(on ? { eliteStAutoFullTune: true, eliteStAutoBracketMode: "ATR" } : {}),
                            }).catch(() =>
                              pushLog({ level: "error", msg: "Failed to update auto-calibrate" }),
                            );
                          });
                        }}
                      />
                      <span className="min-w-0 flex-1 text-xs leading-snug text-slate-700 dark:text-slate-300">
                        <span className="font-semibold">Auto-calibrate for any coin</span>
                        <span className="mt-0.5 block text-[10px] text-slate-500">
                          Derives gate thresholds and ATR brackets from warmup bars per symbol. No BTC/BNB hardcoding.
                        </span>
                      </span>
                    </label>

                    {cfg.eliteStRequireHtf1hEmaAlign ? (
                      <div className="ml-6 space-y-2 rounded-md border border-slate-200/80 bg-slate-50/60 p-2 dark:border-slate-700/50 dark:bg-slate-900/40">
                        {cfg.eliteStAutoCalibrate ? (
                          <p className="text-[10px] text-emerald-700 dark:text-emerald-400">
                            Auto on — sep mode, ST bands, and brackets scale from each coin&apos;s volatility profile (no per-coin presets).
                          </p>
                        ) : null}
                        <label className="flex flex-col gap-0.5">
                          <span className="text-[10px] font-semibold uppercase text-slate-600 dark:text-slate-400">
                            Min-separation mode
                          </span>
                          <select
                            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-600 dark:bg-slate-950"
                            value={cfg.eliteStHtf1hSepMode}
                            onChange={(e) => {
                              const mode = e.currentTarget.value;
                              deferTask(() => {
                                void saveGatedBotConfig({ eliteStHtf1hSepMode: mode }).catch(() =>
                                  pushLog({ level: "error", msg: "Failed to update sep mode" }),
                                );
                              });
                            }}
                          >
                            <option value="FIXED">FIXED — constant % (BTC/BNB overrides when symbol matches)</option>
                            <option value="ATR">ATR — k × (ATR₁ₕ / price), clamped</option>
                            <option value="PERCENTILE">PERCENTILE — median of recent 1H EMA sep</option>
                            <option value="ADX">ADX — tighter in chop, looser in trends (recommended)</option>
                            <option value="CALIBRATED">CALIBRATED — warmup percentile, then constant</option>
                          </select>
                          <span className="text-[10px] text-slate-500">
                            Dynamic modes scale per coin automatically — no per-symbol hardcoding.
                          </span>
                        </label>

                        {cfg.eliteStHtf1hSepMode === "FIXED" ? (
                          <label className="flex items-center gap-2">
                            <span className="w-[7.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">
                              Min sep %
                            </span>
                            <input
                              type="number"
                              step={0.0001}
                              min={0}
                              max={0.01}
                              className="w-24 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs dark:border-slate-600 dark:bg-slate-950"
                              value={cfg.eliteStHtf1hMinSep}
                              onChange={(e) => {
                                const v = Math.max(0, Number(e.currentTarget.value));
                                deferTask(() => {
                                  void saveGatedBotConfig({ eliteStHtf1hMinSep: v }).catch(() =>
                                    pushLog({ level: "error", msg: "Failed to update min sep" }),
                                  );
                                });
                              }}
                            />
                            <span className="text-[10px] text-slate-500">
                              ({(cfg.eliteStHtf1hMinSep * 100).toFixed(3)}%)
                            </span>
                          </label>
                        ) : null}

                        {cfg.eliteStHtf1hSepMode === "ATR" ? (
                          <label className="flex items-center gap-2">
                            <span className="w-[7.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">
                              ATR mult (k)
                            </span>
                            <input
                              type="number"
                              step={0.05}
                              min={0.05}
                              max={2}
                              className="w-24 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs dark:border-slate-600 dark:bg-slate-950"
                              value={cfg.eliteStHtf1hMinSepAtrMult}
                              onChange={(e) => {
                                const v = clampNum(Number(e.currentTarget.value), 0.05, 2);
                                deferTask(() => {
                                  void saveGatedBotConfig({ eliteStHtf1hMinSepAtrMult: v }).catch(() =>
                                    pushLog({ level: "error", msg: "Failed to update ATR mult" }),
                                  );
                                });
                              }}
                            />
                          </label>
                        ) : null}

                        {cfg.eliteStHtf1hSepMode === "PERCENTILE" ? (
                          <div className="flex flex-wrap gap-3">
                            <label className="flex items-center gap-2">
                              <span className="w-[7.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">
                                Lookback
                              </span>
                              <input
                                type="number"
                                step={1}
                                min={20}
                                max={200}
                                className="w-20 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs dark:border-slate-600 dark:bg-slate-950"
                                value={cfg.eliteStHtf1hSepPercentileLookback}
                                onChange={(e) => {
                                  const v = clampNum(Math.round(Number(e.currentTarget.value)), 20, 200);
                                  deferTask(() => {
                                    void saveGatedBotConfig({ eliteStHtf1hSepPercentileLookback: v }).catch(() =>
                                      pushLog({ level: "error", msg: "Failed to update percentile lookback" }),
                                    );
                                  });
                                }}
                              />
                            </label>
                            <label className="flex items-center gap-2">
                              <span className="shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Mult</span>
                              <input
                                type="number"
                                step={0.1}
                                min={0.5}
                                max={3}
                                className="w-20 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs dark:border-slate-600 dark:bg-slate-950"
                                value={cfg.eliteStHtf1hSepPercentileMult}
                                onChange={(e) => {
                                  const v = clampNum(Number(e.currentTarget.value), 0.5, 3);
                                  deferTask(() => {
                                    void saveGatedBotConfig({ eliteStHtf1hSepPercentileMult: v }).catch(() =>
                                      pushLog({ level: "error", msg: "Failed to update percentile mult" }),
                                    );
                                  });
                                }}
                              />
                            </label>
                          </div>
                        ) : null}

                        {cfg.eliteStHtf1hSepMode === "ADX" ? (
                          <div className="flex flex-wrap gap-3">
                            <label className="flex items-center gap-2">
                              <span className="w-[7.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">
                                Base sep
                              </span>
                              <input
                                type="number"
                                step={0.0001}
                                min={0}
                                max={0.01}
                                className="w-24 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs dark:border-slate-600 dark:bg-slate-950"
                                value={cfg.eliteStHtf1hSepAdxBase}
                                onChange={(e) => {
                                  const v = clampNum(Number(e.currentTarget.value), 0, 0.01);
                                  deferTask(() => {
                                    void saveGatedBotConfig({ eliteStHtf1hSepAdxBase: v }).catch(() =>
                                      pushLog({ level: "error", msg: "Failed to update ADX base" }),
                                    );
                                  });
                                }}
                              />
                            </label>
                            <label className="flex items-center gap-2">
                              <span className="shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Alpha</span>
                              <input
                                type="number"
                                step={0.1}
                                min={0}
                                max={5}
                                className="w-20 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs dark:border-slate-600 dark:bg-slate-950"
                                value={cfg.eliteStHtf1hSepAdxAlpha}
                                onChange={(e) => {
                                  const v = clampNum(Number(e.currentTarget.value), 0, 5);
                                  deferTask(() => {
                                    void saveGatedBotConfig({ eliteStHtf1hSepAdxAlpha: v }).catch(() =>
                                      pushLog({ level: "error", msg: "Failed to update ADX alpha" }),
                                    );
                                  });
                                }}
                              />
                            </label>
                            <label className="flex items-center gap-2">
                              <span className="shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Ref ADX</span>
                              <input
                                type="number"
                                step={1}
                                min={1}
                                max={100}
                                className="w-20 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs dark:border-slate-600 dark:bg-slate-950"
                                value={cfg.eliteStHtf1hSepAdxRef}
                                onChange={(e) => {
                                  const v = clampNum(Math.round(Number(e.currentTarget.value)), 1, 100);
                                  deferTask(() => {
                                    void saveGatedBotConfig({ eliteStHtf1hSepAdxRef: v }).catch(() =>
                                      pushLog({ level: "error", msg: "Failed to update ADX ref" }),
                                    );
                                  });
                                }}
                              />
                            </label>
                          </div>
                        ) : null}

                        {cfg.eliteStHtf1hSepMode === "CALIBRATED" ? (
                          <div className="flex flex-wrap gap-3">
                            <label className="flex items-center gap-2">
                              <span className="w-[7.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">
                                Percentile
                              </span>
                              <input
                                type="number"
                                step={1}
                                min={1}
                                max={99}
                                className="w-20 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs dark:border-slate-600 dark:bg-slate-950"
                                value={cfg.eliteStHtf1hSepCalibratePct}
                                onChange={(e) => {
                                  const v = clampNum(Math.round(Number(e.currentTarget.value)), 1, 99);
                                  deferTask(() => {
                                    void saveGatedBotConfig({ eliteStHtf1hSepCalibratePct: v }).catch(() =>
                                      pushLog({ level: "error", msg: "Failed to update calibrate pct" }),
                                    );
                                  });
                                }}
                              />
                            </label>
                            <label className="flex items-center gap-2">
                              <span className="shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Warmup bars</span>
                              <input
                                type="number"
                                step={1}
                                min={20}
                                max={200}
                                className="w-20 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs dark:border-slate-600 dark:bg-slate-950"
                                value={cfg.eliteStHtf1hSepCalibrateBars}
                                onChange={(e) => {
                                  const v = clampNum(Math.round(Number(e.currentTarget.value)), 20, 200);
                                  deferTask(() => {
                                    void saveGatedBotConfig({ eliteStHtf1hSepCalibrateBars: v }).catch(() =>
                                      pushLog({ level: "error", msg: "Failed to update calibrate bars" }),
                                    );
                                  });
                                }}
                              />
                            </label>
                          </div>
                        ) : null}

                        {["ATR", "PERCENTILE", "CALIBRATED"].includes(cfg.eliteStHtf1hSepMode) ? (
                          <div className="flex flex-wrap gap-3">
                            <label className="flex items-center gap-2">
                              <span className="w-[7.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">
                                Floor %
                              </span>
                              <input
                                type="number"
                                step={0.0001}
                                min={0}
                                max={0.01}
                                className="w-24 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs dark:border-slate-600 dark:bg-slate-950"
                                value={cfg.eliteStHtf1hMinSepFloor}
                                onChange={(e) => {
                                  const v = clampNum(Number(e.currentTarget.value), 0, 0.01);
                                  deferTask(() => {
                                    void saveGatedBotConfig({ eliteStHtf1hMinSepFloor: v }).catch(() =>
                                      pushLog({ level: "error", msg: "Failed to update sep floor" }),
                                    );
                                  });
                                }}
                              />
                            </label>
                            <label className="flex items-center gap-2">
                              <span className="shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Ceil %</span>
                              <input
                                type="number"
                                step={0.0001}
                                min={0}
                                max={0.01}
                                className="w-24 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs dark:border-slate-600 dark:bg-slate-950"
                                value={cfg.eliteStHtf1hMinSepCeil}
                                onChange={(e) => {
                                  const v = clampNum(Number(e.currentTarget.value), 0, 0.01);
                                  deferTask(() => {
                                    void saveGatedBotConfig({ eliteStHtf1hMinSepCeil: v }).catch(() =>
                                      pushLog({ level: "error", msg: "Failed to update sep ceil" }),
                                    );
                                  });
                                }}
                              />
                            </label>
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {/* Gate 1 — ADX */}
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={cfg.eliteStMinAdx > 0}
                        onChange={(e) => {
                          const on = e.currentTarget.checked;
                          deferTask(() => {
                            void saveGatedBotConfig({ eliteStMinAdx: on ? 20 : 0, eliteStRequireAdxRising: on }).catch(() =>
                              pushLog({ level: "error", msg: "Failed to update ADX gate" }));
                          });
                        }}
                      />
                      <span className="min-w-0 flex-1 text-xs leading-snug text-slate-700 dark:text-slate-300">
                        <span className="font-semibold">Gate 1 — ADX ≥ {cfg.eliteStMinAdx || 20} rising</span>
                        <span className="mt-0.5 block text-[10px] text-slate-500">
                          Skip entries in low-trend / choppy markets. Adds selectivity; most impactful in trending conditions.
                        </span>
                      </span>
                    </label>
                    {cfg.eliteStMinAdx > 0 && (
                      <div className="flex items-center gap-2 pl-6">
                        <span className="w-[7.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Min ADX</span>
                        <ThresholdSliderWithLock
                          ariaLabel="Elite ST min ADX"
                          serverSliderUnits={cfg.eliteStMinAdx}
                          formatDisplay={(u) => `${u}`}
                          accentClassName="accent-violet-600"
                          onDebouncedCommit={(u) => {
                            void api
                              .botConfig({ eliteStMinAdx: clampNum(Math.round(u), 0, 100) })
                              .catch(() => pushLog({ level: "error", msg: "Failed to set Elite ST ADX" }));
                          }}
                        />
                      </div>
                    )}

                    {/* Gate 2 — Volume */}
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={cfg.eliteStMinVolumeVsAvg > 0}
                        onChange={(e) => {
                          const on = e.currentTarget.checked;
                          deferTask(() => {
                            void saveGatedBotConfig({ eliteStMinVolumeVsAvg: on ? 1.5 : 0 }).catch(() =>
                              pushLog({ level: "error", msg: "Failed to update volume gate" }));
                          });
                        }}
                      />
                      <span className="min-w-0 flex-1 text-xs leading-snug text-slate-700 dark:text-slate-300">
                        <span className="font-semibold">Gate 2 — Volume ≥ {cfg.eliteStMinVolumeVsAvg > 0 ? `${cfg.eliteStMinVolumeVsAvg.toFixed(1)}×` : "1.5×"} avg</span>
                        <span className="mt-0.5 block text-[10px] text-slate-500">
                          Require above-average volume on signal bar. Eliminates low-conviction breakouts.
                        </span>
                      </span>
                    </label>

                    {/* Gate 5 — ATR expansion */}
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={cfg.eliteStRequireAtrExpansion}
                        onChange={(e) => {
                          const on = e.currentTarget.checked;
                          deferTask(() => {
                            void saveGatedBotConfig({ eliteStRequireAtrExpansion: on }).catch(() =>
                              pushLog({ level: "error", msg: "Failed to update ATR gate" }));
                          });
                        }}
                      />
                      <span className="min-w-0 flex-1 text-xs leading-snug text-slate-700 dark:text-slate-300">
                        <span className="font-semibold">Gate 5 — ATR expansion ≥ {cfg.eliteStMinAtrExpansion.toFixed(2)}×</span>
                        <span className="mt-0.5 block text-[10px] text-slate-500">
                          Require volatility expansion — current ATR above recent average. Catches explosive moves.
                        </span>
                      </span>
                    </label>

                    {/* Liquidity sweep bonus */}
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={cfg.eliteStLiqSweepEnabled}
                        onChange={(e) => {
                          const on = e.currentTarget.checked;
                          deferTask(() => {
                            void saveGatedBotConfig({ eliteStLiqSweepEnabled: on }).catch(() =>
                              pushLog({ level: "error", msg: "Failed to update liq sweep gate" }));
                          });
                        }}
                      />
                      <span className="min-w-0 flex-1 text-xs leading-snug text-slate-700 dark:text-slate-300">
                        <span className="font-semibold">Bonus — Liquidity sweep only</span>
                        <span className="mt-0.5 block text-[10px] text-slate-500">
                          When enabled, ONLY take trades that follow a recent stop-hunt sweep. Highest conviction setups.
                        </span>
                      </span>
                    </label>
                  </div>
                )}

                <div className="mt-3 space-y-2 rounded-lg border border-slate-300/60 bg-white/85 p-2 dark:border-slate-600/30 dark:bg-slate-950/50">
                  <div className="text-[11px] font-semibold text-slate-700 dark:text-slate-300">Breakout confirmation</div>
                  <label className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={cfg.supertrendBreakoutConfirm}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        deferTask(() => {
                          void (async () => {
                            try {
                              await saveGatedBotConfig({ supertrendBreakoutConfirm: on });
                              pushLog({
                                level: "info",
                                msg: on
                                  ? "Breakout confirm ON — entry only after a later bar closes past signal high (BUY) or low (SELL); primary chart only"
                                  : "Breakout confirm OFF — immediate bar-close entry (clears pending breakout)",
                              });
                            } catch {
                              pushLog({ level: "error", msg: "Failed to set breakout confirm" });
                            }
                          })();
                        });
                      }}
                    />
                    <span className="min-w-0 flex-1 text-xs leading-snug text-slate-700 dark:text-slate-300">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">Breakout confirmation (next close)</span>
                      <span className="mt-0.5 block text-[11px] text-slate-600 dark:text-slate-500">
                        Defers market entry until close breaks the signal candle&apos;s high (long) or low (short). Does not apply to AUTO multi sweep.
                      </span>
                    </span>
                  </label>
                  <div className="flex items-center gap-2 pl-6">
                    <span className="w-[8.5rem] shrink-0 text-[11px] text-slate-600 dark:text-slate-500">Breakout max bars</span>
                    <ThresholdSliderWithLock
                      ariaLabel="Drop pending breakout after this many closed bars"
                      serverSliderUnits={cfg.supertrendBreakoutMaxBars}
                      formatDisplay={(u) => `${u}`}
                      accentClassName="accent-cyan-600"
                      onDebouncedCommit={(u) => {
                        const n = Math.max(1, Math.min(20, Math.round(u)));
                        void saveGatedBotConfig({ supertrendBreakoutMaxBars: n }).catch(() => {
                          pushLog({ level: "error", msg: "Failed to set breakout max bars" });
                        });
                      }}
                    />
                  </div>
                </div>
              </div>
            )}
            {cfg.marketMode !== "SPOT" && !cfg.supertrendFuturesAuto && (
              <p className="text-[11px] leading-snug text-slate-600 dark:text-slate-500">
                Supertrend futures AI confidence filter resets to <span className="text-slate-600 dark:text-slate-400">on</span> (default).{" "}
                {cfg.marketMode === "AUTO" ? (
                  <>
                    Enable <span className="text-slate-600 dark:text-slate-400">Futures · Autotrade with Supertrend</span> in the Indicators block
                    above to configure it.
                  </>
                ) : cfg.marketMode === "FUTURES" ? (
                  <>
                    Enable <span className="text-slate-600 dark:text-slate-400">Autotrade with Supertrend</span> above to configure them.
                  </>
                ) : (
                  <>
                    Set market to <span className="text-slate-600 dark:text-slate-400">FUTURES</span> or{" "}
                    <span className="text-slate-600 dark:text-slate-400">AUTO</span> and enable futures Supertrend autotrade to configure it.
                  </>
                )}
              </p>
            )}

            <div className="mb-3 rounded-xl border-2 border-emerald-700/35 bg-gradient-to-br from-emerald-50/95 via-white to-slate-50/90 p-3 shadow-md dark:border-emerald-600/30 dark:from-emerald-950/40 dark:via-slate-950 dark:to-slate-900/90">
              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-emerald-800/15 pb-2 dark:border-emerald-200/10">
                <div className="min-w-0">
                  <h3 className="text-sm font-bold tracking-tight text-slate-900 dark:text-slate-50">Capital allotment</h3>
                  <p className="mt-0.5 max-w-[24rem] text-[10px] leading-snug text-slate-600 dark:text-slate-400">
                    Set <span className="font-semibold text-slate-700 dark:text-slate-300">allowed</span> (USDT pool or % of free margin). For fixed
                    USDT risk + max daily USDT, <span className="font-semibold text-slate-700 dark:text-slate-300">allowed</span> is the max{" "}
                    <span className="font-semibold text-slate-700 dark:text-slate-300">initial margin</span> (before leverage) for the strategy;
                    server clamps to wallet. <span className="font-semibold text-slate-700 dark:text-slate-300">Usable</span> is{" "}
                    <span className="font-semibold text-slate-700 dark:text-slate-300">buffer % × (allowed − open margin)</span> (default buffer from{" "}
                    <span className="font-mono text-[9px]">USABLE_CAPITAL_BUFFER_PCT</span>), then an optional % trim for the sizing pool.{" "}
                    <span className="font-semibold text-slate-700 dark:text-slate-300">Multi-coin splits</span> and{" "}
                    <span className="font-semibold text-slate-700 dark:text-slate-300">per-trade budget</span> are mutually exclusive on multi-symbol
                    runs. Deploy line uses venue buying power (~90%).
                    {showFuturesMinNotionalGate ? (
                      <>
                        {" "}
                        <span className="font-semibold text-slate-700 dark:text-slate-300">Min notional gate:</span> if the estimated open notional
                        for a listed symbol (lane margin × order leverage) is below the exchange minimum, autotrade will not open that symbol.
                      </>
                    ) : null}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <div className="grid grid-cols-2 gap-x-5 gap-y-2">
                    <div>
                      <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        {capitalAllotmentHeadline.cycleMode
                          ? "Allowed (cycle anchor)"
                          : capitalAllotmentHeadline.capitalAllotmentCompoundPnlUi
                            ? "Allowed (net est.)"
                            : "Allowed"}
                      </div>
                      <div
                        className={`text-lg font-bold tabular-nums ${
                          capitalAllotmentHeadline.allowedPoolUsdt < 0
                            ? "text-rose-600 dark:text-rose-400"
                            : "text-emerald-600 dark:text-emerald-400"
                        }`}
                      >
                        {capitalAllotmentHeadline.allowedMain}
                      </div>
                      {capitalAllotmentHeadline.compoundBreakdownLine ? (
                        <div className="mt-1 max-w-[16rem] text-[9px] leading-tight text-slate-600 dark:text-slate-400">
                          {capitalAllotmentHeadline.compoundBreakdownLine}
                        </div>
                      ) : null}
                    </div>
                    <div>
                      <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Usable (buffered)</div>
                      <div
                        className={`text-lg font-bold tabular-nums ${
                          capitalAllotmentHeadline.usablePoolRaw < 0
                            ? "text-amber-600 dark:text-amber-400"
                            : (capitalAllotmentHeadline.usableBuffered ?? 0) > 0
                              ? "text-sky-600 dark:text-sky-400"
                              : "text-slate-600 dark:text-slate-400"
                        }`}
                      >
                        {(capitalAllotmentHeadline.usableBuffered ?? 0).toLocaleString("en-US", {
                          maximumFractionDigits: 2,
                          minimumFractionDigits: 2,
                        })}{" "}
                        USDT
                      </div>
                      <div className="mt-0.5 text-[9px] font-mono text-slate-500 dark:text-slate-400">
                        {capitalAllotmentHeadline.usableFormula}
                      </div>
                      <div className="mt-0.5 text-[9px] text-slate-500 dark:text-slate-500">
                        Headroom (raw):{" "}
                        <span className="tabular-nums">
                          {capitalAllotmentHeadline.usablePoolRaw.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDT
                        </span>
                      </div>
                    </div>
                    <div>
                      <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Profit % of allowed</div>
                      <div className="text-base font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                        {realizedPnlVsAllowed.hasAllowed && realizedPnlVsAllowed.profitPct != null
                          ? `${realizedPnlVsAllowed.profitPct.toFixed(2)}%`
                          : "—"}
                      </div>
                      <div className="mt-0.5 max-w-[9.5rem] text-[9px] leading-tight text-slate-500 dark:text-slate-500">
                        {realizedPnlVsAllowed.profitUsdt > 0
                          ? `+${realizedPnlVsAllowed.profitUsdt.toFixed(2)} USDT on wins`
                          : realizedPnlVsAllowed.hasAllowed
                            ? "No winning closes"
                            : "Set allowed to compare"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Loss % of allowed</div>
                      <div className="text-base font-bold tabular-nums text-rose-700 dark:text-rose-400">
                        {realizedPnlVsAllowed.hasAllowed && realizedPnlVsAllowed.lossPct != null
                          ? `${realizedPnlVsAllowed.lossPct.toFixed(2)}%`
                          : "—"}
                      </div>
                      <div className="mt-0.5 max-w-[9.5rem] text-[9px] leading-tight text-slate-500 dark:text-slate-500">
                        {realizedPnlVsAllowed.lossUsdt > 0
                          ? `-${realizedPnlVsAllowed.lossUsdt.toFixed(2)} USDT on losses`
                          : realizedPnlVsAllowed.hasAllowed
                            ? "No losing closes"
                            : "Set allowed to compare"}
                      </div>
                    </div>
                  </div>
                  <p className="mt-1.5 max-w-[18rem] text-[9px] leading-snug text-slate-500 dark:text-slate-500">
                    Realized from <span className="font-medium text-slate-600 dark:text-slate-400">CLOSE</span> rows in this mode&apos;s trade list
                    (net PnL when present), as a % of the <span className="font-medium text-slate-600 dark:text-slate-400">allowed</span> margin pool
                    {capitalAllotmentHeadline.capitalAllotmentCompoundPnlUi ? (
                      <span> (uses net-est. allowed when compound is on).</span>
                    ) : (
                      "."
                    )}
                    {realizedPnlVsAllowed.closesWithPnl > 0 ? (
                      <span className="tabular-nums"> {realizedPnlVsAllowed.closesWithPnl} closes with PnL data.</span>
                    ) : (
                      <span> No close PnL in the loaded history yet.</span>
                    )}
                  </p>
                  {capitalAllotmentHeadline.allowedSub ? (
                    <div className="mt-1 max-w-[14rem] text-[9px] leading-tight text-emerald-800/90 dark:text-emerald-200/90">
                      {capitalAllotmentHeadline.allowedSub}
                    </div>
                  ) : null}
                  {capitalAllotmentHeadline.usableSizingNote ? (
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

              <div className="mt-3 space-y-2 rounded-lg border border-emerald-800/20 bg-white/80 p-2 dark:border-emerald-500/25 dark:bg-slate-950/50">
                <div className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">Allowed budget (USDT pool)</div>
                <div className="flex shrink-0 rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-0.5 text-[10px] font-medium text-slate-700 dark:text-slate-300">
                  <button
                    type="button"
                    className={`rounded px-2 py-0.5 ${cfg.allowedBudgetInputMode === "USDT" ? "bg-slate-600 text-white" : "hover:text-slate-900 dark:hover:text-slate-100"}`}
                    onClick={() => {
                      void saveGatedBotConfig({ allowedBudgetInputMode: "USDT" }).catch(() => {
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
                      void saveGatedBotConfig({ allowedBudgetInputMode: "WALLET_PCT" }).catch(() => {
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
                    value={
                      cfg.allowedBudgetUsdt > 0
                        ? cfg.allowedBudgetUsdt
                        : cfg.riskPerTradeUnit === "USDT"
                          ? cfg.riskPerTrade
                          : Number.isFinite(capitalAllotmentHeadline.allowedPoolUsdtBase) &&
                            capitalAllotmentHeadline.allowedPoolUsdtBase > 0
                            ? Math.max(1, Math.round(capitalAllotmentHeadline.allowedPoolUsdtBase))
                            : 1
                    }
                    min={1}
                    max={
                      capitalAllotmentHeadline.walletFreeMarginTotal > 0
                        ? Math.min(10_000_000, Math.max(1, Math.floor(capitalAllotmentHeadline.walletFreeMarginTotal)))
                        : 10_000_000
                    }
                    onCommit={async (v) => {
                      try {
                        await saveGatedBotConfig({ allowedBudgetUsdt: v, allowedBudgetInputMode: "USDT" });
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
                      <RangeSliderReleaseCommit
                        className="h-2 min-w-0 flex-1 cursor-pointer accent-emerald-600"
                        min={0.5}
                        max={100}
                        step={0.5}
                        disabled={capitalAllotmentHeadline.walletFreeMarginTotal <= 0}
                        value={
                          capitalAllotmentHeadline.walletFreeMarginTotal > 0
                            ? capitalAllotmentHeadline.walletSliderPct
                            : cfg.allowedBudgetWalletPct
                        }
                        onCommit={(pct) => {
                          const w = capitalAllotmentHeadline.walletFreeMarginTotal;
                          if (!Number.isFinite(pct) || w <= 0) return;
                          const nextAllowed = Math.max(1, Math.round((w * pct) / 100));
                          stageStrategyBotPatch({
                            allowedBudgetInputMode: "WALLET_PCT",
                            allowedBudgetWalletPct: pct,
                            allowedBudgetUsdt: nextAllowed,
                          });
                        }}
                      />
                      <span className="w-12 shrink-0 text-right text-[10px] tabular-nums text-slate-600 dark:text-slate-400">
                        {(
                          capitalAllotmentHeadline.walletFreeMarginTotal > 0
                            ? capitalAllotmentHeadline.walletSliderPct
                            : cfg.allowedBudgetWalletPct
                        ).toFixed(1)}
                        %
                      </span>
                    </label>
                  </div>
                )}
                <label className="mt-2 flex cursor-pointer items-start gap-2 rounded border border-slate-200/80 bg-slate-50/80 p-2 text-[10px] leading-snug text-slate-700 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-200">
                  <input
                    type="checkbox"
                    className="mt-0.5 rounded border-slate-400"
                    checked={cfg.capitalAllotmentCompoundPnlUi}
                    onChange={(e) => {
                      void saveGatedBotConfig({ capitalAllotmentCompoundPnlUi: e.target.checked }).catch(() => {
                        pushLog({ level: "error", msg: "Failed to toggle compound P&L display" });
                      });
                    }}
                  />
                  <span>
                    <span className="font-semibold">Compound trading result into headline pool</span> —{" "}
                    <span className="font-medium">allowed ≈ base cap + net close P&L + open unrealized</span> (close rows use stored net = P&amp;L
                    after fees when the backend provides it). Only <span className="font-medium">CLOSE</span> rows at/after the last{" "}
                    <span className="font-medium">allowed budget</span> edit count; open unrealized only from positions opened on/after that time.
                    Editing allowed USDT, % of wallet, or USDT/% input mode resets the anchor to now.{" "}
                    <span className="text-slate-600 dark:text-slate-400">
                      Autotrade sizing still uses the configured allowed USDT cap until you change that cap.
                    </span>
                  </span>
                </label>
              </div>

              {cfg.universeCoinSelectMode === "MULTIPLE" ? (
                <div className="mt-3 space-y-2 rounded-lg border border-emerald-800/20 bg-white/80 p-2 dark:border-emerald-500/25 dark:bg-slate-950/50">
                  <div className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">Sizing pool (multiple symbols)</div>
                  {cfg.riskPerTradeUnit !== "USDT" ? (
                    <p className="rounded border border-amber-300/95 bg-amber-100/95 p-2.5 text-[11px] font-medium leading-snug text-amber-950 dark:border-amber-600/50 dark:bg-amber-950/40 dark:text-amber-50">
                      <span className="font-semibold">Risk per trade is in %</span> — the bot does not use this USDT margin pool / splits on orders
                      until you set <span className="font-semibold">Risk per trade</span> to <span className="font-semibold">USDT</span> (further down).
                      You can still configure splits here as a preview.
                    </p>
                  ) : !capitalAllotmentHeadline.fixedUsd ? (
                    <p className="rounded border border-sky-200/90 bg-sky-50/90 p-2 text-[10px] leading-snug text-sky-950 dark:border-sky-700/40 dark:bg-sky-950/35 dark:text-sky-100/95">
                      <span className="font-semibold">Heads-up</span> — multi-coin margin sizing follows{" "}
                      <span className="font-medium">risk per trade in USDT</span> and the allowed pool above. Set{" "}
                      <span className="font-medium">Max daily loss</span> to <span className="font-medium">USDT</span> too if you want the headline
                      numbers and sublabels to use the same fixed-daily-loss pool semantics as the server docs.
                    </p>
                  ) : null}
                  <label className="flex cursor-pointer items-start gap-2 text-[11px] text-slate-700 dark:text-slate-200">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={cfg.multiTradeUsePctOfUsable}
                      onChange={(e) => {
                        void saveGatedBotConfig({ multiTradeUsePctOfUsable: e.target.checked }).catch(() => {
                          pushLog({ level: "error", msg: "Failed to toggle % of usable" });
                        });
                      }}
                    />
                    <span>
                      Use <span className="font-semibold">%</span> of <span className="font-semibold">buffered usable</span> for the sizing pool
                      (buffer = headroom × {capitalAllotmentHeadline.bufferPct}%; see headline).
                    </span>
                  </label>
                  {cfg.multiTradeUsePctOfUsable ? (
                    <div className="flex items-center gap-2 pl-6">
                      <span className="w-24 shrink-0 text-[10px] text-slate-600 dark:text-slate-400">% of usable</span>
                      <RangeSliderReleaseCommit
                        className="h-2 min-w-0 flex-1 cursor-pointer accent-emerald-600"
                        min={1}
                        max={100}
                        step={1}
                        value={cfg.multiTradePctOfUsable}
                        onCommit={(v) => {
                          const n = clampNum(v, 1, 100);
                          stageStrategyBotPatch({ multiTradePctOfUsable: n });
                        }}
                      />
                      <span className="w-10 text-right text-[10px] tabular-nums text-slate-600 dark:text-slate-400">
                        {cfg.multiTradePctOfUsable}%
                      </span>
                    </div>
                  ) : null}
                  <div className="mt-3 rounded-md border border-emerald-800/25 bg-emerald-50/60 p-2 dark:border-emerald-500/25 dark:bg-emerald-950/25">
                    <div className="text-[11px] font-semibold text-slate-800 dark:text-slate-100">Allocation mode</div>
                    <p className="mt-1 text-[10px] leading-snug text-slate-600 dark:text-slate-400">
                      Pick one: <span className="font-medium text-slate-700 dark:text-slate-300">multi-coin splits</span> (below) turn off the
                      per-trade cap, or <span className="font-medium text-slate-700 dark:text-slate-300">per-trade budget</span> (section further down)
                      caps each order from full per-symbol usable.
                    </p>
                    <div className="mt-2 space-y-1.5">
                      <label className="flex cursor-pointer items-start gap-2 text-[11px] text-slate-800 dark:text-slate-100">
                        <input
                          type="radio"
                          name="capital-sizing-mode"
                          className="mt-0.5"
                          checked={cfg.multiCoinCapitalSizingActive}
                          onChange={() => {
                            void saveGatedBotConfig({ multiCoinCapitalSizingActive: true }).catch(() => {
                              pushLog({ level: "error", msg: "Failed to enable multi-coin sizing" });
                            });
                          }}
                        />
                        <span>
                          <span className="font-semibold">Multi-coin pool</span> — configure splits below (per-trade cap ignored).
                        </span>
                      </label>
                      <label className="flex cursor-pointer items-start gap-2 text-[11px] text-slate-800 dark:text-slate-100">
                        <input
                          type="radio"
                          name="capital-sizing-mode"
                          className="mt-0.5"
                          checked={!cfg.multiCoinCapitalSizingActive}
                          onChange={() => {
                            void saveGatedBotConfig({ multiCoinCapitalSizingActive: false }).catch(() => {
                              pushLog({ level: "error", msg: "Failed to enable per-trade path" });
                            });
                          }}
                        />
                        <span>
                          <span className="font-semibold">Per-trade budget</span> — use per-trade cap / % of sized usable; split table stays visible for
                          editing.
                        </span>
                      </label>
                    </div>
                  </div>
                  {!cfg.multiCoinCapitalSizingActive ? (
                    <p className="mb-2 rounded border border-amber-200/90 bg-amber-50/90 p-2 text-[10px] leading-snug text-amber-950 dark:border-amber-700/45 dark:bg-amber-950/35 dark:text-amber-100/95">
                      <span className="font-semibold">Per-trade path</span> — the table below is for reference and editing. The bot applies multi-coin
                      splits only when <span className="font-medium">Multi-coin pool</span> is selected above.
                    </p>
                  ) : null}
                  <div className="text-[10px] font-medium text-slate-600 dark:text-slate-400">Split buffered usable across coins</div>
                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [
                        ["FULL", "Full pool per symbol"],
                        ["EQUAL", "Equal split (list)"],
                        ["CUSTOM_USDT", "Custom USDT / coin"],
                        ["CUSTOM_PCT_ALLOWED", "Custom % of usable"],
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
                          void saveGatedBotConfig({ multiBudgetSplitMode: mode }).catch(() => {
                            pushLog({ level: "error", msg: "Failed to set split mode" });
                          });
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 max-w-[36rem] text-[10px] leading-snug text-slate-600 dark:text-slate-500">
                    <span className="font-semibold text-slate-700 dark:text-slate-300">Full pool per symbol</span>: each symbol may use up to the
                    full <span className="italic">sized usable</span> pool minus its own open margin (no per-row divisor).{" "}
                    <span className="font-semibold text-slate-700 dark:text-slate-300">Equal split</span>: sized usable ÷{" "}
                    <span className="font-mono text-[9px]">N</span> list symbols; lane = slice − that symbol’s margin.{" "}
                    <span className="font-semibold text-slate-700 dark:text-slate-300">Custom %</span>: each row is a % of total{" "}
                    <span className="italic">sized usable</span> (Σ% ≤ 100%).
                  </p>
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
                            {cfg.multiBudgetSplitMode === "EQUAL" ? (
                              <>
                                <th className="px-2 py-1.5">Split (USDT)</th>
                                <th className="px-2 py-1.5">Margin</th>
                                <th className="px-2 py-1.5">Usable</th>
                                {showFuturesMinNotionalGate ? (
                                  <th className="px-2 py-1.5 text-slate-500">Venue min</th>
                                ) : null}
                              </>
                            ) : cfg.multiBudgetSplitMode === "FULL" ? (
                              <>
                                <th className="px-2 py-1.5">Pool (USDT)</th>
                                <th className="px-2 py-1.5">Margin</th>
                                <th className="px-2 py-1.5">Usable lane</th>
                                {showFuturesMinNotionalGate ? (
                                  <th className="px-2 py-1.5 text-slate-500">Venue min</th>
                                ) : null}
                              </>
                            ) : (
                              <>
                                <th className="px-2 py-1.5">
                                  {cfg.multiBudgetSplitMode === "CUSTOM_USDT"
                                    ? "USDT / trade"
                                    : cfg.multiBudgetSplitMode === "CUSTOM_PCT_ALLOWED"
                                      ? "% of sized usable (Σ≤100)"
                                      : "—"}
                                </th>
                                {cfg.multiBudgetSplitMode === "CUSTOM_USDT" || cfg.multiBudgetSplitMode === "CUSTOM_PCT_ALLOWED" ? (
                                  <th className="px-2 py-1.5">
                                    {cfg.multiBudgetSplitMode === "CUSTOM_USDT" ? "≈ % of sized usable" : "≈ USDT (split)"}
                                  </th>
                                ) : null}
                                {cfg.multiBudgetSplitMode === "CUSTOM_USDT" || cfg.multiBudgetSplitMode === "CUSTOM_PCT_ALLOWED" ? (
                                  <>
                                    <th className="px-2 py-1.5">Margin</th>
                                    <th className="px-2 py-1.5">Usable</th>
                                    {showFuturesMinNotionalGate ? (
                                      <th className="px-2 py-1.5 text-slate-500">Venue min</th>
                                    ) : null}
                                  </>
                                ) : null}
                              </>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {capitalMultiSyms.map((sym) => {
                            const mm = String(cfg.marketMode || "AUTO").toUpperCase();
                            const sizedPool =
                              Number(capitalAllotmentHeadline.sizedUsableUsdt) > 0
                                ? Number(capitalAllotmentHeadline.sizedUsableUsdt)
                                : capitalFieldCaps.pool > 0
                                  ? capitalFieldCaps.pool
                                  : capitalAllotmentHeadline.allowedPoolUsdt;
                            const poolHint = sizedPool;
                            const usdtVal = Math.max(0, Number(cfg.multiBudgetCoinUsdt[sym] ?? 0));
                            const pctVal = clampNum(Number(cfg.multiBudgetCoinPct[sym] ?? 0), 0, 100);
                            const pctOfPoolUsdt = poolHint > 0 ? (usdtVal / poolHint) * 100 : null;
                            const usdtFromPct = poolHint > 0 ? (poolHint * pctVal) / 100 : null;
                            const perCoinUsdtMax =
                              capitalFieldCaps.showSized && capitalFieldCaps.sizedUsableUsdt > 0
                                ? Math.min(10_000_000, capitalFieldCaps.sizedUsableUsdt)
                                : capitalFieldCaps.showPool && capitalFieldCaps.pool > 0
                                  ? Math.min(10_000_000, capitalFieldCaps.pool)
                                  : 10_000_000;
                            const isEqual = cfg.multiBudgetSplitMode === "EQUAL";
                            const isFull = cfg.multiBudgetSplitMode === "FULL";
                            const isCustom =
                              cfg.multiBudgetSplitMode === "CUSTOM_USDT" || cfg.multiBudgetSplitMode === "CUSTOM_PCT_ALLOWED";
                            const marginSym = sumMarginUsedForSymbolUsdt(positions, mm, sym);
                            const splitU = isEqual ? equalSplitSlotUsdt ?? 0 : 0;
                            const customAlloc =
                              cfg.multiBudgetSplitMode === "CUSTOM_USDT"
                                ? usdtVal
                                : cfg.multiBudgetSplitMode === "CUSTOM_PCT_ALLOWED"
                                  ? poolHint > 0
                                    ? (poolHint * pctVal) / 100
                                    : 0
                                  : 0;
                            const usableCol = isEqual
                              ? splitU - marginSym
                              : isFull
                                ? poolHint - marginSym
                                : isCustom
                                  ? customAlloc - marginSym
                                  : 0;
                            const estOpenForMin =
                              showFuturesMinNotionalGate && cfg.riskPerTradeUnit === "USDT" && cfg.maxDailyLossUnit === "USDT"
                                ? estimateFuturesOpenNotionalForOrderUi(bot, cfg, sym, positions, account, futuresLevDraft)
                                : null;
                            return (
                              <tr key={sym} className="border-t border-slate-200 dark:border-slate-800">
                                <td className="px-2 py-1.5 font-semibold text-slate-800 dark:text-slate-100">{sym}</td>
                                {isEqual ? (
                                  <>
                                    <td className="px-2 py-1.5 tabular-nums text-slate-700 dark:text-slate-200">{splitU.toFixed(2)}</td>
                                    <td className="px-2 py-1.5 tabular-nums text-slate-600 dark:text-slate-400">{marginSym.toFixed(2)}</td>
                                    <td
                                      className={`px-2 py-1.5 tabular-nums ${
                                        usableCol < 0 ? "text-amber-700 dark:text-amber-300" : "text-slate-700 dark:text-slate-200"
                                      }`}
                                    >
                                      {usableCol.toFixed(2)}
                                    </td>
                                    {showFuturesMinNotionalGate ? (
                                      <td className="px-2 py-1.5 align-top">
                                        {Number.isFinite(futuresMinNotionalBySymbol[sym]) ? (
                                          <>
                                            <span className="tabular-nums text-slate-600 dark:text-slate-400">
                                              {futuresMinNotionalBySymbol[sym].toFixed(2)}
                                            </span>
                                            {estOpenForMin != null &&
                                            futuresOrderNotionalBelowMin(estOpenForMin, futuresMinNotionalBySymbol[sym]) ? (
                                              <div className="mt-0.5 max-w-[7rem] text-[9px] font-mono text-amber-800 dark:text-amber-200">
                                                Below min notional — won&apos;t trade
                                              </div>
                                            ) : null}
                                          </>
                                        ) : (
                                          <span className="text-slate-500">—</span>
                                        )}
                                      </td>
                                    ) : null}
                                  </>
                                ) : isFull ? (
                                  <>
                                    <td className="px-2 py-1.5 tabular-nums text-slate-700 dark:text-slate-200">{poolHint.toFixed(2)}</td>
                                    <td className="px-2 py-1.5 tabular-nums text-slate-600 dark:text-slate-400">{marginSym.toFixed(2)}</td>
                                    <td
                                      className={`px-2 py-1.5 tabular-nums ${
                                        usableCol < 0 ? "text-amber-700 dark:text-amber-300" : "text-slate-700 dark:text-slate-200"
                                      }`}
                                    >
                                      {usableCol.toFixed(2)}
                                    </td>
                                    {showFuturesMinNotionalGate ? (
                                      <td className="px-2 py-1.5 align-top">
                                        {Number.isFinite(futuresMinNotionalBySymbol[sym]) ? (
                                          <>
                                            <span className="tabular-nums text-slate-600 dark:text-slate-400">
                                              {futuresMinNotionalBySymbol[sym].toFixed(2)}
                                            </span>
                                            {estOpenForMin != null &&
                                            futuresOrderNotionalBelowMin(estOpenForMin, futuresMinNotionalBySymbol[sym]) ? (
                                              <div className="mt-0.5 max-w-[7rem] text-[9px] font-mono text-amber-800 dark:text-amber-200">
                                                Below min notional — won&apos;t trade
                                              </div>
                                            ) : null}
                                          </>
                                        ) : (
                                          <span className="text-slate-500">—</span>
                                        )}
                                      </td>
                                    ) : null}
                                  </>
                                ) : (
                                  <>
                                    <td className="px-2 py-1.5">
                                      {cfg.multiBudgetSplitMode === "CUSTOM_USDT" ? (
                                        <NumericTextInput
                                          key={`cu-${sym}`}
                                          value={usdtVal}
                                          min={0}
                                          max={perCoinUsdtMax}
                                          onCommit={async (v) => {
                                            try {
                                              const capped = clampNum(v, 0, perCoinUsdtMax);
                                              await saveGatedBotConfig({
                                                multiBudgetCoinUsdt: { ...cfg.multiBudgetCoinUsdt, [sym]: capped },
                                              });
                                            } catch {
                                              pushLog({ level: "error", msg: `Failed to set USDT for ${sym}` });
                                            }
                                          }}
                                        />
                                      ) : cfg.multiBudgetSplitMode === "CUSTOM_PCT_ALLOWED" ? (
                                        <MultiBudgetCoinPctSliderRow
                                          sym={sym}
                                          pctVal={pctVal}
                                          multiBudgetCoinPct={cfg.multiBudgetCoinPct}
                                          onCommitPatch={stageStrategyBotPatch}
                                        />
                                      ) : (
                                        <span className="text-slate-500 dark:text-slate-500">—</span>
                                      )}
                                    </td>
                                    {cfg.multiBudgetSplitMode === "CUSTOM_USDT" || cfg.multiBudgetSplitMode === "CUSTOM_PCT_ALLOWED" ? (
                                      <>
                                        <td className="px-2 py-1.5 tabular-nums text-slate-600 dark:text-slate-400">
                                          {cfg.multiBudgetSplitMode === "CUSTOM_USDT" ? (
                                            pctOfPoolUsdt != null && Number.isFinite(pctOfPoolUsdt) ? (
                                              `${pctOfPoolUsdt.toFixed(2)}%`
                                            ) : (
                                              "—"
                                            )
                                          ) : usdtFromPct != null && Number.isFinite(usdtFromPct) ? (
                                            `${usdtFromPct.toFixed(2)} USDT`
                                          ) : (
                                            "—"
                                          )}
                                        </td>
                                        <td className="px-2 py-1.5 tabular-nums text-slate-600 dark:text-slate-400">{marginSym.toFixed(2)}</td>
                                        <td
                                          className={`px-2 py-1.5 tabular-nums ${
                                            usableCol < 0 ? "text-amber-700 dark:text-amber-300" : "text-slate-700 dark:text-slate-200"
                                          }`}
                                        >
                                          {usableCol.toFixed(2)}
                                        </td>
                                        {showFuturesMinNotionalGate ? (
                                          <td className="px-2 py-1.5 align-top">
                                            {Number.isFinite(futuresMinNotionalBySymbol[sym]) ? (
                                              <>
                                                <span className="tabular-nums text-slate-600 dark:text-slate-400">
                                                  {futuresMinNotionalBySymbol[sym].toFixed(2)}
                                                </span>
                                                {estOpenForMin != null &&
                                                futuresOrderNotionalBelowMin(estOpenForMin, futuresMinNotionalBySymbol[sym]) ? (
                                                  <div className="mt-0.5 max-w-[7rem] text-[9px] font-mono text-amber-800 dark:text-amber-200">
                                                    Below min notional — won&apos;t trade
                                                  </div>
                                                ) : null}
                                              </>
                                            ) : (
                                              <span className="text-slate-500">—</span>
                                            )}
                                          </td>
                                        ) : null}
                                      </>
                                    ) : null}
                                  </>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {cfg.multiBudgetSplitMode === "EQUAL" && capitalMultiSyms.length > 0 ? (
                    <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-500">
                      <span className="font-medium text-slate-700 dark:text-slate-300">Split</span> = total sized usable ÷{" "}
                      <span className="font-mono">{capitalMultiSyms.length}</span>. <span className="font-medium text-slate-700 dark:text-slate-300">
                        Margin
                      </span>{" "}
                      = open margin for this symbol. <span className="font-medium text-slate-700 dark:text-slate-300">Usable</span> = Split − Margin
                      (what fixed-USDT sizing uses per coin; negative means this symbol's margin exceeds its equal slice).
                    </p>
                  ) : null}
                  {cfg.multiBudgetSplitMode === "CUSTOM_USDT" || cfg.multiBudgetSplitMode === "CUSTOM_PCT_ALLOWED" ? (
                    <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-500">
                      <span className="font-medium text-slate-700 dark:text-slate-300">Usable</span> = configured USDT cap or % of{" "}
                      <span className="italic">sized usable</span> − this symbol&apos;s open margin (server lane; no per-trade cap in multi-coin pool
                      mode).
                    </p>
                  ) : null}
                  {showFuturesMinNotionalGate ? (
                    <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-500">
                      <span className="font-medium text-slate-700 dark:text-slate-300">Venue min</span> is the exchange minimum order notional (quote).
                      Rows marked below min use the same estimate as the server (lane margin × leverage); autotrade skips opens that fall short.
                    </p>
                  ) : null}
                  {cfg.multiBudgetSplitMode === "CUSTOM_PCT_ALLOWED" && multiBudgetPctSum > 100 + 0.01 ? (
                    <p className="text-[10px] font-medium text-amber-800 dark:text-amber-200">
                      Per-coin % of sized usable sums to {multiBudgetPctSum.toFixed(1)}% — server scales down to ≤100% on save; reduce sliders for a
                      precise split.
                    </p>
                  ) : cfg.multiBudgetSplitMode === "CUSTOM_PCT_ALLOWED" ? (
                    <p className="text-[10px] text-slate-600 dark:text-slate-500">Σ per-coin % = {multiBudgetPctSum.toFixed(1)}% (max 100%).</p>
                  ) : null}
                  {cfg.multiBudgetSplitMode === "FULL" && capitalMultiSyms.length > 0 ? (
                    <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-500">
                      <span className="font-medium text-slate-700 dark:text-slate-300">Pool</span> = sized usable shared across listed symbols.{" "}
                      <span className="font-medium text-slate-700 dark:text-slate-300">Usable lane</span> = Pool − this symbol&apos;s open margin
                      (same lane the server uses in full-pool multi-coin mode).
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="mt-3 space-y-2">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-[11px] font-medium text-slate-700 dark:text-slate-200">Per-trade budget</span>
                  <RiskUnitToggle
                    value={cfg.riskPerTradeUnit}
                    onChange={(u) => {
                      deferTask(() => {
                        void (async () => {
                          try {
                            await saveGatedBotConfig({ riskPerTradeUnit: u });
                            await syncActiveInstanceOperational({ riskUnit: u });
                          } catch {
                            pushLog({ level: "error", msg: "Failed to set risk unit" });
                          }
                        })();
                      });
                    }}
                  />
                  <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-slate-600 dark:text-slate-400">
                    <input
                      type="checkbox"
                      className="rounded border-slate-400"
                      checked={cfg.perTradeBudgetCapEnabled}
                      onChange={(e) => {
                        void saveGatedBotConfig({ perTradeBudgetCapEnabled: e.target.checked }).catch(() => {
                          pushLog({ level: "error", msg: "Failed to toggle per-trade cap" });
                        });
                      }}
                    />
                    <span>
                      Cap per-trade {cfg.riskPerTradeUnit === "USDT" ? "USDT" : "%"} (off = pool / per-symbol usable + venue limits)
                      {cfg.universeCoinSelectMode === "MULTIPLE" && cfg.multiCoinCapitalSizingActive ? (
                        <span className="block text-[9px] text-slate-500">
                          Orders ignore this cap in multi-coin pool mode — setting is kept for when you switch to per-trade budget.
                        </span>
                      ) : null}
                    </span>
                  </label>
                </div>
                {cfg.riskPerTradeUnit === "USDT" ? (
                  <div className="flex shrink-0 flex-wrap items-center gap-2 rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-0.5 text-[10px] font-medium text-slate-700 dark:text-slate-300">
                    <span className="px-1 text-[9px] text-slate-500">Cap as</span>
                    <button
                      type="button"
                      className={`rounded px-2 py-0.5 ${cfg.perTradeBudgetInputMode === "USDT" ? "bg-slate-600 text-white" : ""}`}
                      onClick={() => {
                        void saveGatedBotConfig({ perTradeBudgetInputMode: "USDT" }).catch(() => {
                          pushLog({ level: "error", msg: "Failed to set per-trade cap mode" });
                        });
                      }}
                    >
                      USDT margin
                    </button>
                    <button
                      type="button"
                      className={`rounded px-2 py-0.5 ${cfg.perTradeBudgetInputMode === "PCT_OF_USABLE" ? "bg-slate-600 text-white" : ""}`}
                      onClick={() => {
                        void saveGatedBotConfig({ perTradeBudgetInputMode: "PCT_OF_USABLE" }).catch(() => {
                          pushLog({ level: "error", msg: "Failed to set per-trade cap mode" });
                        });
                      }}
                    >
                      % of sized usable
                    </button>
                  </div>
                ) : null}
                <div className="max-w-xs">
                  <NumericTextInput
                    key={`rpt-${cfg.riskPerTradeUnit}-${cfg.perTradeBudgetInputMode}`}
                    value={cfg.riskPerTrade}
                    min={0}
                    max={cfg.riskPerTradeUnit === "USDT" ? capitalFieldCaps.maxRiskUsdt : 100}
                    onCommit={async (v) => {
                      try {
                        const cap = cfg.riskPerTradeUnit === "USDT" ? capitalFieldCaps.maxRiskUsdt : 100;
                        const val = clampNum(v, 0, cap);
                        await saveGatedBotConfig({ riskPerTrade: val });
                        await syncActiveInstanceOperational({ riskPerTrade: val });
                      } catch {
                        pushLog({ level: "error", msg: "Failed to set risk per trade" });
                      }
                    }}
                  />
                </div>
                {cfg.riskPerTradeUnit === "USDT" && capitalFieldCaps.showSized ? (
                  <p className="text-[9px] leading-snug text-slate-500 dark:text-slate-400">
                    {cfg.perTradeBudgetInputMode === "PCT_OF_USABLE" ? (
                      <>
                        0–100% of <span className="font-medium">sized usable</span> (~
                        {((capitalFieldCaps.sizedUsableUsdt * clampNum(cfg.riskPerTrade, 0, 100)) / 100).toFixed(2)} USDT margin at current
                        value).
                      </>
                    ) : (
                      <>0–{capitalFieldCaps.sizedUsableUsdt.toFixed(2)} USDT margin (sized usable ceiling).</>
                    )}{" "}
                    {cfg.perTradeBudgetCapEnabled && cfg.multiCoinCapitalSizingActive === false && cfg.riskPerTrade > capitalFieldCaps.sizedUsableUsdt * 0.35 ? (
                      <span className="font-medium text-amber-700 dark:text-amber-300">
                        High vs sized usable — large per-order share of the pool.
                      </span>
                    ) : !cfg.perTradeBudgetCapEnabled && cfg.riskPerTrade > capitalFieldCaps.sizedUsableUsdt * 0.35 ? (
                      <span className="font-medium text-amber-700 dark:text-amber-300">
                        Aggressive USDT target vs total sized usable (venue and slice still apply).
                      </span>
                    ) : null}
                  </p>
                ) : cfg.riskPerTradeUnit === "PCT" ? (
                  <p className="text-[9px] leading-snug text-slate-500 dark:text-slate-400">
                    0–100% of policy capital at the stop (before confidence tiers).{" "}
                    {cfg.riskPerTrade > 25 ? (
                      <span className="font-medium text-amber-700 dark:text-amber-300">
                        Unsafe range: very large fraction of capital at risk at the stop.
                      </span>
                    ) : null}
                  </p>
                ) : null}
              </div>

              <p className="mt-2 text-[10px] leading-snug text-slate-600 dark:text-slate-500">
                {cfg.riskPerTradeUnit === "USDT" ? (
                  capitalAllotmentHeadline.fixedUsd ? (
                    <>
                      <span className="font-medium text-slate-700 dark:text-slate-300">Fixed USDT mode</span>: sizing uses buffered usable (headroom
                      × buffer %, then optional % trim), then either multi-coin splits or per-trade cap path for MULTIPLE. SL/TP from ATR; venue caps
                      ~90% buying power.
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
                    Percent of <span className="text-slate-600 dark:text-slate-400">policy capital</span> at the stop (0–100% UI) before confidence
                    tiers; venue still caps buying power.
                  </>
                )}
              </p>

              <div className="mt-3 space-y-2">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-[11px] font-medium text-slate-700 dark:text-slate-200">Max daily loss</span>
                  <RiskUnitToggle
                    value={cfg.maxDailyLossUnit}
                    onChange={(u) => {
                      deferTask(() => {
                        void (async () => {
                          try {
                            await saveGatedBotConfig({ maxDailyLossUnit: u });
                            await syncActiveInstanceOperational({ maxDailyLossUnit: u });
                          } catch {
                            pushLog({ level: "error", msg: "Failed to set max daily loss unit" });
                          }
                        })();
                      });
                    }}
                  />
                </div>
                <div className="max-w-xs">
                  <NumericTextInput
                    key={`mdl-${cfg.maxDailyLossUnit}`}
                    value={cfg.maxDailyLoss}
                    min={0}
                    max={cfg.maxDailyLossUnit === "USDT" ? capitalFieldCaps.maxDailyUsdt : 100}
                    onCommit={async (v) => {
                      try {
                        const cap = cfg.maxDailyLossUnit === "USDT" ? capitalFieldCaps.maxDailyUsdt : 100;
                        const val = clampNum(v, 0, cap);
                        await saveGatedBotConfig({ maxDailyLoss: val });
                        await syncActiveInstanceOperational({ maxDailyLoss: val });
                      } catch {
                        pushLog({ level: "error", msg: "Failed to set max daily loss" });
                      }
                    }}
                  />
                </div>
                {cfg.maxDailyLossUnit === "USDT" && capitalFieldCaps.showSized ? (
                  <p className="text-[9px] leading-snug text-slate-500 dark:text-slate-400">
                    0–{capitalFieldCaps.sizedUsableUsdt.toFixed(2)} USDT (total sized usable).{" "}
                    {cfg.maxDailyLoss > capitalFieldCaps.sizedUsableUsdt * 0.5 ? (
                      <span className="font-medium text-amber-700 dark:text-amber-300">
                        Aggressive: daily halt threshold is a large share of usable collateral.
                      </span>
                    ) : null}
                  </p>
                ) : cfg.maxDailyLossUnit === "PCT" ? (
                  <p className="text-[9px] leading-snug text-slate-500 dark:text-slate-400">
                    0–100% drawdown from day-start equity per venue (hybrid: spot and futures).{" "}
                    {cfg.maxDailyLoss > 40 ? (
                      <span className="font-medium text-amber-700 dark:text-amber-300">
                        Unsafe range: halts only after a very large intraday drop.
                      </span>
                    ) : null}
                  </p>
                ) : null}
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
                    <span className="text-slate-600 dark:text-slate-400">−(this %)</span> on any venue (values are 0–100 in the field).
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
              <div className="flex min-w-0 items-center gap-2">
                <label className="flex shrink-0 items-center gap-1 text-[10px] text-slate-600 dark:text-slate-400">
                  <input
                    type="checkbox"
                    checked={!manualUseSl}
                    onChange={(e) => setManualUseSl(!e.target.checked)}
                  />
                  Off
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  className={numericInputClass}
                  value={slPctStr}
                  disabled={!manualUseSl}
                  onChange={(e) => setSlPctStr(e.target.value)}
                  title="Percent from entry (e.g. 1 = 1%)"
                />
              </div>
            </label>
            <label className="grid grid-cols-[110px_1fr] items-center gap-2">
              <span className="text-slate-600 dark:text-slate-400">Take-profit %</span>
              <div className="flex min-w-0 items-center gap-2">
                <label className="flex shrink-0 items-center gap-1 text-[10px] text-slate-600 dark:text-slate-400">
                  <input
                    type="checkbox"
                    checked={!manualUseTp}
                    onChange={(e) => setManualUseTp(!e.target.checked)}
                  />
                  Off
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  className={numericInputClass}
                  value={tpPctStr}
                  disabled={!manualUseTp}
                  onChange={(e) => setTpPctStr(e.target.value)}
                  title="Percent from entry (e.g. 1.5 = 1.5%)"
                />
              </div>
            </label>
            <div className="mt-2 flex gap-2">
              <button
                disabled={manualOrderBusy}
                className="flex-1 rounded-md bg-emerald-600/80 px-3 py-2 font-semibold hover:bg-emerald-600 disabled:opacity-50"
                onClick={() => {
                  if (manualOrderBusy) return;
                  const amountUsd = parseFloat(amountUsdStr.replace(/,/g, "."));
                  const slPctUi = manualUseSl ? parseManualPercentField(slPctStr) : null;
                  const tpPctUi = manualUseTp ? parseManualPercentField(tpPctStr) : null;
                  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
                    pushLog({ level: "warn", msg: "Enter a valid amount (USD)" });
                    return;
                  }
                  const mm = String(cfg.marketMode || "AUTO").toUpperCase();
                  if (mm === "SPOT" && (!manualUseSl || !manualUseTp)) {
                    pushLog({ level: "warn", msg: "Spot manual orders require both SL and TP" });
                    return;
                  }
                  if (manualUseSl && slPctUi == null) {
                    pushLog({ level: "warn", msg: "Enter a valid stop-loss %" });
                    return;
                  }
                  if (manualUseTp && tpPctUi == null) {
                    pushLog({ level: "warn", msg: "Enter a valid take-profit %" });
                    return;
                  }
                  const stopLossPct = manualUseSl && slPctUi != null ? slPctUi / 100 : null;
                  const takeProfitPct = manualUseTp && tpPctUi != null ? tpPctUi / 100 : null;
                  if (stopLossPct != null && (stopLossPct < 0.001 || stopLossPct > 0.2)) {
                    pushLog({ level: "warn", msg: "Stop-loss: use ~0.1%–20% of price (e.g. 0.1–20 in the % fields)" });
                    return;
                  }
                  if (takeProfitPct != null && (takeProfitPct < 0.001 || takeProfitPct > 0.5)) {
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
                  const slPctUi = manualUseSl ? parseManualPercentField(slPctStr) : null;
                  const tpPctUi = manualUseTp ? parseManualPercentField(tpPctStr) : null;
                  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
                    pushLog({ level: "warn", msg: "Enter a valid amount (USD)" });
                    return;
                  }
                  const mm = String(cfg.marketMode || "AUTO").toUpperCase();
                  if (mm === "SPOT" && (!manualUseSl || !manualUseTp)) {
                    pushLog({ level: "warn", msg: "Spot manual orders require both SL and TP" });
                    return;
                  }
                  if (manualUseSl && slPctUi == null) {
                    pushLog({ level: "warn", msg: "Enter a valid stop-loss %" });
                    return;
                  }
                  if (manualUseTp && tpPctUi == null) {
                    pushLog({ level: "warn", msg: "Enter a valid take-profit %" });
                    return;
                  }
                  const stopLossPct = manualUseSl && slPctUi != null ? slPctUi / 100 : null;
                  const takeProfitPct = manualUseTp && tpPctUi != null ? tpPctUi / 100 : null;
                  if (stopLossPct != null && (stopLossPct < 0.001 || stopLossPct > 0.2)) {
                    pushLog({ level: "warn", msg: "Stop-loss: use ~0.1%–20% of price (e.g. 0.1–20 in the % fields)" });
                    return;
                  }
                  if (takeProfitPct != null && (takeProfitPct < 0.001 || takeProfitPct > 0.5)) {
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
          await saveGatedBotConfig({ universeCustomSymbols: symbols });
          pushLog({ level: "info", msg: "Custom coin base saved", detail: { count: symbols.length } });
          await api.universeScan(true);
        }}
      />

      <ChartErrorBoundary>
        <TrailPreviewModal
          open={trailPreviewOpen}
          onClose={() => setTrailPreviewOpen(false)}
          /**
           * Preview → live bot config. The modal holds a local draft while open; only on Apply does it
           * call back here with the final cfg, which we round-trip into the same `api.botConfig` patch
           * the inline fields use. A single batched patch means server-side validation runs once and
           * the WS state echo updates every bound field atomically (so the sliders / inputs don't jitter).
           */
          onApply={async (next) => {
            await saveGatedBotConfig({
              futuresTrailingStopMode: next.futuresTrailingStopMode,
              futuresTrailingStFeeBreakeven: next.futuresTrailingStFeeBreakeven,
              futuresTrailingStAdvanced: next.futuresTrailingStAdvanced,
              trailOpenFeeRate: next.trailOpenFeeRate,
              trailCloseFeeRate: next.trailCloseFeeRate,
              trailFeeBeMultiplier: next.trailFeeBeMultiplier,
              trailActivationSlippageFrac: next.trailActivationSlippageFrac,
              trailT01LockSlippageFrac: next.trailT01LockSlippageFrac,
              trailBufferMode: next.trailBufferMode,
              trailBufferRate: next.trailBufferRate,
              trailBufferAtrMult: next.trailBufferAtrMult,
              trailMaintMarginRate: next.trailMaintMarginRate,
              trailMinSlDistFrac: next.trailMinSlDistFrac,
              trailMinGapFromMarkFrac: next.trailMinGapFromMarkFrac,
              trailPostT02SpacingFrac: next.trailPostT02SpacingFrac,
              trailPostT02MaxExtraTiers: next.trailPostT02MaxExtraTiers,
              /** `null` = inherit T01/T02 buffer; any number = dedicated post-T02 buffer fraction. */
              trailPostT02ActivationBufferRate: next.trailPostT02ActivationBufferRate,
              trailingStopExtraScalpingPcts: next.trailingStopExtraScalpingPcts,
            });
            pushLog({ level: "info", msg: "Trailing preview applied to live config" });
          }}
          initialCfg={trailPreviewCfg}
          initialSymbol={trailPreviewSnap?.symbol || trailPreviewSymbol}
          initialTimeframe={trailPreviewSnap?.timeframe || trailPreviewTimeframe}
          cachedCandlesBySymbol={{
            [(trailPreviewSnap?.symbol || trailPreviewSymbol) as string]: Array.isArray(trailPreviewSnap?.candles)
              ? trailPreviewSnap!.candles
              : Array.isArray(chartCandles)
                ? chartCandles
                : [],
          }}
          cachedAtrPctBySymbol={{
            [(trailPreviewSnap?.symbol || trailPreviewSymbol) as string]: trailPreviewSnap?.atrPct ?? marketAtrPct,
          }}
        />
      </ChartErrorBoundary>
    </div>
  );
}

