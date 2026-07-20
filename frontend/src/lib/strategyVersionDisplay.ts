import type { StrategyVersion } from "../types/strategy";

/** Bot subtree from a persisted strategy version (`cfgRaw.bot` or legacy flat). */
export function pickBotFromStrategyVersion(v: StrategyVersion | null | undefined): Record<string, unknown> {
  if (!v) return {};
  const raw = v.cfgRaw ?? {};
  if (raw.bot && typeof raw.bot === "object" && !Array.isArray(raw.bot)) {
    return raw.bot as Record<string, unknown>;
  }
  return raw as Record<string, unknown>;
}

export function strategyVersionMdeEnabled(v: StrategyVersion | null | undefined): boolean {
  const md = pickBotFromStrategyVersion(v).marketDecision;
  return md != null && typeof md === "object" && (md as { enabled?: boolean }).enabled === true;
}

export function strategyVersionPrimaryLabel(v: StrategyVersion | null | undefined): string {
  if (!v) return "—";
  const bot = pickBotFromStrategyVersion(v);
  if (bot.strategyMode === "MANUAL" || v.primarySignalType === "MANUAL") {
    const m = String(bot.manualStrategy || "MANUAL").toUpperCase();
    return m || "MANUAL";
  }
  if (v.primarySignalType && v.primarySignalType !== "SUPERTREND") return v.primarySignalType;
  if (bot.strategyMode === "MANUAL") {
    const m = String(bot.manualStrategy || "MANUAL").toUpperCase();
    return m || "MANUAL";
  }
  return "SUPERTREND";
}

export function strategyVersionStLine(v: StrategyVersion | null | undefined): string {
  if (!v) return "—";
  const bot = pickBotFromStrategyVersion(v);
  const p = v.cfgStPeriod ?? (bot.supertrendPeriod as number | undefined);
  const m = v.cfgStMultiplier ?? (bot.supertrendMultiplier as number | undefined);
  if (p == null && m == null) return "—";
  return `${p ?? "—"} × ${m ?? "—"}`;
}

export function strategyVersionTrailingLabel(v: StrategyVersion | null | undefined): string {
  if (!v) return "—";
  const bot = pickBotFromStrategyVersion(v);
  const mode = v.cfgTrailingMode ?? bot.futuresTrailingStopMode;
  if (mode != null && String(mode).trim()) return String(mode);
  if (bot.trailingStopLossAuto === true) return "Auto";
  if (bot.trailingStopLossAuto === false) return "Off";
  return "—";
}

export function strategyVersionStrategyMode(v: StrategyVersion | null | undefined): string {
  const bot = pickBotFromStrategyVersion(v);
  const mode = bot.strategyMode;
  return mode != null && String(mode).trim() ? String(mode) : "—";
}

/** Short badges for cards (primary signal, MDE). */
export function strategyVersionBadgeLabels(v: StrategyVersion | null | undefined): string[] {
  if (!v) return [];
  const out = [strategyVersionPrimaryLabel(v)];
  if (strategyVersionMdeEnabled(v)) out.push("MDE on");
  return out;
}
