import type { BotInstance, InstanceOperationalConfig } from "../types/instance";
import type { Strategy, StrategyVersion } from "../types/strategy";

/** Instance-bound strategy version (not latest) when backtesting from a deployment. */
export function resolveBacktestStrategyVersion(
  configSource: "instance" | "strategy",
  instance: BotInstance | null,
  strategy: Strategy | null,
  versionsByStrategyId: Record<string, StrategyVersion[]>,
): StrategyVersion | null {
  if (configSource === "instance" && instance?.strategyVersionId && instance.strategyId) {
    const list = versionsByStrategyId[instance.strategyId] ?? [];
    const bound = list.find((v) => v.id === instance.strategyVersionId);
    if (bound) return bound;
  }
  return strategy?.latestVersion ?? null;
}

/** Instance-owned fields for `POST /backtest/runs` — never strategy SL/TP or gates. */
export function instanceOperationalFromSaved(
  op: InstanceOperationalConfig,
  symbol: string,
  timeframe: string,
) {
  return {
    symbol: symbol.toUpperCase(),
    timeframe,
    symbolMode: op.symbolMode ?? null,
    marketMode: op.marketMode ?? null,
    universe: op.universe ?? null,
    riskPerTrade: op.riskPerTrade ?? null,
    riskUnit: normalizeRiskUnit(op.riskUnit ?? ""),
    maxDailyLoss: op.maxDailyLoss ?? null,
    maxDailyLossUnit: normalizeRiskUnit(op.maxDailyLossUnit ?? ""),
    compoundPnl: op.compoundPnl ?? null,
  };
}

function normalizeRiskUnit(raw: string): "USDT" | "PCT" | null {
  const u = raw.toUpperCase();
  if (u === "USDT") return "USDT";
  if (u === "PCT" || u === "PCT_EQUITY" || u.startsWith("PCT_")) return "PCT";
  return null;
}

/** Merge saved strategy cfg with instance operational fields for UI preview (no live bot). */
export function mergeCfgForBacktestPreview(
  cfgRaw: unknown,
  instance: BotInstance | null,
  symbol: string,
  timeframe: string,
): Record<string, unknown> | null {
  if (!cfgRaw || typeof cfgRaw !== "object") return null;
  const root = JSON.parse(JSON.stringify(cfgRaw)) as Record<string, unknown>;
  const bot = root.bot;
  const b = bot && typeof bot === "object" ? (bot as Record<string, unknown>) : root;
  if (instance?.operational) {
    const op = instance.operational;
    if (op.marketMode != null) b.marketMode = op.marketMode;
    if (op.riskPerTrade != null) b.riskPerTrade = op.riskPerTrade;
    if (op.riskUnit != null) b.riskPerTradeUnit = op.riskUnit;
    if (op.maxDailyLoss != null) b.maxDailyLoss = op.maxDailyLoss;
    if (op.maxDailyLossUnit != null) b.maxDailyLossUnit = op.maxDailyLossUnit;
  }
  if (symbol) b.symbol = symbol.toUpperCase();
  if (timeframe) b.timeframe = timeframe;
  return root;
}
