import { BACKTEST_SNAPSHOT_META_KEYS } from "../../lib/strategySignalBrain.js";

/** Per-run backtest options stored on `config_snapshot.bot` (not strategy version cfg). */
export function pickBacktestRunMeta(bot) {
  const out = {};
  if (!bot || typeof bot !== "object") return out;
  for (const key of BACKTEST_SNAPSHOT_META_KEYS) {
    if (Object.prototype.hasOwnProperty.call(bot, key)) out[key] = bot[key];
  }
  return out;
}

export function applyBacktestRunMeta(target, meta) {
  if (!target || typeof target !== "object" || !meta || typeof meta !== "object") return target;
  Object.assign(target, meta);
  return target;
}
