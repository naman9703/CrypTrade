import type { MarketDecisionEngineConfig } from "./types";

function clampRoundTrip(r: number): number {
  const x = Number(r);
  if (!Number.isFinite(x) || x < 0) return 0.0004;
  return Math.min(0.01, Math.max(0, x));
}

/** Same idea as `feeRateBreakevenPadded` in supertrend trailing (T02 lock rate cap). */
export function feeRateBreakevenPadded(roundTripFeeRate: number, multiplier: number | undefined): number {
  const r = clampRoundTrip(roundTripFeeRate);
  const m =
    multiplier != null && Number.isFinite(Number(multiplier)) && Number(multiplier) >= 1
      ? Math.min(2, Number(multiplier))
      : 1;
  return Math.min(0.02, r * m);
}

/**
 * Favorable move from entry to **T02 activation** (tiered fee-BE Supertrend trail), as a fraction of price.
 * Long: activation = entry × (1 + feeBeSt + buf) → move frac = feeBeSt + buf.
 * Mirrors `t02ActivationPx` in `trailingStopLoss.js` when fee-BE trail is on.
 */
export function t02ActivationMoveFractionFromEntry(args: {
  roundTripFeeRate: number;
  feeBeMultiplier: number;
  activationSlippageFrac: number;
  trailBufferRate: number;
}): number {
  const rt = Math.max(0, Number(args.roundTripFeeRate) || 0);
  const mult = args.feeBeMultiplier != null && Number.isFinite(Number(args.feeBeMultiplier)) ? Number(args.feeBeMultiplier) : 1;
  const feeBe = feeRateBreakevenPadded(rt, mult);
  const slip = Math.max(0, Math.min(0.01, Number(args.activationSlippageFrac) || 0));
  const feeBeSt = Math.min(0.02, feeBe + slip);
  const buf = Math.max(0, Math.min(0.05, Number(args.trailBufferRate) || 0));
  return feeBeSt + buf;
}

/**
 * Required favorable move (%) for the fee gate.
 * - FEE_BUFFER_SLIP: round-trip fees (as %) + buffer + slippage bps (legacy).
 * - T02_ACTIVATION: % price move from entry to T02 activation (aligned with trailing gates).
 */
export function computeRequiredMovePct(config: MarketDecisionEngineConfig, roundTripFeeRate: number): number {
  const basis = config.feeGateRequiredMoveBasis ?? "FEE_BUFFER_SLIP";
  if (basis === "T02_ACTIVATION") {
    const frac = t02ActivationMoveFractionFromEntry({
      roundTripFeeRate,
      feeBeMultiplier: config.feeGateT02FeeBeMultiplier ?? 1,
      activationSlippageFrac: config.feeGateT02ActivationSlippageFrac ?? 0,
      trailBufferRate: config.feeGateT02TrailBufferRate ?? 0.0005,
    });
    return frac * 100;
  }
  const rt = Math.max(0, Number(roundTripFeeRate) || 0);
  const buf = Math.max(0, Number(config.feeBufferPct) || 0);
  const slip = Math.max(0, Number(config.feeSlippageBps) || 0) / 100;
  return rt * 100 + buf + slip;
}

export function evaluateFeeGate(args: {
  config: MarketDecisionEngineConfig;
  expectedMovePct: number;
  roundTripFeeRate: number;
}): {
  passed: boolean;
  requiredMovePct: number;
  reasons: string[];
  requiredMoveBasis: "FEE_BUFFER_SLIP" | "T02_ACTIVATION";
} {
  const { config, expectedMovePct, roundTripFeeRate } = args;
  const basis = config.feeGateRequiredMoveBasis ?? "FEE_BUFFER_SLIP";
  if (!config.feeGateEnabled) {
    return { passed: true, requiredMovePct: 0, reasons: ["Fee gate disabled"], requiredMoveBasis: basis };
  }
  const req = computeRequiredMovePct(config, roundTripFeeRate);
  const exp = Number(expectedMovePct);
  if (!Number.isFinite(exp)) {
    return { passed: false, requiredMovePct: req, reasons: ["Expected move unknown"], requiredMoveBasis: basis };
  }
  const passed = exp >= req;
  const basisNote =
    basis === "T02_ACTIVATION"
      ? " (required = T02 activation distance: padded fee + activation slip + trail buffer)"
      : "";
  const reasons: string[] = [
    passed
      ? `Expected move ${exp.toFixed(3)}% ≥ required ${req.toFixed(3)}%${basisNote}`
      : `Expected move ${exp.toFixed(3)}% < required ${req.toFixed(3)}%${basisNote}`,
  ];
  return { passed, requiredMovePct: req, reasons, requiredMoveBasis: basis };
}
