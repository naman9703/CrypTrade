import { clamp } from "../lib/math.js";
import { getIntelligenceScore, isIntelligenceReady } from "../intelligence/index.js";

const gateWarmupLoggedSymbols = new Set();

/**
 * Optional Supertrend open filter: veto opens when composite disagrees (LONG vs bearish, SHORT vs bullish).
 *
 * **Veto** uses composite thresholds only (`<= 35` / `>= 65`) so they match the UI bias bands.
 * **`confidence`** from the scorer is `round(|composite-50|×2)`; requiring `confidence > 60` for veto made
 * LONG vetoes almost impossible for composites 20–35 (confidence tops out at 60 there). Size scaling
 * still requires high confidence so multipliers apply only when the score is far from neutral.
 *
 * @param {{
 *   gateEnabled: boolean,
 *   symbol: string,
 *   openingLong: boolean,
 *   broadcastLog?: (p: { level: string, msg: string }) => void,
 *   logInfo?: (event: string, meta?: Record<string, unknown>) => void,
 * }} opts
 * @returns {{ veto: boolean, sizeMultiplier: number }}
 */
export function evaluateIntelligenceGateForSupertrendOpen(opts) {
  const { gateEnabled, symbol, openingLong, broadcastLog, logInfo } = opts;
  const none = { veto: false, sizeMultiplier: 1 };
  if (!gateEnabled) return none;

  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) return none;

  if (!isIntelligenceReady(sym)) {
    if (!gateWarmupLoggedSymbols.has(sym)) {
      gateWarmupLoggedSymbols.add(sym);
      broadcastLog?.({
        level: "info",
        msg: `[Intelligence] Gate warming up for ${sym} — pass-through until first composite.`,
      });
      logInfo?.("intelligence_gate_warming_up", { symbol: sym });
    }
    return none;
  }

  let intel;
  try {
    intel = getIntelligenceScore(sym);
  } catch {
    return none;
  }
  if (!intel) return none;

  const conf = Number(intel.confidence);
  const rawMult = Number(intel.sizeMultiplier);
  const sizeMultiplier =
    Number.isFinite(conf) && conf > 60 && Number.isFinite(rawMult) ? clamp(rawMult, 0.25, 2) : 1;

  if (openingLong && intel.composite <= 35) {
    logInfo?.("intelligence_gate_skip_long", {
      composite: intel.composite,
      confidence: intel.confidence,
      symbol: sym,
    });
    broadcastLog?.({
      level: "warn",
      msg: `[Intelligence] Bearish composite (${intel.composite}/100) opposes LONG. Skipping.`,
    });
    return { veto: true, sizeMultiplier: 1 };
  }
  if (!openingLong && intel.composite >= 65) {
    logInfo?.("intelligence_gate_skip_short", {
      composite: intel.composite,
      confidence: intel.confidence,
      symbol: sym,
    });
    broadcastLog?.({
      level: "warn",
      msg: `[Intelligence] Bullish composite (${intel.composite}/100) opposes SHORT. Skipping.`,
    });
    return { veto: true, sizeMultiplier: 1 };
  }

  return { veto: false, sizeMultiplier };
}
