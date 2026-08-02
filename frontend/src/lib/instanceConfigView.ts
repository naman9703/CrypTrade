import type { ApiTradingModeSlug } from "./tradingModeSlug";
import { pickBotFromStrategyVersion } from "./strategyVersionDisplay.ts";
import type { BotInstance } from "../types/instance";
import type { Strategy, StrategyVersion } from "../types/strategy";

type InstanceConfigState = {
  activeInstanceByMode: Record<ApiTradingModeSlug, string | null>;
  selectedInstanceId?: string | null;
  instanceConfigLoadingId?: string | null;
  mainView?: string;
  instancesByMode: Partial<Record<ApiTradingModeSlug, BotInstance[]>>;
  strategiesByMode: Partial<Record<ApiTradingModeSlug, Strategy[]>>;
  versionsByStrategyId: Record<string, StrategyVersion[]>;
  configViewByInstanceId?: Record<string, Record<string, unknown>>;
};

/**
 * Instance id used for config display.
 * During tab switch, `selectedInstanceId` wins over stale `activeInstanceByMode` until engine catches up.
 */
export function activeInstanceIdForMode(
  s: Pick<
    InstanceConfigState,
    "activeInstanceByMode" | "selectedInstanceId" | "instanceConfigLoadingId" | "mainView"
  >,
  modeSlug: ApiTradingModeSlug,
): string | null {
  const sel = typeof s.selectedInstanceId === "string" ? s.selectedInstanceId.trim() : "";
  const boundRaw = s.activeInstanceByMode[modeSlug];
  const bound = typeof boundRaw === "string" ? boundRaw.trim() : "";
  const loading =
    typeof s.instanceConfigLoadingId === "string" ? s.instanceConfigLoadingId.trim() : "";

  if (sel) {
    const inInstanceView = s.mainView === "instance";
    const switchInFlight = loading === sel;
    const boundStale = bound && sel !== bound;
    if (inInstanceView || switchInFlight || boundStale) return sel;
  }
  if (bound) return bound;
  if (sel) return sel;
  return null;
}

export function findInstanceInState(
  s: InstanceConfigState,
  modeSlug: ApiTradingModeSlug,
  instanceId: string,
): BotInstance | null {
  const list = s.instancesByMode[modeSlug] ?? [];
  return list.find((i) => i.id === instanceId) ?? null;
}

export function resolveStrategyVersionForInstance(
  s: InstanceConfigState,
  modeSlug: ApiTradingModeSlug,
  instance: BotInstance,
): StrategyVersion | null {
  const vid = instance.strategyVersionId;
  if (!vid) return null;
  const strategies = s.strategiesByMode[modeSlug] ?? [];
  for (const st of strategies) {
    if (st.latestVersion?.id === vid) return st.latestVersion;
    const hit = (s.versionsByStrategyId[st.id] ?? []).find((v) => v.id === vid);
    if (hit) return hit;
  }
  if (instance.strategyId) {
    const hit = (s.versionsByStrategyId[instance.strategyId] ?? []).find((v) => v.id === vid);
    if (hit) return hit;
  }
  return null;
}

/** Merge instance operational fields onto strategy-version bot snapshot. */
export function applyInstanceOperationalToBot(
  bot: Record<string, unknown>,
  instance: BotInstance,
): Record<string, unknown> {
  const out = { ...bot };
  const op = instance.operational;
  if (!op) return out;
  if (op.symbol != null && String(op.symbol).trim()) out.symbol = String(op.symbol).toUpperCase();
  if (op.timeframe != null && String(op.timeframe).trim()) out.timeframe = String(op.timeframe);
  if (op.marketMode != null) out.marketMode = op.marketMode;
  if (op.symbolMode != null) out.symbolMode = op.symbolMode;
  if (op.universe != null && typeof op.universe === "object" && !Array.isArray(op.universe)) {
    out.universe = op.universe;
    const u = op.universe as Record<string, unknown>;
    if (u.mode != null) out.universeCoinSelectMode = u.mode;
    if (u.pinnedSymbols != null) out.universePinnedSymbols = u.pinnedSymbols;
    if (u.coinBase != null) out.universeCoinBase = u.coinBase;
    if (u.customSymbols != null) out.universeCustomSymbols = u.customSymbols;
    if (u.autoCoinPick != null) out.universeAutoCoinPick = u.autoCoinPick;
  }
  if (op.riskPerTrade != null) out.riskPerTrade = op.riskPerTrade;
  if (op.riskUnit != null) out.riskPerTradeUnit = op.riskUnit;
  if (op.maxDailyLoss != null) out.maxDailyLoss = op.maxDailyLoss;
  if (op.maxDailyLossUnit != null) out.maxDailyLossUnit = op.maxDailyLossUnit;
  if (op.compoundPnl != null) out.compoundPnl = op.compoundPnl;
  return out;
}

/**
 * Build a bot view from cached instance data (no live engine).
 * Used for instant tab switch before `/active-instance` returns.
 */
export function buildBotViewFromInstanceSnapshot(
  s: InstanceConfigState,
  modeSlug: ApiTradingModeSlug,
  instanceId: string,
): Record<string, unknown> | null {
  const cached = s.configViewByInstanceId?.[instanceId];
  if (cached && typeof cached === "object" && !Array.isArray(cached)) {
    return { ...cached };
  }
  const inst = findInstanceInState(s, modeSlug, instanceId);
  if (!inst) return null;
  const ver = resolveStrategyVersionForInstance(s, modeSlug, inst);
  if (!ver) return null;
  const base = pickBotFromStrategyVersion(ver);
  if (!base || typeof base !== "object") return null;
  return applyInstanceOperationalToBot(base as Record<string, unknown>, inst);
}

export function draftForInstance(
  draftByInstanceId: Record<string, Record<string, unknown>>,
  instanceId: string | null,
): Record<string, unknown> {
  if (!instanceId) return {};
  return { ...(draftByInstanceId[instanceId] ?? {}) };
}

export function hasDraftForInstance(
  draftByInstanceId: Record<string, Record<string, unknown>>,
  instanceId: string | null,
): boolean {
  if (!instanceId) return false;
  return Object.keys(draftByInstanceId[instanceId] ?? {}).length > 0;
}

/**
 * Pre-build per-instance config snapshots from loaded strategies + instances.
 * Makes tab switches instant without waiting on `/active-instance`.
 */
export function warmInstanceConfigCachePatch(
  s: InstanceConfigState,
  modeSlug: ApiTradingModeSlug,
): Record<string, Record<string, unknown>> | null {
  const instances = s.instancesByMode[modeSlug] ?? [];
  if (!instances.length) return null;
  const next = { ...(s.configViewByInstanceId ?? {}) };
  let changed = false;
  for (const inst of instances) {
    if (next[inst.id]) continue;
    const snap = buildBotViewFromInstanceSnapshot(s, modeSlug, inst.id);
    if (!snap) continue;
    next[inst.id] = snap;
    changed = true;
  }
  return changed ? next : null;
}
