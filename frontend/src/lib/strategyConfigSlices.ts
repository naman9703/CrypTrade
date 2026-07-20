/**
 * Frontend helpers for cfg_raw.byStrategy slices.
 */

import { filterBotForProfile, profileAllowsKey } from "./strategyConfigProfile.ts";

export const BY_STRATEGY_ROOT_KEY = "byStrategy";

export function normalizeManualStrategyKey(v: string | null | undefined): string {
  return String(v ?? "").trim().toUpperCase() || "BASELINE";
}

export function pickBotFromCfgRaw(cfgRaw: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!cfgRaw || typeof cfgRaw !== "object") return {};
  if (cfgRaw.bot && typeof cfgRaw.bot === "object" && !Array.isArray(cfgRaw.bot)) {
    return cfgRaw.bot as Record<string, unknown>;
  }
  return cfgRaw as Record<string, unknown>;
}

export function getByStrategyMap(cfgRaw: Record<string, unknown> | null | undefined): Record<string, Record<string, unknown>> {
  const m = cfgRaw?.[BY_STRATEGY_ROOT_KEY];
  if (!m || typeof m !== "object" || Array.isArray(m)) return {};
  return m as Record<string, Record<string, unknown>>;
}

/** Saved slice for a path, or legacy profile-filtered bot fallback. */
export function strategySliceFromCfgRaw(
  cfgRaw: Record<string, unknown> | null | undefined,
  manualStrategy: string | null | undefined,
): Record<string, unknown> {
  const manual = normalizeManualStrategyKey(manualStrategy);
  const by = getByStrategyMap(cfgRaw);
  const slice = by[manual];
  if (slice && typeof slice === "object") {
    return { ...slice, manualStrategy: manual };
  }
  return { ...filterBotForProfile(pickBotFromCfgRaw(cfgRaw), manual), manualStrategy: manual };
}

/** Extract profile-scoped keys from live bot for in-session slice stash. */
export function extractProfileSliceFromBot(
  bot: Record<string, unknown> | null | undefined,
  manualStrategy: string | null | undefined,
): Record<string, unknown> {
  if (!bot || typeof bot !== "object") return { manualStrategy: normalizeManualStrategyKey(manualStrategy) };
  return filterBotForProfile(bot, manualStrategy);
}

/** Bot shape used for dirty compare vs saved cfg_raw (active slice only). */
export function cfgRawActiveBotForCompare(cfgRaw: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const flat = pickBotFromCfgRaw(cfgRaw);
  const manual = normalizeManualStrategyKey(flat.manualStrategy);
  return strategySliceFromCfgRaw(cfgRaw, manual);
}

/** Merge saved slice + optional draft into a path-switch patch (drops foreign profile keys). */
export function buildManualStrategySwitchPatch(
  liveBot: Record<string, unknown>,
  newManualStrategy: string,
  savedCfgRaw: Record<string, unknown> | null | undefined,
  draftSlice: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const manual = normalizeManualStrategyKey(newManualStrategy);
  const saved = strategySliceFromCfgRaw(savedCfgRaw, manual);
  const draft = draftSlice && typeof draftSlice === "object" ? draftSlice : {};
  const merged: Record<string, unknown> = {
    strategyMode: "MANUAL",
    manualStrategy: manual,
  };
  for (const [key, value] of Object.entries(liveBot)) {
    if (profileAllowsKey(key, manual)) merged[key] = value;
  }
  Object.assign(merged, saved, draft, { manualStrategy: manual, strategyMode: "MANUAL" });
  return merged;
}
