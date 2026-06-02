/** Fixed / structure SL bracket enabled (UI "Off" unchecked). */
export function fixedBracketSlEnabled(cfg = {}) {
  return cfg.supertrendFuturesUseFixedSl !== false;
}

/** Fixed / structure TP bracket enabled (UI "Off" unchecked). */
export function fixedBracketTpEnabled(cfg = {}) {
  return cfg.supertrendFuturesUseFixedTp !== false;
}
