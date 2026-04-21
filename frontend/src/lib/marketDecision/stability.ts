import type { RegimeSlice, RegimeType } from "./types";

function trendFamily(t: RegimeType): "UP" | "DOWN" | "NEUTRAL" {
  if (t === "UPTREND") return "UP";
  if (t === "DOWNTREND") return "DOWN";
  return "NEUTRAL";
}

export function computeRegimeStability(
  history: RegimeSlice[],
  lookback: number,
  minAgree: number,
): { stable: boolean; label: string; agree: number; lookback: number } {
  const n = history.length;
  const lb = Math.max(1, Math.min(lookback, n));
  const slice = history.slice(-lb);
  if (slice.length === 0) {
    return { stable: false, label: "—", agree: 0, lookback: lb };
  }
  const fam0 = trendFamily(slice[0]!.type);
  let agree = 0;
  for (const s of slice) {
    if (trendFamily(s.type) === fam0) agree += 1;
  }
  const stable = agree >= minAgree && fam0 !== "NEUTRAL";
  const label =
    fam0 === "UP"
      ? `UPTREND (${agree}/${lb})`
      : fam0 === "DOWN"
        ? `DOWNTREND (${agree}/${lb})`
        : `MIXED (${agree}/${lb})`;
  return { stable, label, agree, lookback: lb };
}

/**
 * Block when recent window mixes SIDEWAYS/UNCLEAR with fresh UPTREND/DOWNTREND (breakout chop zone).
 */
export function detectRegimeTransition(
  history: RegimeSlice[],
  lookback: number,
): { detected: boolean; detail?: string } {
  const lb = Math.max(2, Math.min(lookback, history.length));
  const slice = history.slice(-lb);
  const types = new Set(slice.map((s) => s.type));
  const hasChop = types.has("SIDEWAYS") || types.has("UNCLEAR");
  const hasUp = types.has("UPTREND");
  const hasDown = types.has("DOWNTREND");
  if (hasChop && (hasUp || hasDown)) {
    return { detected: true, detail: "Sideways/unclear mixed with trend in lookback" };
  }
  return { detected: false };
}
