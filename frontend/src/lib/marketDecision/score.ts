import type { MarketDecisionEngineConfig, MarketDecisionInput, ScoreBreakdownRow } from "./types";
import type { RegimeSlice } from "./types";

/** Long-biased if RSI ≥ 50; short-biased if RSI ≤ 50; no signal keeps legacy long bias. */
function rsiBiasPasses(signalSide: "BUY" | "SELL" | null, rsi: number): boolean {
  const r = Number(rsi);
  if (!Number.isFinite(r)) return false;
  if (signalSide === "SELL") return r <= 50;
  if (signalSide === "BUY") return r >= 50;
  return r >= 50;
}

export function computeSignalQualityScore(
  config: MarketDecisionEngineConfig,
  input: MarketDecisionInput,
  ltf: RegimeSlice,
  htf: RegimeSlice | null,
  confidencePenalty: number,
  softChopPenalty: number,
  directionMismatchPenalty: number,
  btcPenalty = 0,
): { total: number; max: number; threshold: number; passed: boolean; breakdown: ScoreBreakdownRow[] } {
  const breakdown: ScoreBreakdownRow[] = [];
  let total = 0;
  const { scoring } = input;

  const add = (id: string, label: string, cond: boolean, w: number, note?: string) => {
    const contribution = cond ? w : 0;
    total += contribution;
    breakdown.push({
      id,
      label,
      value: cond ? 1 : 0,
      weight: w,
      contribution,
      note,
    });
  };

  add("st", "Supertrend confirmed", scoring.supertrendConfirmed, config.weightSupertrend);
  add("ema", "EMA alignment", scoring.priceAboveEma, config.weightEmaAlign);
  add("rsi", "RSI bias", rsiBiasPasses(input.signalSide, scoring.rsi), config.weightRsi);
  const htfOk =
    htf != null &&
    ((ltf.type === "UPTREND" && htf.type === "UPTREND") ||
      (ltf.type === "DOWNTREND" && htf.type === "DOWNTREND"));
  add("htf", "HTF trend match", scoring.htfTrendMatch || htfOk, config.weightHtfMatch);

  if (confidencePenalty > 0) {
    total -= confidencePenalty;
    breakdown.push({
      id: "conf",
      label: "Low regime confidence",
      value: 1,
      weight: -confidencePenalty,
      contribution: -confidencePenalty,
    });
  }
  if (scoring.isWeakTrend) {
    total -= config.penaltyWeakTrend;
    breakdown.push({
      id: "weak",
      label: "Weak trend",
      value: 1,
      weight: -config.penaltyWeakTrend,
      contribution: -config.penaltyWeakTrend,
    });
  }
  if (scoring.overextended) {
    total -= config.penaltyOverextension;
    breakdown.push({
      id: "over",
      label: "Overextension",
      value: 1,
      weight: -config.penaltyOverextension,
      contribution: -config.penaltyOverextension,
    });
  }
  if (softChopPenalty > 0) {
    total -= softChopPenalty;
    breakdown.push({
      id: "chop_soft",
      label: "Chop (soft penalty)",
      value: 1,
      weight: -softChopPenalty,
      contribution: -softChopPenalty,
    });
  }
  if (directionMismatchPenalty > 0) {
    total -= directionMismatchPenalty;
    breakdown.push({
      id: "dir",
      label: "Direction vs regime",
      value: 1,
      weight: -directionMismatchPenalty,
      contribution: -directionMismatchPenalty,
    });
  }
  if (btcPenalty > 0) {
    total -= btcPenalty;
    breakdown.push({
      id: "btc",
      label: "BTC filter (penalty mode)",
      value: 1,
      weight: -btcPenalty,
      contribution: -btcPenalty,
    });
  }

  const max =
    config.weightSupertrend +
    config.weightEmaAlign +
    config.weightRsi +
    config.weightHtfMatch;

  const passed = total >= config.scoreThreshold;
  return { total, max, threshold: config.scoreThreshold, passed, breakdown };
}
