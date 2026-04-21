import type { MarketDecisionEngineConfig } from "./types";

/**
 * Required favorable move (%) to cover round-trip fees + buffer + slippage (price %, not margin).
 */
export function computeRequiredMovePct(config: MarketDecisionEngineConfig, roundTripFeeRate: number): number {
  const rt = Math.max(0, Number(roundTripFeeRate) || 0);
  const buf = Math.max(0, Number(config.feeBufferPct) || 0);
  const slip = Math.max(0, Number(config.feeSlippageBps) || 0) / 100;
  return rt * 100 + buf + slip;
}

export function evaluateFeeGate(args: {
  config: MarketDecisionEngineConfig;
  expectedMovePct: number;
  roundTripFeeRate: number;
}): { passed: boolean; requiredMovePct: number; reasons: string[] } {
  const { config, expectedMovePct, roundTripFeeRate } = args;
  if (!config.feeGateEnabled) {
    return { passed: true, requiredMovePct: 0, reasons: ["Fee gate disabled"] };
  }
  const req = computeRequiredMovePct(config, roundTripFeeRate);
  const exp = Number(expectedMovePct);
  if (!Number.isFinite(exp)) {
    return { passed: false, requiredMovePct: req, reasons: ["Expected move unknown"] };
  }
  const passed = exp >= req;
  const reasons: string[] = [
    passed
      ? `Expected move ${exp.toFixed(3)}% ≥ required ${req.toFixed(3)}%`
      : `Expected move ${exp.toFixed(3)}% < required ${req.toFixed(3)}%`,
  ];
  return { passed, requiredMovePct: req, reasons };
}
