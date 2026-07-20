/** Fixed %-SL from Supertrend panel ("Off" unchecked). */
export function fixedBracketSlEnabled(cfg = {}) {
  return cfg.supertrendFuturesUseFixedSl !== false;
}

/** Fixed %-TP from Supertrend panel ("Off" unchecked). */
export function fixedBracketTpEnabled(cfg = {}) {
  return cfg.supertrendFuturesUseFixedTp !== false;
}

/** Signal carries technique structure brackets (liq/fib/vp/of) — not panel fixed %. */
export function techniqueStructureBracketsActive(barSignal = null, cfg = {}) {
  if (!barSignal || typeof barSignal !== "object") return false;
  if (Number(barSignal?.liqBrackets?.slPct) > 0) return true;
  if (Number(barSignal?.fibBrackets?.slPct) > 0) return true;
  if (Number(barSignal?.ofBrackets?.slPct) > 0) return true;
  if (Number(barSignal?.vpBrackets?.slPct) > 0 && cfg?.intradayVpBrackets === true) return true;
  return false;
}

/** SL legs: panel fixed SL and/or structure swing/liquidity stop. */
export function bracketSlLegsEnabled(cfg = {}, barSignal = null) {
  return fixedBracketSlEnabled(cfg) || techniqueStructureBracketsActive(barSignal, cfg);
}

/**
 * TP legs: panel fixed TP and/or structure targets.
 *
 * LIQ/FIB/OF structure TP stays armed even when panel TP is Off (live ladder path).
 * VP structure TP follows panel TP (live `bot.js` gates `vpBrackets.tpPct` on
 * `supertrendFuturesUseFixedTp`) so trail-only VP runs are not clipped by VA targets.
 */
export function bracketTpLegsEnabled(cfg = {}, barSignal = null) {
  if (fixedBracketTpEnabled(cfg)) return true;
  if (!barSignal || typeof barSignal !== "object") return false;
  if (Number(barSignal?.liqBrackets?.slPct) > 0) return true;
  if (Number(barSignal?.fibBrackets?.slPct) > 0) return true;
  if (Number(barSignal?.ofBrackets?.slPct) > 0) return true;
  // VP-only structure: require panel TP On (trail-only when Off).
  return false;
}
