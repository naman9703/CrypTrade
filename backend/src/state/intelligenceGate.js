import { clamp } from "../lib/math.js";
import { getIntelligenceScore } from "../intelligence/index.js";

/**
 * Optional Supertrend open filter: veto opens when composite strongly disagrees (same thresholds as legacy bot inline gate).
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

  let intel;
  try {
    intel = getIntelligenceScore(sym);
  } catch {
    return none;
  }
  if (!intel || !(intel.confidence > 60)) return none;

  const rawMult = Number(intel.sizeMultiplier);
  const sizeMultiplier = Number.isFinite(rawMult) ? clamp(rawMult, 0.25, 2) : 1;

  if (openingLong && intel.composite <= 35) {
    logInfo?.("intelligence_gate_skip_long", {
      composite: intel.composite,
      confidence: intel.confidence,
      symbol: sym,
    });
    broadcastLog?.({
      level: "warn",
      msg: `[Intelligence] High-confidence bearish signals (${intel.composite}/100) oppose LONG. Skipping.`,
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
      msg: `[Intelligence] High-confidence bullish signals (${intel.composite}/100) oppose SHORT. Skipping.`,
    });
    return { veto: true, sizeMultiplier: 1 };
  }

  return { veto: false, sizeMultiplier };
}
