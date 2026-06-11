import { api } from "../api/client";
import { tradingModeToApiModeSlug } from "./tradingModeSlug";
import { useAppStore } from "../ws/store";

/** Update UI state immediately; no network until Save. */
export function stageStrategyBotPatch(patch: Record<string, unknown>): void {
  if (!patch || typeof patch !== "object") return;
  const store = useAppStore.getState();
  const modeSlug = tradingModeToApiModeSlug(store.mode);
  store.stageDraftBotPatch(modeSlug, patch);
}

/** Sync staged edits to the running bot config before strategy version persist. */
export async function flushStagedStrategyBotPatch(): Promise<void> {
  const store = useAppStore.getState();
  const modeSlug = tradingModeToApiModeSlug(store.mode);
  const patch = store.getDraftBotPatch(modeSlug);
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
