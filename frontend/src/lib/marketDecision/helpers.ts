import { computeRegimeSliceFromBar } from "./regime";
import type { MarketDecisionEngineConfig, RegimeSlice } from "./types";

/**
 * Vectorized regime history for the last `length` bars — O(n), one pass.
 * `ema` must be same length as `closes` (caller precomputes EMA series).
 */
export function buildRegimeHistoryLtf(
  closes: number[],
  adx: number[],
  atr: number[],
  ema: number[],
  cfg: Pick<
    MarketDecisionEngineConfig,
    "adxStrong" | "adxWeak" | "atrVolThreshold"
  >,
): RegimeSlice[] {
  const n = closes.length;
  const out: RegimeSlice[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const prevEma = i > 0 ? ema[i - 1]! : ema[i]!;
    out[i] = computeRegimeSliceFromBar({
      adx: adx[i] ?? 0,
      price: closes[i] ?? 0,
      ema: ema[i] ?? 0,
      prevEma,
      atr: atr[i] ?? 0,
      adxStrong: cfg.adxStrong,
      adxWeak: cfg.adxWeak,
      atrVolThreshold: cfg.atrVolThreshold,
    });
  }
  return out;
}
