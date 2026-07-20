/**
 * Per–manual-strategy config slices inside one strategy version cfg_raw.
 *
 * Shape:
 *   { v, bot: { ...activeSlice }, byStrategy: { SUPERTREND_ELITE: {...}, SR_INTRADAY: {...} } }
 *
 * Save updates only byStrategy[manualStrategy]; other slices are preserved.
 */

import { stripInstanceFieldsFromCfgRaw } from "./strategyInstanceSplit.js";
import { SIGNAL_BRAIN_BOT_KEYS } from "./strategySignalBrainKeys.js";
import { buildAllowedKeySet, getStrategyProfile, sanitizeCfgForStrategy } from "../strategy/strategyConfigProfile.js";

const RUNTIME_POLLUTION_SET = new Set([
  "account", "feed", "depth", "decisionEngine", "execLog", "exchange", "exchangeStatus",
  "lastAi", "lastDecision", "lastRegime", "lastStopReason", "lastSurfPulseMl", "lastTradeBlock",
  "metrics", "mode", "paused", "pendingAutoRestartAfterFeedStale", "pendingSupertrendAction",
  "pendingSupertrendBreakout", "performance", "positions", "riskGuards", "rlBandit", "running",
  "topStrategies", "supertrendLast", "supertrendLastBarClose", "supertrendLastFlipBarClose",
  "supertrendSignalHistory", "multiCoinSignalTabSymbols", "multiSymbolWatchSignals",
  "feedExecutionPause", "futuresAuthError", "leverage",
]);

function pickSignalBrainBot(flat) {
  const out = {};
  if (!flat || typeof flat !== "object") return out;
  for (const key of SIGNAL_BRAIN_BOT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(flat, key)) out[key] = flat[key];
  }
  return out;
}

function stripRuntimePollutionFromBot(bot) {
  if (!bot || typeof bot !== "object") return bot;
  for (const key of RUNTIME_POLLUTION_SET) {
    if (Object.prototype.hasOwnProperty.call(bot, key)) delete bot[key];
  }
  return bot;
}

function mergeMissingSignalBrainBot(target, source) {
  if (!target || typeof target !== "object" || !source || typeof source !== "object") return target;
  const manual = String(target.manualStrategy ?? source.manualStrategy ?? "").toUpperCase();
  const allowed = buildAllowedKeySet(getStrategyProfile(manual));
  for (const key of SIGNAL_BRAIN_BOT_KEYS) {
    if (!allowed.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(target, key) && Object.prototype.hasOwnProperty.call(source, key)) {
      target[key] = source[key];
    }
  }
  return target;
}

export const BY_STRATEGY_ROOT_KEY = "byStrategy";

export function normalizeManualStrategyKey(v) {
  return String(v ?? "").trim().toUpperCase() || "BASELINE";
}

function pickBot(cfgRaw) {
  if (!cfgRaw || typeof cfgRaw !== "object") return {};
  return cfgRaw.bot && typeof cfgRaw.bot === "object" ? cfgRaw.bot : cfgRaw;
}

export function getByStrategyMap(cfgRaw) {
  const m = cfgRaw?.[BY_STRATEGY_ROOT_KEY];
  if (!m || typeof m !== "object" || Array.isArray(m)) return {};
  return m;
}

function wrapWithSlices(activeBot, cfgRaw, byStrategy) {
  const out = {
    v: cfgRaw?.v ?? 1,
    bot: activeBot,
    [BY_STRATEGY_ROOT_KEY]: byStrategy,
  };
  if (cfgRaw?.tradingFormDefaults && typeof cfgRaw.tradingFormDefaults === "object") {
    out.tradingFormDefaults = { ...cfgRaw.tradingFormDefaults };
  }
  return out;
}

/** Legacy flat cfg_raw → seed byStrategy from current manualStrategy slice. */
export function ensureByStrategyFromLegacy(cfgRaw) {
  if (!cfgRaw || typeof cfgRaw !== "object") return { v: 1, bot: {}, [BY_STRATEGY_ROOT_KEY]: {} };
  const byStrategy = { ...getByStrategyMap(cfgRaw) };
  if (Object.keys(byStrategy).length > 0) {
    return { ...cfgRaw, [BY_STRATEGY_ROOT_KEY]: byStrategy };
  }
  const bot = pickBot(cfgRaw);
  const manual = normalizeManualStrategyKey(bot.manualStrategy);
  const slice = sanitizeCfgForStrategy(manual, pickSignalBrainBot(bot), { phase: "save" });
  if (Object.keys(slice).length > 0) {
    byStrategy[manual] = slice;
  }
  return { ...cfgRaw, [BY_STRATEGY_ROOT_KEY]: byStrategy };
}

export function buildActiveBotFromSlices(byStrategy, manualStrategy) {
  const manual = normalizeManualStrategyKey(manualStrategy);
  const slice = byStrategy[manual];
  if (!slice || typeof slice !== "object") {
    return { manualStrategy: manual, strategyMode: String(slice?.strategyMode ?? "MANUAL") };
  }
  return { ...slice, manualStrategy: manual };
}

/**
 * Merge a save payload into byStrategy and rebuild active `bot`.
 * @param {Record<string, unknown>} cfgRaw — may include existing byStrategy
 * @param {{ fillFrom?: Record<string, unknown>|null }} [opts]
 */
export function persistCfgRawWithStrategySlices(cfgRaw, { fillFrom = null } = {}) {
  const root = ensureByStrategyFromLegacy(cfgRaw && typeof cfgRaw === "object" ? { ...cfgRaw } : { v: 1, bot: {} });
  const flat = { ...pickBot(root) };
  if (fillFrom && typeof fillFrom === "object") {
    mergeMissingSignalBrainBot(flat, pickBot(fillFrom));
  }
  stripRuntimePollutionFromBot(flat);

  const manual = normalizeManualStrategyKey(flat.manualStrategy);
  const byStrategy = { ...getByStrategyMap(root) };
  byStrategy[manual] = sanitizeCfgForStrategy(manual, pickSignalBrainBot(flat), { phase: "save" });

  const activeBot = sanitizeCfgForStrategy(manual, buildActiveBotFromSlices(byStrategy, manual), {
    phase: "runtime",
  });

  return stripInstanceFieldsFromCfgRaw(wrapWithSlices(activeBot, root, byStrategy));
}

/**
 * Apply intraday engine materialization before strategy Save (parity with backtest worker).
 * Stops stale SMC/SR keys on the live engine from persisting when a preset draft was applied.
 */
export async function materializeStrategyCfgRawForSave(cfgRaw) {
  if (!cfgRaw || typeof cfgRaw !== "object") return cfgRaw;
  const root = { ...cfgRaw };
  const bot = pickBot(root);
  const manual = String(bot.manualStrategy ?? "").toUpperCase();
  if (manual !== "SR_INTRADAY" && manual !== "INTRADAY_PRO") return cfgRaw;
  const { materializeIntradayEngineCfgSync } = await import("../strategy/presets/srIntradayOptimized.js");
  const { materializeIntradayPanelOnCfg } = await import("../strategy/intradayPanelKeys.js");
  const materialized = materializeIntradayEngineCfgSync({ ...bot }, materializeIntradayPanelOnCfg);
  if (root.bot && typeof root.bot === "object") {
    return { ...root, bot: materialized };
  }
  return { ...root, ...materialized };
}

/** Expand byStrategy into active `bot` for engine reload (preserves all slices). */
export function hydrateCfgRawForEngine(cfgRaw) {
  if (!cfgRaw || typeof cfgRaw !== "object") return { v: 1, bot: {}, [BY_STRATEGY_ROOT_KEY]: {} };
  const root = ensureByStrategyFromLegacy({ ...cfgRaw });
  const byStrategy = { ...getByStrategyMap(root) };
  const manual = normalizeManualStrategyKey(pickBot(root).manualStrategy);
  const activeBot = sanitizeCfgForStrategy(manual, buildActiveBotFromSlices(byStrategy, manual), {
    phase: "runtime",
  });
  return stripInstanceFieldsFromCfgRaw(wrapWithSlices(activeBot, root, byStrategy));
}

export function getStrategySlice(cfgRaw, manualStrategy) {
  const root = ensureByStrategyFromLegacy(cfgRaw && typeof cfgRaw === "object" ? cfgRaw : {});
  const byStrategy = getByStrategyMap(root);
  const manual = normalizeManualStrategyKey(manualStrategy);
  return byStrategy[manual] && typeof byStrategy[manual] === "object"
    ? { ...byStrategy[manual], manualStrategy: manual }
    : null;
}
