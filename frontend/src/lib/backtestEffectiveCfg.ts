/** Flat bot cfg for backtest result summary — merges config_snapshot + instance_operational_snapshot. */

const INST_TO_BOT: Record<string, string> = {
  inst_risk_per_trade: "riskPerTrade",
  inst_risk_unit: "riskPerTradeUnit",
  inst_max_daily_loss: "maxDailyLoss",
  inst_max_daily_loss_unit: "maxDailyLossUnit",
  inst_market_mode: "marketMode",
  inst_timeframe: "timeframe",
  inst_symbol: "symbol",
};

export function pickBotFromConfigSnapshot(snap: unknown): Record<string, unknown> {
  if (!snap || typeof snap !== "object") return {};
  const root = snap as Record<string, unknown>;
  if (root.bot && typeof root.bot === "object" && !Array.isArray(root.bot)) {
    return { ...(root.bot as Record<string, unknown>) };
  }
  return { ...root };
}

export function effectiveBacktestBotCfg(
  configSnapshot: unknown,
  instanceOperationalSnapshot: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const bot = pickBotFromConfigSnapshot(configSnapshot);
  const inst = instanceOperationalSnapshot;
  if (!inst || typeof inst !== "object") return bot;
  for (const [instKey, botKey] of Object.entries(INST_TO_BOT)) {
    if (bot[botKey] != null) continue;
    const v = inst[instKey];
    if (v != null) bot[botKey] = v;
  }
  return bot;
}
