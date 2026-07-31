/**
 * Resolve simulation engine key from saved bot cfg.
 * Must match live bar-close: MANUAL panel strategies win over supertrend autotrade toggles.
 */
import { PANEL_MANUAL_STRATEGY_KEYS } from "../../strategy/liveStrategyBarClose.js";

function pickBot(cfg) {
  if (!cfg || typeof cfg !== "object") return {};
  if (cfg.bot && typeof cfg.bot === "object") return cfg.bot;
  return cfg;
}

/**
 * @param {Record<string, unknown>} cfgOrSnapshot — bot fields or `{ bot: {...} }` snapshot
 * @param {string} [engineType] — legacy run.engine_type fallback
 */
export function pickStrategyKeyFromCfg(cfgOrSnapshot, engineType) {
  const b = pickBot(cfgOrSnapshot);
  const mmUp = String(b.marketMode || b.market || "").toUpperCase();
  const stratMode = String(b.strategyMode ?? "").toUpperCase();
  const manual = String(b.manualStrategy ?? "").trim().toUpperCase();

  if (
    stratMode === "MANUAL" &&
    manual &&
    manual !== "MANUAL" &&
    manual !== "AUTO" &&
    manual !== "SUPERTREND" &&
    PANEL_MANUAL_STRATEGY_KEYS.has(manual)
  ) {
    return manual;
  }

  const stSpot = Boolean(b.supertrendSpotAuto);
  const stFut = Boolean(b.supertrendFuturesAuto);
  const supertrendAutoOn =
    (mmUp === "SPOT" && stSpot) ||
    (mmUp === "FUTURES" && stFut) ||
    (mmUp === "AUTO" && (stSpot || stFut));
  if (supertrendAutoOn) return "SUPERTREND";

  if (stratMode === "MANUAL") {
    if (manual && manual !== "MANUAL" && manual !== "AUTO") return manual;
    return "SUPERTREND";
  }
  if (stratMode === "AUTO") return "AUTO";

  const et = String(engineType ?? "").toUpperCase();
  if (et && et !== "AUTO" && et !== "MANUAL") return et;
  return "SUPERTREND";
}

/** @deprecated use pickStrategyKeyFromCfg */
export const pickEngineTypeFromCfg = pickStrategyKeyFromCfg;
