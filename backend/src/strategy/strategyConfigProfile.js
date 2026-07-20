/**
 * Strategy Config Profile — single source of truth for per-strategy allowed keys,
 * prepare hooks, chart markup, and UI sections (Option A + Profile).
 */

import profileData from "./strategyConfigProfile.data.json" with { type: "json" };
import { SIGNAL_BRAIN_BOT_KEYS } from "../lib/strategySignalBrainKeys.js";
import { normalizeEliteStRunCfg } from "./supertrendElite.js";

/** Routing + ST stack + trailing/brackets shared by ST-based strategies. */
export const SHARED_CORE_KEYS = Object.freeze([
  "strategyMode",
  "manualStrategy",
  "marketMode",
  "supertrendPeriod",
  "supertrendMultiplier",
  "supertrendWilderAtr",
  "supertrendSpotAuto",
  "supertrendFuturesAuto",
  "supertrendFuturesEntryOpenStyle",
  "supertrendFuturesExitOnFlip",
  "supertrendFuturesFixedSlPct",
  "supertrendFuturesFixedTpPct",
  "supertrendFuturesUseFixedSl",
  "supertrendFuturesUseFixedTp",
  "supertrendFuturesMaxEntrySlippagePct",
  "supertrendFuturesMaxSignalLagMs",
  "supertrendFuturesIocFallbackMarket",
  "supertrendFuturesRequireBookTicker",
  "supertrendFuturesRequireMarkPrice",
  "supertrendFuturesTwoWay",
  "supertrendFuturesEntryRecheckMs",
  "trailingStopLossAuto",
  "futuresTrailingStopMode",
  "futuresTrailingStAdvanced",
  "futuresTrailingStFeeBreakeven",
  "trailBufferMode",
  "trailBufferRate",
  "trailBufferAtrMult",
  "trailOpenFeeRate",
  "trailCloseFeeRate",
  "trailFeeBeMultiplier",
  "trailMaintMarginRate",
  "trailMinGapFromMarkFrac",
  "trailMinSlDistFrac",
  "trailActivationSlippageFrac",
  "trailT01LockSlippageFrac",
  "trailPostT02ActivationBufferRate",
  "trailPostT02MaxExtraTiers",
  "trailPostT02SpacingFrac",
  "trailSizingMode",
  "trailDynamicBeAtrMult",
  "trailDynamicBeT01LockAtrMult",
  "trailDynamicBeRegimeAdjust",
  "trailDynamicBeRegimeLowMult",
  "trailDynamicBeRegimeHighMult",
  "trailDynamicAdvAtrHwmMult",
  "trailDynamicAdvMfeGivebackFrac",
  "trailDynamicAdvMfeMinR",
  "trailDynamicAdvMergeSupertrend",
  "trailDynamicAdvAtrSource",
  "trailDynamicAdvPostT02StepAtrMult",
  "trailingStopExtraScalpingPcts",
  /** LIQ / intraday partial ladder — not covered by `intraday*` native prefix alone on all builds. */
  "trailOnlyAfterTp2Fill",
  "futuresLeverage",
  "futuresLeverageMode",
  "aiThreshold",
  "backtestPositionSizing",
  "portfolioPositionSizing",
  "backtestBreakevenAtMfePct",
  "backtestChopMfeTrail",
  "backtestChopMfeTrailSides",
  "backtestChopPriorMs",
  "backtestChopPriorAbsMax",
  "backtestChopMfeTrailActivatePct",
  "backtestChopMfeTrailGivebackFrac",
  "tradeHistoryTakerOpenFeeRate",
  "tradeHistoryTakerCloseFeeRate",
  "tradeHistoryMakerOpenFeeRate",
  "tradeHistoryMakerCloseFeeRate",
  "smartSignalStrengthThreshold",
  "smartSignalStrengthThresholdMeta",
  "capitalSplitAcrossCoins",
  "multiTradeUsePctOfUsable",
  "multiTradePctOfUsable",
  "perTradeBudgetCapEnabled",
  "perTradeBudgetInputMode",
  "multiCoinCapitalSizingActive",
  "multiBudgetSplitMode",
  "multiBudgetCoinUsdt",
  "multiBudgetCoinPct",
  "capitalCycleStrategyBalanceUsdt",
  "capitalCyclePoolAnchorUsdt",
  "capitalCycleRealizedPnlUsdt",
  "capitalCycleSymbols",
]);

const SHARED_CORE_SET = new Set(SHARED_CORE_KEYS);

/** Universal overlay groups — keys allowed when profile.overlays includes the group id. */
export const OVERLAY_GROUPS = Object.freeze({
  intelligence: {
    prefixes: ["intelligenceGate"],
  },
  marketDecision: {
    keys: ["marketDecision"],
  },
  moveQuality: {
    prefixes: ["supertrendMoveQuality"],
  },
  bigMove: {
    prefixes: ["supertrendBigMove"],
  },
  signalStrength: {
    prefixes: ["signalStrength"],
  },
  stConfirmation: {
    prefixes: ["supertrendConfirmation", "supertrendBreakout"],
  },
  htf4h: {
    prefixes: ["supertrendHtf4h"],
  },
  futuresAiConfidence: {
    keys: ["supertrendFuturesAiConfidenceFilter", "supertrendFuturesMinAiProb"],
  },
  surfPulseMl: {
    prefixes: ["surfPulseMl"],
  },
  volumeProfileGates: {
    prefixes: ["volumeProfile", "vp", "vpLookback", "vpMinRR", "intradayGateVp", "intradayVp"],
    keys: ["vpLookbackBars", "vpMinRR", "requireVpSetup"],
  },
  intradayGates: {
    prefixes: ["intraday", "srIntraday"],
  },
});

const BASELINE_STRATEGIES = new Set([
  "CONFLUENCE",
  "EMA_CROSS",
  "RSI_MEAN",
  "BREAKOUT_VOL",
  "MOMENTUM_SURGE",
  "ENSEMBLE",
  "TREND_PULLBACK",
  "HTF_RSI",
  "HTF_LEG_RIDER",
  "SMART_REVERSAL",
  "BTC_CONSENSUS",
  "APEX_TREND",
]);

const PROFILE_BY_KEY = profileData.profiles;

/** @typedef {import('./strategyConfigProfile.data.json').profiles[string]} StrategyProfileDef */

/**
 * @param {string|null|undefined} manualStrategy
 * @returns {StrategyProfileDef & { key: string }}
 */
export function getStrategyProfile(manualStrategy) {
  const key = String(manualStrategy ?? "").trim().toUpperCase();
  if (key && PROFILE_BY_KEY[key]) {
    return { key, ...PROFILE_BY_KEY[key] };
  }
  if (BASELINE_STRATEGIES.has(key)) {
    return { key: "baseline", ...PROFILE_BY_KEY.baseline };
  }
  return { key: key || "baseline", ...PROFILE_BY_KEY.baseline };
}

/** @param {string} key @param {ReturnType<typeof getStrategyProfile>} profile */
function keyMatchesNative(key, profile) {
  for (const prefix of profile.nativePrefixes ?? []) {
    if (key.startsWith(prefix)) return true;
  }
  for (const nk of profile.nativeKeys ?? []) {
    if (key === nk) return true;
  }
  return false;
}

/** @param {string} key @param {string} groupId */
function keyMatchesOverlayGroup(key, groupId) {
  const group = OVERLAY_GROUPS[groupId];
  if (!group) return false;
  for (const prefix of group.prefixes ?? []) {
    if (key.startsWith(prefix)) return true;
  }
  for (const k of group.keys ?? []) {
    if (key === k) return true;
  }
  return false;
}

/**
 * Build allowed key set for a profile (intersected with canonical signal-brain keys).
 * @param {ReturnType<typeof getStrategyProfile>} profile
 */
export function buildAllowedKeySet(profile) {
  const allowed = new Set(SHARED_CORE_KEYS);
  for (const key of SIGNAL_BRAIN_BOT_KEYS) {
    if (keyMatchesNative(key, profile)) allowed.add(key);
    for (const og of profile.overlays ?? []) {
      if (keyMatchesOverlayGroup(key, og)) allowed.add(key);
    }
  }
  return allowed;
}

/**
 * @param {Record<string, unknown>} bot
 * @param {ReturnType<typeof getStrategyProfile>} profile
 */
export function pickProfileBot(bot, profile) {
  const allowed = buildAllowedKeySet(profile);
  const out = {};
  if (!bot || typeof bot !== "object") return out;
  for (const key of Object.keys(bot)) {
    if (allowed.has(key)) out[key] = bot[key];
  }
  return out;
}

/** @param {string} key @param {string|null|undefined} manualStrategy */
export function profileAllowsKey(key, manualStrategy) {
  const profile = getStrategyProfile(manualStrategy);
  return buildAllowedKeySet(profile).has(key);
}

/** @param {string|null|undefined} manualStrategy */
export function profileUsesIntradayMaxHold(manualStrategy) {
  return getStrategyProfile(manualStrategy).usesIntradayMaxHold === true;
}

/**
 * @param {ReturnType<typeof getStrategyProfile>} profile
 * @param {Record<string, unknown>} bot
 * @param {"save"|"snapshot"|"runtime"|"display"} phase
 */
function runProfilePrepare(profile, bot, phase) {
  const hook = profile.prepare ?? "none";
  if (hook === "none") return bot;
  // Materialization hooks (intraday/tokyo/crt/situation/regime/vp) run in worker — not at save.
  if (hook !== "elite" && phase !== "runtime") return bot;
  if (hook === "elite") {
    return normalizeEliteStRunCfg(bot);
  }
  return bot;
}

/**
 * Filter cfg to strategy-relevant keys and run profile prepare hook.
 * @param {string|null|undefined} manualStrategy
 * @param {Record<string, unknown>|null|undefined} bot
 * @param {{ phase?: "save"|"snapshot"|"runtime"|"display" }} [opts]
 */
export function sanitizeCfgForStrategy(manualStrategy, bot, { phase = "save" } = {}) {
  if (!bot || typeof bot !== "object") return {};
  const profile = getStrategyProfile(manualStrategy);
  const filtered = pickProfileBot(bot, profile);
  const prepared = runProfilePrepare(profile, filtered, phase);
  return pickProfileBot(prepared, profile);
}

/** Metadata export for frontend sync tests. */
export function exportProfileMetadata() {
  return profileData;
}

/** @param {string|null|undefined} manualStrategy @param {string} sectionId */
export function profileHasUiSection(manualStrategy, sectionId) {
  const profile = getStrategyProfile(manualStrategy);
  return (profile.uiSections ?? []).includes(sectionId);
}
