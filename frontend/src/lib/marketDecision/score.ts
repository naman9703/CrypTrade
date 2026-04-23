import type { MarketDecisionEngineConfig, MarketDecisionInput, ScoreBreakdownRow } from "./types";
import type { RegimeSlice } from "./types";

/** BUY / legacy long bias: RSI ≥ longMin; SELL: RSI ≤ shortMax (defaults stricter than 50/50). */
export function rsiBiasPassesForConfig(
  signalSide: "BUY" | "SELL" | null,
  rsi: number,
  longMin: number,
  shortMax: number,
): boolean {
  const r = Number(rsi);
  if (!Number.isFinite(r)) return false;
  const lo = Number(longMin);
  const hi = Number(shortMax);
  const l = Number.isFinite(lo) ? lo : 52;
  const s = Number.isFinite(hi) ? hi : 48;
  if (signalSide === "SELL") return r <= s;
  if (signalSide === "BUY") return r >= l;
  return r >= l;
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
): {
  total: number;
  max: number;
  threshold: number;
  passed: boolean;
  breakdown: ScoreBreakdownRow[];
  failKind?: "htf_match" | "below_threshold";
} {
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

  const rsiLongMin = Number(config.scoreRsiLongMin);
  const rsiShortMax = Number(config.scoreRsiShortMax);
  const longM = Number.isFinite(rsiLongMin) ? rsiLongMin : 52;
  const shortM = Number.isFinite(rsiShortMax) ? rsiShortMax : 48;

  add("st", "Supertrend confirmed", scoring.supertrendConfirmed, config.weightSupertrend);
  add("ema", "EMA alignment", scoring.priceAboveEma, config.weightEmaAlign);
  add(
    "rsi",
    "RSI bias",
    rsiBiasPassesForConfig(input.signalSide, scoring.rsi, longM, shortM),
    config.weightRsi,
  );
  const htfOk =
    htf != null &&
    ((ltf.type === "UPTREND" && htf.type === "UPTREND") ||
      (ltf.type === "DOWNTREND" && htf.type === "DOWNTREND"));
  const htfW = config.htfEnabled === true ? Number(config.weightHtfMatch) : 0;
  if (config.htfEnabled === true && htfW > 0) {
    add("htf", "HTF trend match", Boolean(scoring.htfTrendMatch) || htfOk, htfW);
  }

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
    (config.htfEnabled === true ? Number(config.weightHtfMatch) : 0);

  const htfRequired = config.htfEnabled === true && Number(config.weightHtfMatch) > 0;
  const htfMatched = !htfRequired || Boolean(scoring.htfTrendMatch) || htfOk;

  const passed = htfMatched && total >= config.scoreThreshold;
  let failKind: "htf_match" | "below_threshold" | undefined;
  if (!passed) {
    if (htfRequired && !htfMatched) failKind = "htf_match";
    else failKind = "below_threshold";
  }
  return { total, max, threshold: config.scoreThreshold, passed, breakdown, failKind };
}
