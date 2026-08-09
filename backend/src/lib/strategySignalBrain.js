/**
 * Strategy signal-brain sanitization — single path for Save, reload, and backtest snapshots.
 *
 * Goal: persisted cfg_raw and frozen backtest `config_snapshot` contain ONLY strategy
 * parameters (same key set as `buildTradingConfigPersistPayload`), never live runtime
 * state (`feed`, `account`, `lastDecision`, …). Backtest then replays the same logic
 * the live bot uses for that saved configuration.
 */

import { INSTANCE_FIELD_KEYS, stripInstanceFieldsFromCfgRaw } from "./strategyInstanceSplit.js";
import { SIGNAL_BRAIN_BOT_KEYS } from "./strategySignalBrainKeys.js";
import { buildAllowedKeySet, getStrategyProfile, sanitizeCfgForStrategy } from "../strategy/strategyConfigProfile.js";
import {
  hydrateCfgRawForEngine,
  persistCfgRawWithStrategySlices,
  getStrategySlice,
} from "./strategyConfigSlices.js";

export { getStrategySlice, hydrateCfgRawForEngine } from "./strategyConfigSlices.js";

const SIGNAL_BRAIN_KEY_SET = new Set(SIGNAL_BRAIN_BOT_KEYS);

/** Keys learned at runtime — never persist or freeze into backtest snapshots. */
export const RUNTIME_POLLUTION_BOT_KEYS = Object.freeze([
  "account",
  "feed",
  "depth",
  "decisionEngine",
  "execLog",
  "exchange",
  "exchangeStatus",
  "lastAi",
  "lastDecision",
  "lastRegime",
  "lastStopReason",
  "lastSurfPulseMl",
  "lastTradeBlock",
  "metrics",
  "mode",
  "paused",
  "pendingAutoRestartAfterFeedStale",
  "pendingSupertrendAction",
  "pendingSupertrendBreakout",
  "performance",
  "positions",
  "riskGuards",
  "rlBandit",
  "running",
  "topStrategies",
  "supertrendLast",
  "supertrendLastBarClose",
  "supertrendLastFlipBarClose",
  "supertrendSignalHistory",
  "multiCoinSignalTabSymbols",
  "multiSymbolWatchSignals",
  "feedExecutionPause",
  "futuresAuthError",
  "leverage",
]);

const RUNTIME_POLLUTION_SET = new Set(RUNTIME_POLLUTION_BOT_KEYS);

/** Per-run metadata stored on backtest snapshots (not part of strategy version cfg_raw). */
export const BACKTEST_SNAPSHOT_META_KEYS = Object.freeze([
  "backtestPositionSizing",
  "portfolioPositionSizing",
  "backtestTrailMicroTf",
  "backtestTrailActivationOn",
  "backtestTrailPriceSource",
  "_engineVersion",
  "_intradayEngineMaterialized",
  "_intradayEngineMaterializedAt",
  "_backtestOperationalOverlayAt",
  "_livePanelOverlayAt",
  "symbol",
  "timeframe",
  "symbolMode",
  "marketMode",
  "universe",
  "universeCoinSelectMode",
  "universePinnedSymbols",
  "universeCoinBase",
  "universeCustomSymbols",
  "universePinnedSymbol",
  "universePinControl",
  "universeAutoCoinPick",
  "riskPerTrade",
  "riskPerTradeUnit",
  "maxDailyLoss",
  "maxDailyLossUnit",
  "allowedBudgetInputMode",
  "allowedBudgetUsdt",
  "allowedBudgetWalletPct",
  "capitalAllotmentCompoundPnlUi",
  "futuresLeverage",
  "futuresLeverageMode",
  "supertrendXgbGateEnabled",
  "supertrendXgbThreshold",
  "supertrendXgbIgnoreTrainingCutoff",
  "supertrendXgbFailClosed",
  "supertrendStretchSkipEnabled",
  "supertrendStretchEma20Pct",
  "supertrendStretchRsiHigh",
  "supertrendStretchRsiLow",
]);

const INSTANCE_FIELD_SET = new Set(INSTANCE_FIELD_KEYS);
const BACKTEST_META_SET = new Set(BACKTEST_SNAPSHOT_META_KEYS);

function pickBot(cfgRaw) {
  if (!cfgRaw || typeof cfgRaw !== "object") return {};
  return cfgRaw.bot && typeof cfgRaw.bot === "object" ? cfgRaw.bot : cfgRaw;
}

function wrapBot(bot, cfgRaw) {
  const v = cfgRaw?.v ?? 1;
  const out = { v, bot };
  if (cfgRaw?.tradingFormDefaults && typeof cfgRaw.tradingFormDefaults === "object") {
    out.tradingFormDefaults = { ...cfgRaw.tradingFormDefaults };
  }
  return out;
}

/** Copy missing signal-brain keys from `source` onto `target` (does not override explicit values). */
export function mergeMissingSignalBrainBot(target, source) {
  if (!target || typeof target !== "object" || !source || typeof source !== "object") return target;
  const manual = String(target.manualStrategy ?? source.manualStrategy ?? "").toUpperCase();
  const allowed = buildAllowedKeySet(getStrategyProfile(manual));
  for (const key of SIGNAL_BRAIN_BOT_KEYS) {
    if (INSTANCE_FIELD_SET.has(key)) continue;
    if (!allowed.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(target, key) && Object.prototype.hasOwnProperty.call(source, key)) {
      target[key] = source[key];
    }
  }
  return target;
}

/** Keep only canonical signal-brain keys (matches live persist payload). */
export function pickSignalBrainBot(flat) {
  const out = {};
  if (!flat || typeof flat !== "object") return out;
  for (const key of SIGNAL_BRAIN_BOT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(flat, key)) out[key] = flat[key];
  }
  return out;
}

export function stripRuntimePollutionFromBot(bot) {
  if (!bot || typeof bot !== "object") return bot;
  for (const key of RUNTIME_POLLUTION_BOT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(bot, key)) delete bot[key];
  }
  return bot;
}

/**
 * Sanitize strategy version cfg_raw before DB write or engine reload.
 * @param {Record<string, unknown>|null|undefined} cfgRaw
 * @param {{ fillFrom?: Record<string, unknown>|null, hydrate?: boolean }} [opts]
 */
export function sanitizeSignalBrainCfgRaw(cfgRaw, { fillFrom = null, hydrate = false } = {}) {
  if (!cfgRaw || typeof cfgRaw !== "object") {
    return hydrate ? hydrateCfgRawForEngine({ v: 1, bot: {} }) : persistCfgRawWithStrategySlices({ v: 1, bot: {} }, { fillFrom });
  }
  if (hydrate) return hydrateCfgRawForEngine(cfgRaw);
  return persistCfgRawWithStrategySlices(cfgRaw, { fillFrom });
}

/**
 * Sanitize a backtest `config_snapshot` before INSERT: signal brain + instance ops +
 * backtest meta only — never live WS/runtime fields.
 */
export function sanitizeBacktestConfigSnapshot(cfgRaw) {
  if (!cfgRaw || typeof cfgRaw !== "object") return { v: 1, bot: {} };
  const srcBot = pickBot(cfgRaw);
  const brain = pickSignalBrainBot(srcBot);
  const manual = String(brain.manualStrategy ?? srcBot.manualStrategy ?? "").toUpperCase();
  const scoped = sanitizeCfgForStrategy(manual, brain, { phase: "snapshot" });
  const outBot = { ...scoped };

  for (const key of BACKTEST_SNAPSHOT_META_KEYS) {
    if (Object.prototype.hasOwnProperty.call(srcBot, key)) outBot[key] = srcBot[key];
  }

  stripRuntimePollutionFromBot(outBot);

  const allowed = buildAllowedKeySet(getStrategyProfile(manual));
  // Drop stray keys that are neither signal brain, instance, nor backtest meta.
  for (const key of Object.keys(outBot)) {
    if (allowed.has(key)) continue;
    if (BACKTEST_META_SET.has(key)) continue;
    delete outBot[key];
  }

  return wrapBot(outBot, cfgRaw);
}

export function isRuntimePollutionKey(key) {
  return RUNTIME_POLLUTION_SET.has(key);
}
