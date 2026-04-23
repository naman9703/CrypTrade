import { evaluateChop } from "./chop";
import { deepFreezeSnapshot } from "./freeze";
import { evaluateEntryTiming } from "./entryTiming";
import { evaluateFeeGate } from "./feeGate";
import type {
  DecisionVerdict,
  MarketDecisionPassThresholds,
  MarketDecisionEngineConfig,
  MarketDecisionInput,
  MarketDecisionSnapshot,
  PipelineStageId,
  RegimeSlice,
} from "./types";
import { MARKET_DECISION_SCHEMA_VERSION } from "./types";
import { computeRegimeStability, detectRegimeTransition } from "./stability";
import { computeSignalQualityScore } from "./score";
import { buildMarketDecisionStageChecks } from "./stageChecks";

function directionMismatch(
  signalSide: "BUY" | "SELL" | null,
  ltf: RegimeSlice,
  allowSideways: boolean,
): boolean {
  if (!signalSide) return false;
  if (signalSide === "BUY") {
    if (ltf.type === "UPTREND") return false;
    if (allowSideways && (ltf.type === "SIDEWAYS" || ltf.type === "UNCLEAR")) return false;
    return true;
  }
  if (signalSide === "SELL") {
    if (ltf.type === "DOWNTREND") return false;
    if (allowSideways && (ltf.type === "SIDEWAYS" || ltf.type === "UNCLEAR")) return false;
    return true;
  }
  return false;
}

function btcBlocks(config: MarketDecisionEngineConfig, btc: RegimeSlice | null): boolean {
  if (!config.btcFilterEnabled || btc == null) return false;
  if (btc.raw.adx < config.btcMinAdx) return true;
  if (btc.type === "SIDEWAYS" || btc.type === "UNCLEAR") return true;
  return false;
}

/** Severity of the primary failure (for UX / tuning). */
function severityForPrimaryStage(stage: PipelineStageId | null): "high" | "medium" | "low" {
  if (stage === "chop" || stage === "regime_confidence" || stage === "transition" || stage === "direction_alignment") {
    return "high";
  }
  if (stage === "fee_gate" || stage === "signal_score" || stage === "btc_filter") return "medium";
  if (stage === "entry_timing") return "low";
  return "medium";
}

function buildPassThresholds(
  config: MarketDecisionEngineConfig,
  entry: MarketDecisionSnapshot["entryTiming"],
  feeRequiredPct: number | null,
): MarketDecisionPassThresholds {
  const th = entry.metrics?.threshold;
  const t = typeof th === "number" && Number.isFinite(th) ? th : null;
  let entryTimingPassHint: string | null = null;
  if (config.entryMode === "INSTANT") {
    entryTimingPassHint = "ENTER — instant mode";
  } else if (config.entryMode === "PULLBACK" && t != null) {
    entryTimingPassHint = `ENTER if |price−EMA|/price ≤ ${(t * 100).toFixed(3)}%`;
  } else if (config.entryMode === "BREAKOUT" && t != null) {
    entryTimingPassHint = `ENTER if |price−EMA|/price ≥ ${(t * 0.5 * 100).toFixed(3)}%`;
  }

  const directionPassHint = config.regimeFilterEnabled
    ? `BUY needs UPTREND (or sideways/unclear if allowed); SELL needs DOWNTREND — allowSideways=${config.allowSidewaysWithSignal}`
    : null;

  return {
    minRegimeConfidence: config.minRegimeConfidence,
    chopRangeMin: config.chopEnabled && config.chopRangeEnabled ? config.chopRangeThreshold : null,
    chopAdxMin: config.chopEnabled && config.chopAdxEnabled ? config.adxWeak : null,
    chopFlipsMax: config.chopEnabled && config.chopFlipEnabled ? config.chopMaxFlips : null,
    signalScoreMin: config.signalQualityEnabled ? config.scoreThreshold : null,
    entryDistBand: t,
    entryTimingPassHint,
    feeMinExpectedMovePct: config.feeGateEnabled ? feeRequiredPct : null,
    atrVolThreshold: config.atrVolThreshold,
    directionPassHint,
    scoreRsiLongMin: config.signalQualityEnabled ? config.scoreRsiLongMin : null,
    scoreRsiShortMax: config.signalQualityEnabled ? config.scoreRsiShortMax : null,
  };
}

/**
 * Full decision pipeline — deterministic, strict stage order.
 * Caller supplies pre-built `regimeHistoryLtf` and metrics (no hidden global state).
 */
export function evaluateMarketDecision(input: MarketDecisionInput): MarketDecisionSnapshot {
  const { config } = input;
  const reasons: string[] = [];
  let verdict: DecisionVerdict = "ALLOW";
  let failedStage: PipelineStageId | null = null;

  const hist = input.regimeHistoryLtf;
  const ltf = hist[hist.length - 1]!;
  const stability = computeRegimeStability(hist, config.stabilityLookback, config.stabilityMinAgree);
  const transition = detectRegimeTransition(hist, config.transitionLookback);
  const chop = evaluateChop({
    config,
    history: hist,
    adx: input.chop.adx,
    rangeCompression: input.chop.rangeCompression,
  });

  const metrics: Record<string, unknown> = {
    ltfType: ltf.type,
    ltfConfidence: ltf.confidence,
    stabilityLabel: stability.label,
  };

  const useRegime = config.regimeFilterEnabled;

  if (!config.enabled) {
    const hypot = evaluateMarketDecision({
      ...input,
      config: { ...config, enabled: true },
    });
    const engineRow = {
      id: "engine_master",
      label: "Engine master switch",
      verdict: "N_A" as const,
      detail: "Disabled — rows below are hypothetical if the filter were enabled; not enforced on opens.",
    };
    const merged: MarketDecisionSnapshot = {
      ...hypot,
      version: MARKET_DECISION_SCHEMA_VERSION,
      engineDisabled: true,
      stageChecks: [engineRow, ...(Array.isArray(hypot.stageChecks) ? hypot.stageChecks : [])],
      reasons: [
        "Market decision engine disabled — verdict is what would apply if enabled; trading is not filtered.",
        ...hypot.reasons,
      ],
      entryTiming: {
        ...hypot.entryTiming,
        reasons: [
          ...hypot.entryTiming.reasons,
          "Not enforced — engine master switch is off",
        ],
      },
      feeGate: {
        ...hypot.feeGate,
        reasons: [...hypot.feeGate.reasons, "Not enforced — engine master switch is off"],
      },
    };
    return deepFreezeSnapshot(merged) as MarketDecisionSnapshot;
  }

  const confidencePassed = ltf.confidence >= config.minRegimeConfidence;
  let confidencePenalty = 0;
  if (useRegime && !confidencePassed && config.confidenceMode === "PENALTY") {
    confidencePenalty = config.confidencePenalty;
    reasons.push(
      `Regime confidence ${ltf.confidence.toFixed(0)} < ${config.minRegimeConfidence} (penalty −${confidencePenalty})`,
    );
  } else if (useRegime && !confidencePassed && config.confidenceMode === "BLOCK") {
    verdict = "BLOCK";
    failedStage = "regime_confidence";
    reasons.push(`Regime confidence ${ltf.confidence.toFixed(0)} < ${config.minRegimeConfidence}`);
  }

  if (verdict === "ALLOW" && useRegime && config.transitionBlockEnabled && transition.detected) {
    verdict = "BLOCK";
    failedStage = "transition";
    reasons.push(transition.detail ?? "Regime transition detected");
  }

  let softChopPenalty = 0;
  if (verdict === "ALLOW" && useRegime && chop.isChoppy && config.chopEnabled) {
    if (config.chopHardBlock) {
      verdict = "BLOCK";
      failedStage = "chop";
      for (const r of chop.reasons) reasons.push(`Chop: ${r}`);
    } else {
      softChopPenalty = config.penaltyChop;
      reasons.push(`Chop soft penalty −${softChopPenalty}`);
    }
  }

  let btcPenalty = 0;
  if (verdict === "ALLOW" && config.btcFilterEnabled && btcBlocks(config, input.regimeBtc)) {
    if (config.btcBlockMode === "BLOCK") {
      verdict = "BLOCK";
      failedStage = "btc_filter";
      reasons.push("BTC filter: weak or sideways regime");
    } else if (config.btcBlockMode === "PENALTY") {
      btcPenalty = config.btcFilterPenalty;
      reasons.push(`BTC filter: weak/sideways regime — score penalty −${btcPenalty}`);
    }
  }

  let alignment: "OK" | "MISMATCH" | "N_A" = "N_A";
  let directionMismatchPenalty = 0;
  let directionMismatchFlag = false;
  if (input.signalSide) {
    const mis = directionMismatch(input.signalSide, ltf, config.allowSidewaysWithSignal);
    directionMismatchFlag = mis;
    alignment = mis ? "MISMATCH" : "OK";
    if (verdict === "ALLOW" && mis && useRegime) {
      if (config.directionMismatchMode === "BLOCK") {
        verdict = "BLOCK";
        failedStage = "direction_alignment";
        reasons.push(`Direction mismatch: ${input.signalSide} vs regime ${ltf.type}`);
      } else {
        directionMismatchPenalty = config.directionMismatchPenalty;
        reasons.push(`Direction mismatch penalty −${directionMismatchPenalty}`);
      }
    }
  }

  const alignmentBlocked =
    alignment === "MISMATCH" && config.directionMismatchMode === "BLOCK" && failedStage === "direction_alignment";

  let scoreOut: MarketDecisionSnapshot["score"] = undefined;
  if (verdict === "ALLOW" && config.signalQualityEnabled) {
    const sc = computeSignalQualityScore(
      config,
      input,
      ltf,
      input.regimeHtf,
      confidencePenalty,
      softChopPenalty,
      directionMismatchPenalty,
      btcPenalty,
    );
    scoreOut = sc;
    if (!sc.passed) {
      verdict = "BLOCK";
      failedStage = "signal_score";
      reasons.push(
        sc.failKind === "htf_match"
          ? `Score ${sc.total.toFixed(1)} vs threshold ${sc.threshold} — HTF layer on but higher timeframe does not align`
          : `Score ${sc.total.toFixed(1)} < threshold ${sc.threshold}`,
      );
    }
  }

  const entry = evaluateEntryTiming({
    config,
    price: input.entryTiming.price,
    ema: input.entryTiming.ema,
    atr: input.entryTiming.atr,
  });

  if (verdict === "ALLOW" && entry.recommendation === "WAIT") {
    verdict = "WAIT";
    failedStage = "entry_timing";
    reasons.push(...entry.reasons);
  }

  const feeRt = Number.isFinite(input.feeGate.roundTripFeeRate)
    ? input.feeGate.roundTripFeeRate
    : config.defaultRoundTripFeeRate;
  const feeEval = evaluateFeeGate({
    config,
    expectedMovePct: input.feeGate.expectedMovePct,
    roundTripFeeRate: feeRt,
  });

  if (verdict === "ALLOW" && !feeEval.passed) {
    verdict = "BLOCK";
    failedStage = "fee_gate";
    reasons.push(...feeEval.reasons);
  }

  const secondary: Array<{ stage: string; severity: "high" | "medium" | "low"; detail: string }> = [];
  const addSecondary = (stage: PipelineStageId, sev: "high" | "medium" | "low", msg: string) => {
    if (failedStage === stage) return;
    secondary.push({ stage, severity: sev, detail: msg });
    reasons.push(`Also · ${stage}: ${msg}`);
  };

  if (config.feeGateEnabled && !feeEval.passed && failedStage !== "fee_gate") {
    addSecondary("fee_gate", "medium", feeEval.reasons.join(" · "));
  }
  if (entry.recommendation === "WAIT" && failedStage !== "entry_timing") {
    addSecondary("entry_timing", "low", entry.reasons.join("; "));
  }
  if (useRegime && config.transitionBlockEnabled && transition.detected && failedStage !== "transition") {
    addSecondary("transition", "high", transition.detail ?? "Regime transition detected");
  }
  if (
    input.signalSide &&
    directionMismatchFlag &&
    useRegime &&
    config.directionMismatchMode === "BLOCK" &&
    failedStage !== "direction_alignment"
  ) {
    addSecondary(
      "direction_alignment",
      "high",
      `${input.signalSide} vs regime ${ltf.type} would block`,
    );
  }
  if (config.btcFilterEnabled && btcBlocks(config, input.regimeBtc) && config.btcBlockMode === "BLOCK" && failedStage !== "btc_filter") {
    addSecondary("btc_filter", "medium", "BTC filter: weak or sideways regime");
  }

  if (
    config.signalQualityEnabled &&
    failedStage !== "signal_score" &&
    verdict !== "ALLOW" &&
    verdict !== "BYPASS"
  ) {
    const sc =
      scoreOut ??
      computeSignalQualityScore(
        config,
        input,
        ltf,
        input.regimeHtf,
        confidencePenalty,
        softChopPenalty,
        directionMismatchPenalty,
        btcPenalty,
      );
    if (!sc.passed) {
      addSecondary(
        "signal_score",
        "medium",
        sc.failKind === "htf_match"
          ? `${sc.total.toFixed(1)} vs ${sc.threshold}: HTF alignment required (would block)`
          : `${sc.total.toFixed(1)} < ${sc.threshold} (would block)`,
      );
    } else {
      addSecondary("signal_score", "medium", `${sc.total.toFixed(1)} ≥ ${sc.threshold} (would pass)`);
    }
  }

  const pipelineDiagnostics: MarketDecisionSnapshot["pipelineDiagnostics"] =
    (verdict === "BLOCK" || verdict === "WAIT") && failedStage != null
      ? {
          primaryStage: failedStage,
          primarySeverity: severityForPrimaryStage(failedStage),
          secondary,
        }
      : undefined;

  const metricsOut: Record<string, unknown> = {
    ...metrics,
    ...((verdict === "BLOCK" || verdict === "WAIT") && failedStage
      ? { primaryBlockerSeverity: severityForPrimaryStage(failedStage) }
      : {}),
  };

  const passThresholds = buildPassThresholds(
    config,
    entry,
    config.feeGateEnabled ? feeEval.requiredMovePct : null,
  );

  const stageChecks = buildMarketDecisionStageChecks({
    config,
    input,
    ltf,
    transition,
    chop,
    confidencePassed,
    useRegime,
    directionMismatchFlag,
    scoreOut,
    entry,
    feeEval,
  });

  const snap = buildSnapshot({
    input,
    ltf,
    stability,
    transition,
    chop,
    verdict,
    failedStage,
    reasons,
    metrics: metricsOut,
    confidencePassed,
    confidencePenalty,
    score: scoreOut,
    entryTiming: entry,
    feeGate: {
      enabled: config.feeGateEnabled,
      requiredMovePct: feeEval.requiredMovePct,
      expectedMovePct: input.feeGate.expectedMovePct,
      passed: feeEval.passed,
      reasons: feeEval.reasons,
      requiredMoveBasis: feeEval.requiredMoveBasis,
    },
    alignment,
    alignmentBlocked,
    pipelineDiagnostics,
    passThresholds,
    stageChecks,
  });

  return deepFreezeSnapshot(snap) as MarketDecisionSnapshot;
}

function buildSnapshot(p: {
  input: MarketDecisionInput;
  ltf: RegimeSlice;
  stability: ReturnType<typeof computeRegimeStability>;
  transition: ReturnType<typeof detectRegimeTransition>;
  chop: ReturnType<typeof evaluateChop>;
  verdict: DecisionVerdict;
  failedStage: PipelineStageId | null;
  reasons: string[];
  metrics: Record<string, unknown>;
  confidencePassed: boolean;
  confidencePenalty: number;
  score: MarketDecisionSnapshot["score"];
  entryTiming: MarketDecisionSnapshot["entryTiming"];
  feeGate: MarketDecisionSnapshot["feeGate"];
  alignment: "OK" | "MISMATCH" | "N_A";
  alignmentBlocked: boolean;
  pipelineDiagnostics?: MarketDecisionSnapshot["pipelineDiagnostics"];
  passThresholds?: MarketDecisionPassThresholds;
  stageChecks?: MarketDecisionSnapshot["stageChecks"];
}): MarketDecisionSnapshot {
  const { input } = p;
  return {
    version: MARKET_DECISION_SCHEMA_VERSION,
    evaluatedAt: input.evaluatedAtIso,
    symbol: input.symbol,
    timeframe: input.timeframe,
    signalSide: input.signalSide,
    verdict: p.verdict,
    failedStage: p.failedStage,
    reasons: p.reasons,
    metrics: p.metrics,
    ...(p.pipelineDiagnostics ? { pipelineDiagnostics: p.pipelineDiagnostics } : {}),
    ...(p.passThresholds ? { passThresholds: p.passThresholds } : {}),
    regime: {
      ltf: p.ltf,
      htf: input.regimeHtf,
      btc: input.regimeBtc,
      stability: p.stability,
      transition: p.transition,
    },
    chop: { isChoppy: p.chop.isChoppy, reasons: p.chop.reasons, metrics: p.chop.metrics },
    alignment: {
      directionVsRegime: p.alignment,
      blockedOrPenalized: p.alignmentBlocked || p.verdict === "BLOCK" || p.verdict === "WAIT",
    },
    confidenceGate: {
      regimeConfidence: p.ltf.confidence,
      minRequired: input.config.minRegimeConfidence,
      passed: p.confidencePassed,
      mode: input.config.confidenceMode,
    },
    score: p.score,
    entryTiming: p.entryTiming,
    feeGate: p.feeGate,
    ...(p.stageChecks != null ? { stageChecks: p.stageChecks } : {}),
  };
}
