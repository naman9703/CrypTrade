/** Browser persistence for trading mode + bot config fields (survives server restarts / empty data dir). */

import { api } from "../api/client";

/** v2: capital-allotment fields added to persist list; migrate v1 without copying `byMode` (stale prefs broke VPS vs dev). */
const STORAGE_KEY_BASE = "trading-ui-prefs-v2";
const LEGACY_STORAGE_KEY = "trading-ui-prefs-v1";

/** When UI auth is on, scope prefs per stable user tag from `/api/auth/me` (SHA-256 prefix of email, not reversible). */
export function tradingUiStorageKey(userTag?: string | null): string {
  const t = userTag != null && String(userTag).trim() ? String(userTag).trim() : "";
  return t ? `${STORAGE_KEY_BASE}:user:${t}` : STORAGE_KEY_BASE;
}

export type TradingModeSlug = "PAPER" | "BINANCE_DEMO_API" | "BINANCE_TESTNET" | "BINANCE_LIVE";

export type PortfolioPnlRangePersisted = {
  pnlHistoryRange: "all" | "custom";
  customRangeStart: string;
  customRangeEnd: string;
};

export type TradingUiPersistedV1 = {
  v: 1;
  /** Last mode the operator selected (used to restore after server restarts). */
  lastMode?: TradingModeSlug;
  byMode: Record<string, Record<string, unknown>>;
  /** Portfolio trade-history PnL window per mode (browser-only; survives backend restarts). */
  portfolioPnlRangeByMode?: Record<string, PortfolioPnlRangePersisted>;
  /** Market Intelligence strip under chart order book (instance view). */
  showMarketIntelligencePanel?: boolean;
};

/** Keys mirror backend `persistTradingConfigToDisk` + tradingFormDefaults + pin symbol. */
export const PERSIST_BOT_KEYS = [
  "symbol",
  "timeframe",
  "symbolMode",
  "universePinnedSymbol",
  "universeCoinBase",
  "universeCustomSymbols",
  "universeCoinSelectMode",
  "universePinControl",
  "universeAutoCoinPick",
  "universePinnedSymbols",
  "aiThreshold",
  "riskPerTrade",
  "maxDailyLoss",
  "riskPerTradeUnit",
  "maxDailyLossUnit",
  "capitalSplitAcrossCoins",
  /** Fixed-USDT capital pool + multi-coin deploy (must persist for session restore / VPS parity). */
  "allowedBudgetUsdt",
  "allowedBudgetWalletPct",
  "allowedBudgetInputMode",
  "multiTradeUsePctOfUsable",
  "multiTradePctOfUsable",
  "multiBudgetSplitMode",
  "multiBudgetCoinUsdt",
  "multiBudgetCoinPct",
  "strategyMode",
  "manualStrategy",
  "marketMode",
  "futuresLeverageMode",
  "futuresLeverage",
  "supertrendSpotAuto",
  "supertrendFuturesAuto",
  "supertrendFuturesAiConfidenceFilter",
  "signalStrengthGatesTrades",
  "supertrendMoveQualityGate",
  "supertrendMoveQualityMinScore",
  "supertrendMoveQualityMinAdx",
  "supertrendMoveQualityMinMoveSlRatio",
  "supertrendMoveQualityExpectedMoveAtrMult",
  "supertrendMoveQualityMinAtrExpansion",
  "supertrendMoveQualityMinBodyVsAvg",
  "supertrendMoveQualityMinDirectionalBody",
  "supertrendMoveQualityMinVolumeVsAvg",
  "supertrendHtf4hEnabled",
  "supertrendHtf4hPeriod",
  "supertrendHtf4hMultiplier",
  "volumeProfileEnabled",
  "volumeProfileSoftGates",
  "volumeProfileGatesEnabled",
  "intradayVpBrackets",
  "intradayGateLiquidity",
  "intradayGateSession",
  "intradayGateFib",
  "intradayGateVp",
  "intradayGateOrderFlow",
  "intradayGateHtfRegime",
  "intradayGateInstitutionalSr",
  "intradayGateSmcIct",
  "intradaySmcIctMode",
  "intradaySmcMinScore",
  "intradaySmcIctProfile",
  "intradaySmcPickMode",
  "intradaySmcOneTradePerDay",
  "intradaySmcRequireMss",
  "intradaySmcRequireRetrace",
  "intradaySmcRequireChoch",
  "intradaySmcRequireBos",
  "intradaySmcRequireConfirm",
  "intradaySmcLookbackBars",
  "intradaySmcMinRr",
  "intradaySmcEntryZoneMode",
  "intradaySmcRequireFvgRetrace",
  "intradaySmcKillzoneMode",
  "intradaySmcMinAdx",
  "intradaySmcHtfStrictness",
  "intradaySmcHtfBiasMode",
  "intradaySmcSlMode",
  "intradaySmcMaxTpRr",
  "intradaySmcMaxHoldBars",
  "intradaySrAPlusMode",
  "intradaySrMinVolRatio",
  "intradaySrMinHtfSep",
  "intradaySrZoneWidthPct",
  "intradaySrBosMaxBarsAfterReclaim",
  "intradaySrMinConfirmWick",
  "intradaySrRequireBos",
  "intradaySrRequireConfirm",
  "intradaySrRequireVolume",
  "intradaySrRequireHtfTrend",
  "intradayLiqTp1Enabled",
  "intradayLiqTp2Enabled",
  "intradayLiqBreakevenAfterPartial",
  "intradayLiqPartialTp",
  "intradayLiqTp1Rr",
  "intradayLiqTp2Rr",
  "intradayLiqTp2PartialFrac",
  "intradayLiqMinRr",
  "intradayLiqMaxTpRr",
  "intradayLiqMaxHoldBars",
  "liqMapLookbackBars",
  "liqMapMaxAgeBars",
  "liqMapMinTouches",
  "liqMapMinWickRatio",
  "liqMapMinRvol",
  "liqMapMinBodyRatio",
  "liqMapSweepPct",
  "liqMapEqualTolPct",
  "liqMapNormalizeThresholds",
  "liqMapSweepAtrFrac",
  "liqMapEqualTolAtrFrac",
  "liqMapAutoCalibrate",
  "liqMapAutoProfileBars",
  "liqMapAutoTrailTune",
  "liqMapHybridExit",
  "liqMapQualityGate",
  "liqMapQualityGateMode",
  "liqMapSoftGateScoreBand",
  "liqMapQualityAuto",
  "liqMapMinQualityScore",
  "liqMapRequireUnresolved",
  "liqMapRequireDirectionalClose",
  "liqMapEntryModel",
  "liqMapHtfPoolTfs",
  "liqMapHtfLookbackBars",
  "liqMapHtfSwingLeft",
  "liqMapHtfSwingRight",
  "liqMapHtfEqualMinTouches",
  "liqMapUseDailyWeeklyPools",
  "liqMapUseTrendlinePools",
  "liqMapEntryTiming",
  "liqMapRequireMss",
  "liqMapRequireChoch",
  "liqMapRequireRetrace",
  "liqMapRequireReclaimHold",
  "liqMapStructureLookbackBars",
  "liqMapMssMaxBarsAfterSweep",
  "liqMapEntryZoneMode",
  "liqMapFvgEntryMode",
  "liqMapMssRequireDisplacement",
  "liqMapDisplacementBodyMult",
  "liqMapDisplacementAtrMult",
  "liqMapFvgMinGapPct",
  "liqMapStrictPdZone",
  "liqMapObMinDisplacementAtr",
  "liqMapRr",
  "liqMapHtfMode",
  "liqMapKillzone",
  "liqMapMinAtrPctile",
  "liqMapMaxAtrPctile",
  "liqMapAtrPctileLookback",
  "liqMapMinAdx",
  "liqMapMaxAdx",
  "liqMapMinAtrPct",
  "liqMapMaxAtrPct",
  "liqMapMaxHoldBars",
  "liqMapMaxSlPct",
  "liqMapSlMode",
  "liqMapSlBufferPct",
  "liqMapSlBufferAtrFrac",
  "liqMapOnePerDay",
  "liqMapOnePerSidePerDay",
  "liqMapRvolLookback",
  "liqMapExitMode",
  "liqMapTrailMode",
  "liqMapMaxTpRr",
  "liqMapMaxOpposingRr",
  "liqMapMinTp2Rr",
  "liqMapFallbackTpRr",
  "liqMapPartialFrac",
  "liqMapBreakevenAfterPartial",
  "liqMapUse4hConfirm",
  "liqMapAtrSlMult",
  "liqMapSlRegimeAdjust",
  "liqMapSlRegimeLowMult",
  "liqMapSlRegimeHighMult",
  "liqMapTrailStPeriod",
  "liqMapTrailStMult",
  "liqMapTrailAtrHwmMult",
  "liqMapTrailMfeGiveback",
  "liqMapTrailMfeMinR",
  "liqMapTrailStepAtrMult",
  "liqMapTrailMergeSt",
  "liqMapDynamicRunnerMaxTpRr",
  "liqMapDynamicRunnerMinTpRr",
  "liqMapProjectedTpAtrMult",
  "liqMapProjectedTpRangeMult",
  "liqMapProjectionLookbackBars",
  "liqMapDynamicExitPolicy",
  "liqMapDynExitQualityHi",
  "liqMapDynExitQualityMid",
  "liqMapDynExitRrHi",
  "liqMapDynExitRrMid",
  "liqMapDynExitPartialHi",
  "liqMapDynExitPartialMid",
  "liqMapDynExitPartialBase",
  "liqMapDynExitTrailAtrHi",
  "liqMapDynExitTrailAtrMid",
  "liqMapDynExitTrailAtrBase",
  "liqMapDynExitWeakTp1Rr",
  "liqMapStructuralTp1Rr",
  "liqMapDeadTradeExitBars",
  "liqMapDeadTradeMinMfeR",
  "liqMapDeadTradeMaxLossR",
  "intradayFibStrictMode",
  "intradayFibConfirmNextBar",
  "intradayFibRequireRsiAlign",
  "intradayFibRequireHtfAlign",
  "intradayFibLearnedRulesEnabled",
  "intradayFibRequireRetraceCoherence",
  "intradayFibAllowedRatios",
  "intradayFibGoldenRetraceMin",
  "intradayFibGoldenRetraceMax",
  "intradayFibMinRetraceRatio",
  "intradayFibMaxRetraceRatio",
  "intradayFibMinWickRatio",
  "intradayFibMinAdx",
  "intradayFibMinLegAtrMult",
  "intradayFibMinHtfSep",
  "intradayFibMinScore",
  "intradayFibTpMode",
  "intradayFibExtensionFrac",
  "intradayFibMinRr",
  "intradayFibMinLegAtrMult",
  "intradayFibMaxBarsSinceSwing",
  "intradayFibBracketSource",
  "intradayFibGoldenScalpTpPct",
  "intradayFibGoldenScalpSlPct",
  "intradayFibEntryAtSignalClose",
  "intradayTierMode",
  "backtestBreakevenAtMfePct",
  "vpLookbackBars",
  "vpMinRR",
  "eliteStRequireHtf4hAlign",
  "eliteStHtf4hPeriod",
  "eliteStHtf4hMultiplier",
  "eliteStRequireHtf1hEmaAlign",
  "eliteStHtf1hMinSep",
  "eliteStHtf1hSepMode",
  "eliteStHtf1hMinSepAtrMult",
  "eliteStHtf1hMinSepFloor",
  "eliteStHtf1hMinSepCeil",
  "eliteStHtf1hSepPercentileLookback",
  "eliteStHtf1hSepPercentileMult",
  "eliteStHtf1hSepAdxBase",
  "eliteStHtf1hSepAdxAlpha",
  "eliteStHtf1hSepAdxRef",
  "eliteStHtf1hSepCalibratePct",
  "eliteStHtf1hSepCalibrateBars",
  "eliteStAutoCalibrate",
  "eliteStAutoProfileBars",
  "eliteStAutoBracketMode",
  "eliteStAutoMinAdxFloor",
  "eliteStAutoMinAdxCeil",
  "eliteStMinAdx",
  "eliteStRequireAdxRising",
  "eliteStMinVolumeVsAvg",
  "eliteStRequireAtrExpansion",
  "eliteStMinAtrExpansion",
  "eliteStLiqSweepEnabled",
  "supertrendBigMoveGateEnabled",
  "supertrendBigMoveMinStrength",
  "supertrendBigMoveMinMoveSlRatio",
  "supertrendBigMoveMinAdx",
  "supertrendBigMoveMinScore",
  "supertrendBigMoveMaxCandlesSinceFlip",
  "supertrendBigMoveMinVolumeVsAvg",
  "supertrendBigMoveExpectedMoveAtrMult",
  "marketDecision",
  "supertrendBreakoutConfirm",
  "supertrendBreakoutMaxBars",
  "signalStrengthOpenMin",
  "supertrendFuturesMinAiProb",
  "surfPulseMlThreshold",
  "trailingStopLossAuto",
  "trailOnlyAfterTp2Fill",
  "futuresTrailingStopMode",
  "futuresTrailingStFeeBreakeven",
  "futuresTrailingStAdvanced",
  "trailingStopExtraScalpingPcts",
  "supertrendFuturesFixedSlPct",
  "supertrendFuturesFixedTpPct",
  "supertrendFuturesUseFixedSl",
  "supertrendFuturesUseFixedTp",
  "supertrendFuturesTwoWay",
  "supertrendFuturesMaxEntrySlippagePct",
  "supertrendFuturesEntryOpenStyle",
  "supertrendFuturesEntryRecheckMs",
  "supertrendFuturesIocFallbackMarket",
  "supertrendFuturesRequireMarkPrice",
  "supertrendFuturesRequireBookTicker",
  "supertrendFuturesMaxSignalLagMs",
  "supertrendPeriod",
  "supertrendMultiplier",
  "supertrendWilderAtr",
  "tradingFormDefaults",
] as const;

export type PersistableBotKey = (typeof PERSIST_BOT_KEYS)[number];

export function extractPersistableBotPatch(bot: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!bot || typeof bot !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const key of PERSIST_BOT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(bot, key) && bot[key] !== undefined) {
      if (key === "tradingFormDefaults" && bot.tradingFormDefaults && typeof bot.tradingFormDefaults === "object") {
        out.tradingFormDefaults = { ...(bot.tradingFormDefaults as Record<string, unknown>) };
      } else if (key === "marketDecision" && bot.marketDecision && typeof bot.marketDecision === "object") {
        out.marketDecision = { ...(bot.marketDecision as Record<string, unknown>) };
      } else if (
        (key === "multiBudgetCoinUsdt" || key === "multiBudgetCoinPct") &&
        bot[key] &&
        typeof bot[key] === "object"
      ) {
        out[key] = { ...(bot[key] as Record<string, unknown>) };
      } else {
        out[key] = bot[key];
      }
    }
  }
  return out;
}

export function mergePersistedBotPatch(
  serverBot: Record<string, unknown>,
  patch: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  if (!patch || typeof patch !== "object" || !Object.keys(patch).length) return serverBot;
  const out: Record<string, unknown> = { ...serverBot };
  for (const key of PERSIST_BOT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key) || patch[key] === undefined) continue;
    if (key === "tradingFormDefaults" && patch.tradingFormDefaults && typeof patch.tradingFormDefaults === "object") {
      const prev = (serverBot.tradingFormDefaults as Record<string, unknown> | undefined) || {};
      out.tradingFormDefaults = { ...prev, ...(patch.tradingFormDefaults as Record<string, unknown>) };
    } else if (key === "marketDecision" && patch.marketDecision && typeof patch.marketDecision === "object") {
      const prev = (serverBot.marketDecision as Record<string, unknown> | undefined) || {};
      out.marketDecision = { ...prev, ...(patch.marketDecision as Record<string, unknown>) };
    } else if (
      (key === "multiBudgetCoinUsdt" || key === "multiBudgetCoinPct") &&
      patch[key] &&
      typeof patch[key] === "object"
    ) {
      const prev = ((serverBot as Record<string, unknown>)[key] as Record<string, unknown> | undefined) || {};
      out[key] = { ...prev, ...(patch[key] as Record<string, unknown>) };
    } else {
      out[key] = patch[key];
    }
  }
  return out;
}

/**
 * After WS hello (or `/api/state`), **server bot wins** for every persisted key it defines so reload reflects
 * saved strategy + disk — stale browser `byMode` must not overwrite authoritative runtime config.
 * Local values apply only when the server snapshot omits the key entirely (`undefined` gap-fill).
 */
export function mergePersistedBotPreferServer(
  serverBot: Record<string, unknown>,
  localPatch: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  if (!localPatch || typeof localPatch !== "object" || !Object.keys(localPatch).length) return serverBot;
  const out: Record<string, unknown> = { ...serverBot };
  for (const key of PERSIST_BOT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(localPatch, key) || localPatch[key] === undefined) continue;
    if (Object.prototype.hasOwnProperty.call(serverBot, key) && serverBot[key] !== undefined) continue;

    if (key === "tradingFormDefaults" && localPatch.tradingFormDefaults && typeof localPatch.tradingFormDefaults === "object") {
      out.tradingFormDefaults = { ...(localPatch.tradingFormDefaults as Record<string, unknown>) };
    } else if (key === "marketDecision" && localPatch.marketDecision && typeof localPatch.marketDecision === "object") {
      out.marketDecision = { ...(localPatch.marketDecision as Record<string, unknown>) };
    } else if (
      (key === "multiBudgetCoinUsdt" || key === "multiBudgetCoinPct") &&
      localPatch[key] &&
      typeof localPatch[key] === "object"
    ) {
      out[key] = { ...(localPatch[key] as Record<string, unknown>) };
    } else {
      out[key] = localPatch[key];
    }
  }
  return out;
}

/** Shallow bot patch + deep-merge known nested objects (matches `/api/bot/config` partial patches). */
export function mergeOptimisticBotPatch(
  prev: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const base = prev && typeof prev === "object" ? { ...prev } : {};
  const out: Record<string, unknown> = { ...base, ...patch };
  if (patch.marketDecision && typeof patch.marketDecision === "object" && !Array.isArray(patch.marketDecision)) {
    const pb = patch.marketDecision as Record<string, unknown>;
    const bb = base.marketDecision && typeof base.marketDecision === "object" && !Array.isArray(base.marketDecision)
      ? (base.marketDecision as Record<string, unknown>)
      : {};
    out.marketDecision = { ...bb, ...pb };
  }
  if (patch.tradingFormDefaults && typeof patch.tradingFormDefaults === "object" && !Array.isArray(patch.tradingFormDefaults)) {
    const pb = patch.tradingFormDefaults as Record<string, unknown>;
    const bb =
      base.tradingFormDefaults && typeof base.tradingFormDefaults === "object" && !Array.isArray(base.tradingFormDefaults)
        ? (base.tradingFormDefaults as Record<string, unknown>)
        : {};
    out.tradingFormDefaults = { ...bb, ...pb };
  }
  for (const key of ["multiBudgetCoinUsdt", "multiBudgetCoinPct"] as const) {
    const pv = patch[key];
    if (pv && typeof pv === "object" && !Array.isArray(pv)) {
      const bv =
        base[key] && typeof base[key] === "object" && !Array.isArray(base[key])
          ? (base[key] as Record<string, unknown>)
          : {};
      out[key] = { ...bv, ...(pv as Record<string, unknown>) };
    }
  }
  return out;
}

function stableStringify(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(",")}]`;
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

/** True when every key in `patch` has the same value on `bot` (for skipping redundant /api/bot/config). */
export function botMatchesPersistedPatch(bot: Record<string, unknown> | null | undefined, patch: Record<string, unknown>): boolean {
  if (!bot || typeof bot !== "object" || !patch || typeof patch !== "object") return false;
  for (const key of Object.keys(patch)) {
    if (!PERSIST_BOT_KEYS.includes(key as PersistableBotKey)) continue;
    const pv = patch[key];
    const bv = (bot as Record<string, unknown>)[key];
    if (stableStringify(pv) !== stableStringify(bv)) return false;
  }
  return true;
}

export function loadTradingUiPrefs(userTag?: string | null): TradingUiPersistedV1 | null {
  try {
    const key = tradingUiStorageKey(userTag);
    let raw = localStorage.getItem(key);
    if (!raw && userTag) {
      raw = localStorage.getItem(STORAGE_KEY_BASE);
    }
    if (!raw) {
      const leg = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (leg) {
        try {
          const old = JSON.parse(leg) as TradingUiPersistedV1 & { lastMode?: string };
          if (old?.v === 1 && typeof old.byMode === "object") {
            const migrated: TradingUiPersistedV1 = {
              v: 1,
              lastMode: old.lastMode as TradingModeSlug | undefined,
              byMode: {},
            };
            localStorage.setItem(key, JSON.stringify(migrated));
          }
        } catch {
          /* ignore */
        }
        try {
          localStorage.removeItem(LEGACY_STORAGE_KEY);
        } catch {
          /* ignore */
        }
        raw = localStorage.getItem(key);
      }
    }
    if (!raw) return null;
    const data = JSON.parse(raw) as TradingUiPersistedV1;
    if (data.v !== 1 || typeof data.byMode !== "object" || !data.byMode) return null;
    return data;
  } catch {
    return null;
  }
}

export function tradingUiPersistMode(mode: string | undefined, userTag?: string | null) {
  if (!mode) return;
  const m = String(mode).toUpperCase();
  if (!["PAPER", "BINANCE_DEMO_API", "BINANCE_TESTNET", "BINANCE_LIVE"].includes(m)) return;
  try {
    const key = tradingUiStorageKey(userTag);
    const cur = loadTradingUiPrefs(userTag) || { v: 1 as const, lastMode: m as TradingModeSlug, byMode: {} };
    cur.v = 1;
    cur.lastMode = m as TradingModeSlug;
    cur.byMode = { ...cur.byMode };
    localStorage.setItem(key, JSON.stringify(cur));
  } catch {
    /* ignore */
  }
  enqueueServerUiPrefsPatch({ lastMode: m as TradingModeSlug });
}

export function tradingUiPersistBotSnapshot(
  mode: string | undefined,
  bot: Record<string, unknown> | null | undefined,
  userTag?: string | null,
) {
  if (!mode || !bot || typeof bot !== "object") return;
  const m = String(mode).toUpperCase();
  if (!["PAPER", "BINANCE_DEMO_API", "BINANCE_TESTNET", "BINANCE_LIVE"].includes(m)) return;
  try {
    const key = tradingUiStorageKey(userTag);
    const cur = loadTradingUiPrefs(userTag) || { v: 1 as const, lastMode: m as TradingModeSlug, byMode: {} };
    cur.v = 1;
    cur.lastMode = m as TradingModeSlug;
    cur.byMode = { ...cur.byMode, [m]: extractPersistableBotPatch(bot) };
    localStorage.setItem(key, JSON.stringify(cur));
  } catch {
    /* ignore */
  }
}

const MODE_SLUGS = new Set(["PAPER", "BINANCE_DEMO_API", "BINANCE_TESTNET", "BINANCE_LIVE"]);

/** Multi-chart grid layout (must match `MultiChartGrid` localStorage keys). */
export const CHART_GRID_PAGE_LS_KEY = "trading-multi-chart-page-v1";
export const CHART_GRID_SORT_LS_KEY = "trading-multi-chart-sort-v1";

const UI_PREFS_DEBOUNCE_MS = 1000;
let uiPrefsSyncAllowed = false;
let uiPrefsDirty: Record<string, unknown> = {};
let uiPrefsTimer: ReturnType<typeof setTimeout> | null = null;

function deepMergePrefsPatch(acc: Record<string, unknown>, partial: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...acc };
  for (const k of Object.keys(partial)) {
    const pv = partial[k];
    const av = out[k];
    if (
      pv !== null &&
      typeof pv === "object" &&
      !Array.isArray(pv) &&
      av !== null &&
      typeof av === "object" &&
      !Array.isArray(av)
    ) {
      out[k] = deepMergePrefsPatch(av as Record<string, unknown>, pv as Record<string, unknown>);
    } else {
      out[k] = pv;
    }
  }
  return out;
}

/** DB-backed `/api/me/ui-prefs` sync is only for sessions with a `users` row (see `/api/auth/me` → syncUiPrefs). */
export function setUiPrefsSyncAllowed(v: boolean) {
  uiPrefsSyncAllowed = v;
  if (!v && uiPrefsTimer) {
    clearTimeout(uiPrefsTimer);
    uiPrefsTimer = null;
    uiPrefsDirty = {};
  }
}

/** Debounced PATCH to `/api/me/ui-prefs` (cosmetic prefs only — never `PERSIST_BOT_KEYS`). */
export function enqueueServerUiPrefsPatch(partial: Record<string, unknown>) {
  if (!uiPrefsSyncAllowed || typeof window === "undefined") return;
  uiPrefsDirty = deepMergePrefsPatch(uiPrefsDirty, partial);
  if (uiPrefsTimer) clearTimeout(uiPrefsTimer);
  uiPrefsTimer = setTimeout(() => {
    const payload = uiPrefsDirty;
    uiPrefsDirty = {};
    uiPrefsTimer = null;
    void api.patchUiPrefs(payload).catch(() => {
      /* offline / 403 */
    });
  }, UI_PREFS_DEBOUNCE_MS);
}

/**
 * Merge server-stored UI prefs into localStorage; server wins for keys present in `server`.
 * Does not touch `byMode` / bot config (`PERSIST_BOT_KEYS`).
 */
export function mergeServerUiPrefsIntoLocalStorage(userTag: string | null, server: Record<string, unknown>) {
  const cur = loadTradingUiPrefs(userTag) || { v: 1 as const, byMode: {} };
  const next: TradingUiPersistedV1 = {
    ...cur,
    v: 1,
    byMode: cur.byMode && typeof cur.byMode === "object" ? { ...cur.byMode } : {},
  };
  if (Object.prototype.hasOwnProperty.call(server, "lastMode")) {
    const lm = String(server.lastMode || "").toUpperCase();
    if (MODE_SLUGS.has(lm)) next.lastMode = lm as TradingModeSlug;
  }
  if (
    Object.prototype.hasOwnProperty.call(server, "portfolioPnlRangeByMode") &&
    server.portfolioPnlRangeByMode &&
    typeof server.portfolioPnlRangeByMode === "object"
  ) {
    const s = server.portfolioPnlRangeByMode as Record<string, unknown>;
    next.portfolioPnlRangeByMode = {
      ...(next.portfolioPnlRangeByMode && typeof next.portfolioPnlRangeByMode === "object"
        ? next.portfolioPnlRangeByMode
        : {}),
    };
    for (const mode of Object.keys(s)) {
      const mu = mode.toUpperCase();
      if (!MODE_SLUGS.has(mu)) continue;
      const row = s[mode];
      if (!row || typeof row !== "object") continue;
      const pr = row as PortfolioPnlRangePersisted;
      next.portfolioPnlRangeByMode[mu] = {
        pnlHistoryRange: pr.pnlHistoryRange === "custom" ? "custom" : "all",
        customRangeStart: typeof pr.customRangeStart === "string" ? pr.customRangeStart : "",
        customRangeEnd: typeof pr.customRangeEnd === "string" ? pr.customRangeEnd : "",
      };
    }
  }
  if (Object.prototype.hasOwnProperty.call(server, "showMarketIntelligencePanel")) {
    next.showMarketIntelligencePanel = Boolean(server.showMarketIntelligencePanel);
  }
  try {
    const key = tradingUiStorageKey(userTag);
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  if (Object.prototype.hasOwnProperty.call(server, "multiChartGrid")) {
    const g = server.multiChartGrid;
    if (g && typeof g === "object") {
      const sort = (g as { sort?: unknown }).sort;
      const page = (g as { page?: unknown }).page;
      if (typeof sort === "string") {
        try {
          localStorage.setItem(CHART_GRID_SORT_LS_KEY, sort);
        } catch {
          /* ignore */
        }
      }
      if (typeof page === "number" && Number.isFinite(page)) {
        try {
          localStorage.setItem(CHART_GRID_PAGE_LS_KEY, String(Math.max(0, Math.floor(page))));
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/** Apply server `users.ui_prefs` into local caches + theme store. */
export async function hydrateTradingUiPrefsFromServer(userTag: string | null, server: Record<string, unknown> | null | undefined) {
  if (!server || typeof server !== "object") return;
  mergeServerUiPrefsIntoLocalStorage(userTag, server);
  if (Object.prototype.hasOwnProperty.call(server, "theme")) {
    const theme = server.theme;
    if (theme === "light" || theme === "dark") {
      const { applyDomTheme, useThemeStore } = await import("../themeStore");
      applyDomTheme(theme);
      useThemeStore.setState({ theme });
    }
  }
  await syncShowMarketIntelligencePanelFromStorage(userTag);
}

/** Read saved portfolio PnL custom range for the active trading mode. */
export function loadPortfolioPnlRangeForMode(
  mode: string | undefined,
  userTag?: string | null,
): PortfolioPnlRangePersisted | null {
  const m = String(mode || "").toUpperCase();
  if (!MODE_SLUGS.has(m)) return null;
  const cur = loadTradingUiPrefs(userTag);
  const row = cur?.portfolioPnlRangeByMode?.[m];
  if (!row || typeof row !== "object") return null;
  const pnlHistoryRange = row.pnlHistoryRange === "custom" ? "custom" : "all";
  return {
    pnlHistoryRange,
    customRangeStart: typeof row.customRangeStart === "string" ? row.customRangeStart : "",
    customRangeEnd: typeof row.customRangeEnd === "string" ? row.customRangeEnd : "",
  };
}

/** Persist portfolio PnL history range for one trading mode (same storage bucket as bot prefs). */
export function tradingUiPersistPortfolioPnlRange(
  mode: string | undefined,
  payload: PortfolioPnlRangePersisted,
  userTag?: string | null,
) {
  const m = String(mode || "").toUpperCase();
  if (!MODE_SLUGS.has(m)) return;
  try {
    const key = tradingUiStorageKey(userTag);
    const cur = loadTradingUiPrefs(userTag) || { v: 1 as const, lastMode: m as TradingModeSlug, byMode: {} };
    cur.v = 1;
    cur.lastMode = (cur.lastMode ?? m) as TradingModeSlug;
    cur.byMode = cur.byMode && typeof cur.byMode === "object" ? cur.byMode : {};
    cur.portfolioPnlRangeByMode = {
      ...(cur.portfolioPnlRangeByMode && typeof cur.portfolioPnlRangeByMode === "object"
        ? cur.portfolioPnlRangeByMode
        : {}),
      [m]: {
        pnlHistoryRange: payload.pnlHistoryRange === "custom" ? "custom" : "all",
        customRangeStart: String(payload.customRangeStart ?? ""),
        customRangeEnd: String(payload.customRangeEnd ?? ""),
      },
    };
    localStorage.setItem(key, JSON.stringify(cur));
  } catch {
    /* ignore */
  }
  enqueueServerUiPrefsPatch({
    portfolioPnlRangeByMode: {
      [m]: {
        pnlHistoryRange: payload.pnlHistoryRange === "custom" ? "custom" : "all",
        customRangeStart: String(payload.customRangeStart ?? ""),
        customRangeEnd: String(payload.customRangeEnd ?? ""),
      },
    },
  });
}

/** Persist Market Intelligence under-chart panel (localStorage + optional DB ui_prefs). */
export function tradingUiPersistShowMarketIntelligencePanel(show: boolean, userTag?: string | null) {
  try {
    const key = tradingUiStorageKey(userTag);
    const cur = loadTradingUiPrefs(userTag) || { v: 1 as const, byMode: {} };
    cur.v = 1;
    cur.byMode = cur.byMode && typeof cur.byMode === "object" ? cur.byMode : {};
    cur.showMarketIntelligencePanel = Boolean(show);
    localStorage.setItem(key, JSON.stringify(cur));
  } catch {
    /* ignore */
  }
  enqueueServerUiPrefsPatch({ showMarketIntelligencePanel: Boolean(show) });
}

/** Apply saved preference into Zustand (avoids circular imports from `ws/store.ts`). */
export async function syncShowMarketIntelligencePanelFromStorage(userTag?: string | null) {
  const prefs = loadTradingUiPrefs(userTag);
  if (!prefs || typeof prefs.showMarketIntelligencePanel !== "boolean") return;
  const { useAppStore } = await import("../ws/store");
  useAppStore.setState({ showMarketIntelligencePanel: prefs.showMarketIntelligencePanel });
}
