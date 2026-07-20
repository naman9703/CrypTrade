import type { BotInstance } from "../types/instance";

/** Strategy bound to the active instance tab for this mode (shown with ★ in the sidebar). */
export function resolveInUseStrategyId(
  instances: BotInstance[],
  activeInstanceId: string | null | undefined,
): string | null {
  if (!activeInstanceId) return null;
  const inst = instances.find((i) => i.id === activeInstanceId);
  const sid = inst?.strategyId;
  return typeof sid === "string" && sid.trim().length ? sid.trim() : null;
}

export function isStrategyInUseForInstance(
  strategyId: string,
  instances: BotInstance[],
  activeInstanceId: string | null | undefined,
): boolean {
  return resolveInUseStrategyId(instances, activeInstanceId) === strategyId;
}
