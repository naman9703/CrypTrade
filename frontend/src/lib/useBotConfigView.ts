import { activeInstanceIdForMode } from "./instanceConfigView";
import { tradingModeToApiModeSlug } from "./tradingModeSlug";
import { useAppStore } from "../ws/store";

/** Stable empty view — avoids new `{}` reference every render while cache is loading. */
const EMPTY_CONFIG_VIEW: Record<string, unknown> = Object.freeze({});

/**
 * Isolated strategy-config view for TradingPanel.
 * Single store selector — WS runtime ticks (account/positions) do not re-render config fields.
 */
export function useBotConfigView(): Record<string, unknown> {
  return useAppStore((s) => {
    const modeSlug = tradingModeToApiModeSlug(s.mode);
    const instanceId = activeInstanceIdForMode(s, modeSlug);
    // Bump revision subscription (per-mode + per-instance when cached).
    void (s.configViewSeqByMode[modeSlug] ?? 0);
    if (instanceId) {
      void s.configViewByInstanceId[instanceId];
      const instView = s.configViewByInstanceId[instanceId];
      if (instView && typeof instView === "object" && !Array.isArray(instView)) {
        return instView as Record<string, unknown>;
      }
      /** Never fall back to mode-level view — it holds the *previous* instance's config. */
      return EMPTY_CONFIG_VIEW;
    }
    const modeView = s.configViewByMode[modeSlug];
    if (modeView && typeof modeView === "object" && !Array.isArray(modeView)) {
      return modeView as Record<string, unknown>;
    }
    return EMPTY_CONFIG_VIEW;
  });
}
