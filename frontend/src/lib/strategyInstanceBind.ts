import { api } from "../api/client";
import type { ApiTradingModeSlug } from "./tradingModeSlug";
import type { BotInstance } from "../types/instance";

/** Apply bind-strategy API payload into the zustand store (instance + bot + prefs). */
export async function applyBindInstanceStrategyResponse(
  modeSlug: ApiTradingModeSlug,
  instanceId: string,
  data: {
    instance?: BotInstance;
    bot?: Record<string, unknown>;
    activeInstanceByMode?: Record<string, string | null>;
    activeStrategyVersionByMode?: Record<string, string | null>;
  },
) {
  const { useAppStore, parseActiveStrategyVersionByModeFromServer } = await import("../ws/store");
  const { noteStrategySaveWsAckGuard } = await import("./syncStrategySave");
  const { enqueueServerUiPrefsPatch } = await import("./tradingUiPersistence");

  if (data.activeInstanceByMode || data.activeStrategyVersionByMode) {
    useAppStore.setState((s) => ({
      activeInstanceByMode: {
        ...s.activeInstanceByMode,
        ...(data.activeInstanceByMode ? { [modeSlug]: instanceId } : {}),
      },
      ...(data.activeStrategyVersionByMode
        ? {
            activeStrategyVersionByMode: parseActiveStrategyVersionByModeFromServer(
              data.activeStrategyVersionByMode,
            ),
          }
        : {}),
    }));
    enqueueServerUiPrefsPatch({
      ...(data.activeInstanceByMode ? { activeInstanceByMode: data.activeInstanceByMode } : {}),
      ...(data.activeStrategyVersionByMode
        ? { activeStrategyVersionByMode: data.activeStrategyVersionByMode }
        : {}),
    });
  }

  if (data.instance) {
    useAppStore.setState((s) => {
      const list = [...(s.instancesByMode[modeSlug] ?? [])];
      const idx = list.findIndex((i) => i.id === instanceId);
      if (idx >= 0) list[idx] = data.instance!;
      else list.push(data.instance!);
      return { instancesByMode: { ...s.instancesByMode, [modeSlug]: list } };
    });
  }

  if (data.bot && typeof data.bot === "object") {
    const botNext = data.bot;
    noteStrategySaveWsAckGuard(botNext);
    const { mergeEngineBotSnapshot } = await import("../ws/store");
    useAppStore.setState((s) => mergeEngineBotSnapshot(s, modeSlug, botNext, { markConfigClean: true }));
  }
  useAppStore.getState().recomputeStrategyConfigDirtyForMode(modeSlug);
}

export async function renameStrategyWithGuard(strategyId: string, name: string): Promise<boolean> {
  const usage = await api.getStrategyUsage(strategyId);
  if (!usage.canRename) {
    throw new Error(usage.renameBlockReason ?? "strategy_instances_busy");
  }
  await api.updateStrategyMeta(strategyId, { name });
  return true;
}
