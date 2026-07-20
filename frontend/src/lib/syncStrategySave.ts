import { noteStrategySaveWsAckGuard as pinStrategySaveWsAckGuard } from "./configPatchInFlight";
import { mapApiStrategyVersion } from "./strategyApiMappers";
import type { Strategy } from "../types/strategy";
import type { ApiTradingModeSlug } from "./tradingModeSlug";

/** WS/runtime fields — never treat as strategy save ack guards or config fingerprint. */
export const RUNTIME_BOT_KEYS = new Set([
  "feed",
  "account",
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
]);

/** Overlay live-engine counters onto view bot without rebuilding the config slice. */
export function runtimeBotOverlayFromPayload(live: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(live)) {
    if (RUNTIME_BOT_KEYS.has(key)) out[key] = value;
  }
  return out;
}

/** Extend WS ack guards so multiplex `state` frames cannot revert a fresh Save. */
export function noteStrategySaveWsAckGuard(savedBot: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(savedBot)) {
    if (RUNTIME_BOT_KEYS.has(key)) continue;
    patch[key] = value;
  }
  if (Object.keys(patch).length) {
    pinStrategySaveWsAckGuard(patch);
  }
}

export type RecentStrategySave = {
  versionId: string;
  cfgRaw: Record<string, unknown>;
  savedAt: number;
};

/** Prevent list refetch from briefly replacing cfgRaw we just got from Save. */
export function mergeStrategyListWithRecentSave(
  incoming: Strategy[],
  prevList: Strategy[],
  recent: RecentStrategySave | null | undefined,
): Strategy[] {
  if (!recent?.versionId || !recent.cfgRaw) return incoming;
  const maxAgeMs = 24 * 60 * 60 * 1000;
  if (Date.now() - recent.savedAt > maxAgeMs) return incoming;

  return incoming.map((st) => {
    const lv = st.latestVersion;
    if (!lv || lv.id !== recent.versionId) return st;
    const prev = prevList.find((p) => p.id === st.id);
    const prevLv = prev?.latestVersion;
    if (prevLv?.id === recent.versionId && prevLv.cfgRaw) {
      return { ...st, latestVersion: { ...lv, cfgRaw: prevLv.cfgRaw } };
    }
    return { ...st, latestVersion: { ...lv, cfgRaw: recent.cfgRaw } };
  });
}

export function recentSaveFromVersionRaw(
  versionRaw: unknown,
): RecentStrategySave | null {
  const ver = mapApiStrategyVersion(versionRaw);
  if (!ver?.id) return null;
  return {
    versionId: ver.id,
    cfgRaw: (ver.cfgRaw ?? {}) as Record<string, unknown>,
    savedAt: Date.now(),
  };
}

export type ApiTradingModeSlugReexport = ApiTradingModeSlug;
