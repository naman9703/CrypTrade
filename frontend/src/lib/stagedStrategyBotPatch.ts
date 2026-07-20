import { api } from "../api/client";
import type { ApiTradingModeSlug } from "./tradingModeSlug";
import { tradingModeToApiModeSlug } from "./tradingModeSlug";
import { activeInstanceIdForMode } from "./instanceConfigView";
import {
  canonicalCfgRawFromUiBot,
  instanceOperationalFromUiBot,
} from "./strategyBrainSnapshot";
import { deriveViewBot, draftByModeWithInstanceContext, useAppStore } from "../ws/store";

/** Update UI state immediately; no network until Save. */
export function stageStrategyBotPatch(patch: Record<string, unknown>): void {
  if (!patch || typeof patch !== "object") return;
  const store = useAppStore.getState();
  const modeSlug = tradingModeToApiModeSlug(store.mode);
  store.stageDraftBotPatch(modeSlug, patch);
}

/**
 * Preset buttons — replace the whole draft (do not accumulate stale keys from prior edits).
 * Instant UI + Save payload; no live-bot HTTP.
 */
export function applyStrategyPresetPatch(patch: Record<string, unknown>): void {
  if (!patch || typeof patch !== "object") return;
  const store = useAppStore.getState();
  const modeSlug = tradingModeToApiModeSlug(store.mode);
  store.replaceDraftBotPatch(modeSlug, patch);
}

/**
 * Authoritative Save payload from the current view (live + draft), not a stale cache.
 * Call at Save click time so WS ticks cannot revert preset fields before persist.
 */
export function buildStrategySavePayloadForMode(modeSlug: ApiTradingModeSlug): {
  cfgRaw: Record<string, unknown>;
  instanceOperational: Record<string, unknown>;
} {
  const st = useAppStore.getState();
  const instanceId = activeInstanceIdForMode(st, modeSlug);
  const live =
    st.liveBot && typeof st.liveBot === "object" && !Array.isArray(st.liveBot)
      ? (st.liveBot as Record<string, unknown>)
      : st.bot && typeof st.bot === "object" && !Array.isArray(st.bot)
        ? (st.bot as Record<string, unknown>)
        : {};
  const draftCtx = draftByModeWithInstanceContext(st, modeSlug);
  const hasDraft = st.hasDraftBotPatch(modeSlug);
  const instView = instanceId ? st.configViewByInstanceId[instanceId] : undefined;
  const view = hasDraft
    ? deriveViewBot(st.mode, live, draftCtx)
    : ((instView as Record<string, unknown> | undefined) ??
      (st.configViewByMode[modeSlug] as Record<string, unknown> | undefined) ??
      deriveViewBot(st.mode, live, draftCtx));
  return {
    cfgRaw: canonicalCfgRawFromUiBot(view),
    instanceOperational: instanceOperationalFromUiBot(view),
  };
}

/** Optional background sync of staged edits to the running engine (not required for Save). */
export function syncStagedPatchToLiveBotInBackground(
  explicitPatch?: Record<string, unknown>,
): void {
  void flushStagedStrategyBotPatch(explicitPatch).catch(() => {});
}

/** Sync staged edits to the running bot config before strategy version persist. */
export async function flushStagedStrategyBotPatch(
  explicitPatch?: Record<string, unknown>,
): Promise<void> {
  const store = useAppStore.getState();
  const modeSlug = tradingModeToApiModeSlug(store.mode);
  const patch =
    explicitPatch && Object.keys(explicitPatch).length > 0
      ? explicitPatch
      : store.getDraftBotPatch(modeSlug);
  if (!patch || Object.keys(patch).length === 0) return;
  await api.botConfig(patch);
}

/** Read-only snapshot so WS/HTTP refresh can keep unsaved draft values visible. */
export function getStagedStrategyBotPatch(): Record<string, unknown> {
  const store = useAppStore.getState();
  const modeSlug = tradingModeToApiModeSlug(store.mode);
  return store.getDraftBotPatch(modeSlug);
}

export function clearStagedStrategyBotPatch(): void {
  const store = useAppStore.getState();
  const modeSlug = tradingModeToApiModeSlug(store.mode);
  store.clearDraftBotPatch(modeSlug);
}
