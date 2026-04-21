import type { MarketDecisionEngineConfig } from "./types";

export function evaluateEntryTiming(args: {
  config: MarketDecisionEngineConfig;
  price: number;
  ema: number;
  atr: number;
}): {
  mode: "INSTANT" | "PULLBACK" | "BREAKOUT";
  recommendation: "ENTER" | "WAIT";
  metrics: Record<string, number>;
  reasons: string[];
} {
  const { config, price, ema, atr } = args;
  const p = Number(price);
  const e = Number(ema);
  const a = Number(atr);
  const mode = config.entryMode;

  const metrics: Record<string, number> = {
    price: p,
    ema: e,
    atr: a,
    distToEmaPct: Number.isFinite(p) && p > 0 ? Math.abs(p - e) / p : 0,
    atrPct: Number.isFinite(p) && p > 0 && Number.isFinite(a) ? a / p : 0,
  };

  if (mode === "INSTANT") {
    return {
      mode,
      recommendation: "ENTER",
      metrics,
      reasons: ["Entry mode: instant"],
    };
  }

  const atrPct = metrics.atrPct ?? 0;
  const dist = metrics.distToEmaPct ?? 0;
  const threshold = atrPct * Math.max(0.1, config.pullbackAtrMult);

  if (mode === "PULLBACK") {
    const needPullback = dist > threshold;
    return {
      mode,
      recommendation: needPullback ? "WAIT" : "ENTER",
      metrics: { ...metrics, threshold },
      reasons: needPullback
        ? [`Price ${(dist * 100).toFixed(3)}% from EMA > pullback band ${(threshold * 100).toFixed(3)}% — wait`]
        : ["Pullback satisfied vs EMA"],
    };
  }

  // BREAKOUT: wait until price stretched from EMA (simple inverse heuristic)
  const needBreak = dist < threshold * 0.5;
  return {
    mode,
    recommendation: needBreak ? "WAIT" : "ENTER",
    metrics: { ...metrics, threshold },
    reasons: needBreak ? ["Breakout mode: waiting for expansion"] : ["Breakout conditions met"],
  };
}
