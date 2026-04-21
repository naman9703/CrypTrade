/**
 * Market regime + signal-quality decision engine (parity with frontend/src/lib/marketDecision).
 * Pure helpers + evaluateMarketDecision; used for multi-symbol watch snapshots.
 */

import { adx, atr, ema, rsi } from "../strategy/indicators.js";
import { binanceIntervalMs } from "./supertrendChartAlign.js";

export const MARKET_DECISION_SCHEMA_VERSION = 4;

export const DEFAULT_MARKET_DECISION_CONFIG = {
  enabled: false,
  regimeFilterEnabled: true,
  adxStrong: 25,
  adxWeak: 20,
  emaLength: 50,
  atrVolThreshold: 0.015,
  stabilityLookback: 5,
  stabilityMinAgree: 4,
  transitionBlockEnabled: true,
  transitionLookback: 3,
  minRegimeConfidence: 45,
  confidenceMode: "PENALTY",
  confidencePenalty: 25,
  chopEnabled: true,
  chopAdxEnabled: true,
  chopRangeEnabled: true,
  chopFlipEnabled: true,
  chopRangeThreshold: 0.012,
  chopMaxFlips: 3,
  chopHardBlock: true,
  directionMismatchMode: "BLOCK",
  directionMismatchPenalty: 40,
  allowSidewaysWithSignal: false,
  htfEnabled: false,
  htfTimeframe: "15m",
  btcFilterEnabled: false,
  btcSymbol: "BTCUSDT",
  btcMinAdx: 18,
  btcBlockMode: "BLOCK",
  btcFilterPenalty: 20,
  signalQualityEnabled: true,
  scoreThreshold: 5,
  weightSupertrend: 3,
  weightEmaAlign: 2,
  weightRsi: 1,
  weightHtfMatch: 2,
  penaltyChop: 3,
  penaltyWeakTrend: 2,
  penaltyOverextension: 2,
  entryMode: "PULLBACK",
  pullbackAtrMult: 0.35,
  feeGateEnabled: true,
  feeSlippageBps: 3,
  feeBufferPct: 0.15,
  defaultRoundTripFeeRate: 0.0016,
};

export function mergeMarketDecisionConfig(partial) {
  if (!partial || typeof partial !== "object") return { ...DEFAULT_MARKET_DECISION_CONFIG };
  return { ...DEFAULT_MARKET_DECISION_CONFIG, ...partial };
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.min(100, Math.max(0, x));
}

function computeRegimeSliceFromBar(args) {
  const { adx: adxV, price, ema: emaV, prevEma, atr: atrV, adxStrong, adxWeak, atrVolThreshold } = args;
  const p = Number(price);
  const emaSlope = Number(emaV) - Number(prevEma);
  const atrN = Number(atrV);
  const adxN = Number(adxV);
  const atrRatio = Number.isFinite(p) && p > 0 && Number.isFinite(atrN) ? atrN / p : 0;

  let strength = Math.min(100, Math.max(0, adxN * 2.2));
  if (adxN > adxStrong + 10) strength = Math.min(100, strength + 8);

  let type = "UNCLEAR";

  if (atrRatio > atrVolThreshold) {
    type = "VOLATILE";
    strength = Math.max(strength, 40);
  } else if (adxN < adxWeak && atrRatio < atrVolThreshold * 0.6) {
    type = "SIDEWAYS";
    strength = Math.min(strength, 35);
  } else if (p > emaV && emaSlope > 0) {
    type = "UPTREND";
  } else if (p < emaV && emaSlope < 0) {
    type = "DOWNTREND";
  } else {
    type = "UNCLEAR";
  }

  let conf = 0;
  conf += clamp01(((adxN - 15) / 25) * 100) * 0.45;
  const aligned =
    (type === "UPTREND" && p >= emaV) ||
    (type === "DOWNTREND" && p <= emaV) ||
    type === "VOLATILE";
  if (aligned) conf += 25;
  if (Math.abs(emaSlope) / (p || 1) > 1e-6) conf += 15;
  if (type === "SIDEWAYS") conf *= 0.65;
  if (type === "UNCLEAR") conf *= 0.55;

  return {
    type,
    strength: clamp01(strength),
    confidence: clamp01(conf),
    raw: {
      adx: adxN,
      atrRatio,
      emaSlope,
      price: p,
      ema: Number(emaV),
    },
  };
}

function buildRegimeHistoryLtf(closes, adxArr, atrArr, emaArr, cfg) {
  const n = closes.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const prevEma = i > 0 ? emaArr[i - 1] : emaArr[i];
    out[i] = computeRegimeSliceFromBar({
      adx: adxArr[i] ?? 0,
      price: closes[i] ?? 0,
      ema: emaArr[i] ?? 0,
      prevEma,
      atr: atrArr[i] ?? 0,
      adxStrong: cfg.adxStrong,
      adxWeak: cfg.adxWeak,
      atrVolThreshold: cfg.atrVolThreshold,
    });
  }
  return out;
}

/** Merge consecutive LTF OHLC rows into HTF bars when HTF / LTF is integer. */
function aggregateLtfCandlesToHtf(ltfCandles, ltfTf, htfTf) {
  const ltfMs = binanceIntervalMs(ltfTf);
  const htfMs = binanceIntervalMs(htfTf);
  if (!ltfMs || !htfMs || htfMs < ltfMs) return null;
  const ratio = htfMs / ltfMs;
  if (!Number.isInteger(ratio) || ratio < 1) return null;
  const out = [];
  for (let i = 0; i + ratio <= ltfCandles.length; i += ratio) {
    const chunk = ltfCandles.slice(i, i + ratio);
    const ts = Number(chunk[0]?.ts);
    const open = Number(chunk[0]?.open ?? chunk[0]?.close ?? 0);
    let high = -Infinity;
    let low = Infinity;
    for (const c of chunk) {
      high = Math.max(high, Number(c.high ?? c.close ?? 0));
      low = Math.min(low, Number(c.low ?? c.close ?? 0));
    }
    const close = Number(chunk[ratio - 1]?.close ?? 0);
    out.push({ ts, open, high, low, close });
  }
  return out.length ? out : null;
}

function regimeHtfSliceAtLast(htfCandles, cfg) {
  const n = htfCandles.length;
  if (n < 2) return null;
  const minBars = Math.max(30, cfg.emaLength + 2);
  if (n < minBars) return null;
  const closes = htfCandles.map((c) => Number(c.close));
  const adxArr = adx(htfCandles, 14);
  const atrArr = atr(htfCandles, 14);
  const emaArr = ema(closes, cfg.emaLength);
  const idx = n - 1;
  const close = closes[idx] ?? 0;
  const adxV = adxArr[idx] ?? 0;
  const atrV = atrArr[idx] ?? 0;
  const emaV = emaArr[idx] ?? close;
  const prevEma = idx > 0 ? emaArr[idx - 1] : emaV;
  return computeRegimeSliceFromBar({
    adx: adxV,
    price: close,
    ema: emaV,
    prevEma,
    atr: atrV,
    adxStrong: cfg.adxStrong,
    adxWeak: cfg.adxWeak,
    atrVolThreshold: cfg.atrVolThreshold,
  });
}

function resolveRegimeHtfFromLtf(raw, ltfTimeframe, cfg, regimeHtfPassed) {
  if (regimeHtfPassed != null) return regimeHtfPassed;
  if (!cfg.htfEnabled) return null;
  const agg = aggregateLtfCandlesToHtf(raw, ltfTimeframe, cfg.htfTimeframe);
  if (!agg) return null;
  return regimeHtfSliceAtLast(agg, cfg);
}

function trendFamily(t) {
  if (t === "UPTREND") return "UP";
  if (t === "DOWNTREND") return "DOWN";
  return "NEUTRAL";
}

function computeRegimeStability(history, lookback, minAgree) {
  const n = history.length;
  const lb = Math.max(1, Math.min(lookback, n));
  const slice = history.slice(-lb);
  if (slice.length === 0) {
    return { stable: false, label: "—", agree: 0, lookback: lb };
  }
  const fam0 = trendFamily(slice[0].type);
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

function detectRegimeTransition(history, lookback) {
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

function countRegimeFlips(history, lookback) {
  const slice = history.slice(-Math.max(2, lookback));
  if (slice.length < 2) return 0;
  let flips = 0;
  for (let i = 1; i < slice.length; i++) {
    if (slice[i].type !== slice[i - 1].type) flips += 1;
  }
  return flips;
}

function evaluateChop(args) {
  const { config, history, adx: adxVal, rangeCompression } = args;
  const reasons = [];
  const metrics = {
    adx: Number(adxVal),
    rangeCompression: Number(rangeCompression),
    flips: countRegimeFlips(history, config.stabilityLookback + 2),
  };

  if (!config.chopEnabled) {
    return { isChoppy: false, reasons: [], metrics };
  }

  if (config.chopAdxEnabled && adxVal < config.adxWeak) {
    reasons.push(`ADX ${adxVal.toFixed(1)} < weak ${config.adxWeak}`);
  }
  if (config.chopRangeEnabled && rangeCompression < config.chopRangeThreshold) {
    reasons.push(
      `Range compression ${(rangeCompression * 100).toFixed(3)}% < ${(config.chopRangeThreshold * 100).toFixed(3)}%`,
    );
  }
  if (config.chopFlipEnabled && metrics.flips > config.chopMaxFlips) {
    reasons.push(`Regime flips ${metrics.flips} > ${config.chopMaxFlips}`);
  }

  return { isChoppy: reasons.length > 0, reasons, metrics };
}

function computeRequiredMovePct(config, roundTripFeeRate) {
  const rt = Math.max(0, Number(roundTripFeeRate) || 0);
  const buf = Math.max(0, Number(config.feeBufferPct) || 0);
  const slip = Math.max(0, Number(config.feeSlippageBps) || 0) / 100;
  return rt * 100 + buf + slip;
}

function evaluateFeeGate(args) {
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
  const reasons = [
    passed
      ? `Expected move ${exp.toFixed(3)}% ≥ required ${req.toFixed(3)}%`
      : `Expected move ${exp.toFixed(3)}% < required ${req.toFixed(3)}%`,
  ];
  return { passed, requiredMovePct: req, reasons };
}

function evaluateEntryTiming(args) {
  const { config, price, ema: emaV, atr: atrV } = args;
  const p = Number(price);
  const e = Number(emaV);
  const a = Number(atrV);
  const mode = config.entryMode;

  const metrics = {
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

  const needBreak = dist < threshold * 0.5;
  return {
    mode,
    recommendation: needBreak ? "WAIT" : "ENTER",
    metrics: { ...metrics, threshold },
    reasons: needBreak ? ["Breakout mode: waiting for expansion"] : ["Breakout conditions met"],
  };
}

function rsiBiasPasses(signalSide, rsi) {
  const r = Number(rsi);
  if (!Number.isFinite(r)) return false;
  if (signalSide === "SELL") return r <= 50;
  if (signalSide === "BUY") return r >= 50;
  return r >= 50;
}

function computeSignalQualityScore(
  config,
  input,
  ltf,
  htf,
  confidencePenalty,
  softChopPenalty,
  directionMismatchPenalty,
  btcPenalty = 0,
) {
  const breakdown = [];
  let total = 0;
  const { scoring } = input;

  const add = (id, label, cond, w, note) => {
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
    ((ltf.type === "UPTREND" && htf.type === "UPTREND") || (ltf.type === "DOWNTREND" && htf.type === "DOWNTREND"));
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
    config.weightSupertrend + config.weightEmaAlign + config.weightRsi + config.weightHtfMatch;

  const passed = total >= config.scoreThreshold;
  return { total, max, threshold: config.scoreThreshold, passed, breakdown };
}

function directionMismatch(signalSide, ltf, allowSideways) {
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

function btcBlocks(config, btc) {
  if (!config.btcFilterEnabled || btc == null) return false;
  if (btc.raw.adx < config.btcMinAdx) return true;
  if (btc.type === "SIDEWAYS" || btc.type === "UNCLEAR") return true;
  return false;
}

function deepFreezeSnapshot(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v !== null && typeof v === "object") deepFreezeSnapshot(v);
  }
  return obj;
}

function severityForPrimaryStage(stage) {
  if (stage === "chop" || stage === "regime_confidence" || stage === "transition" || stage === "direction_alignment") {
    return "high";
  }
  if (stage === "fee_gate" || stage === "signal_score" || stage === "btc_filter") return "medium";
  if (stage === "entry_timing") return "low";
  return "medium";
}

function buildPassThresholds(config, entry, feeRequiredPct) {
  const th = entry.metrics?.threshold;
  const t = typeof th === "number" && Number.isFinite(th) ? th : null;
  let entryTimingPassHint = null;
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
  };
}

function buildSnapshot(p) {
  const { input } = p;
  const out = {
    version: MARKET_DECISION_SCHEMA_VERSION,
    evaluatedAt: input.evaluatedAtIso,
    symbol: input.symbol,
    timeframe: input.timeframe,
    signalSide: input.signalSide,
    verdict: p.verdict,
    failedStage: p.failedStage,
    reasons: p.reasons,
    metrics: p.metrics,
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
  };
  if (p.pipelineDiagnostics) out.pipelineDiagnostics = p.pipelineDiagnostics;
  if (p.passThresholds) out.passThresholds = p.passThresholds;
  return out;
}

export function evaluateMarketDecision(input) {
  const { config } = input;
  const reasons = [];
  let verdict = "ALLOW";
  let failedStage = null;

  const hist = input.regimeHistoryLtf;
  const ltf = hist[hist.length - 1];
  const stability = computeRegimeStability(hist, config.stabilityLookback, config.stabilityMinAgree);
  const transition = detectRegimeTransition(hist, config.transitionLookback);
  const chop = evaluateChop({
    config,
    history: hist,
    adx: input.chop.adx,
    rangeCompression: input.chop.rangeCompression,
  });

  const metrics = {
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
    const merged = {
      ...hypot,
      version: MARKET_DECISION_SCHEMA_VERSION,
      engineDisabled: true,
      reasons: [
        "Market decision engine disabled — verdict is what would apply if enabled; trading is not filtered.",
        ...(Array.isArray(hypot.reasons) ? hypot.reasons : []),
      ],
      entryTiming: {
        ...hypot.entryTiming,
        reasons: [
          ...(Array.isArray(hypot.entryTiming?.reasons) ? hypot.entryTiming.reasons : []),
          "Not enforced — engine master switch is off",
        ],
      },
      feeGate: {
        ...hypot.feeGate,
        reasons: [
          ...(Array.isArray(hypot.feeGate?.reasons) ? hypot.feeGate.reasons : []),
          "Not enforced — engine master switch is off",
        ],
      },
    };
    return deepFreezeSnapshot(merged);
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

  let alignment = "N_A";
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

  let scoreOut;
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
      reasons.push(`Score ${sc.total.toFixed(1)} < threshold ${sc.threshold}`);
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

  const secondary = [];
  const addSecondary = (stage, sev, msg) => {
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
    addSecondary("direction_alignment", "high", `${input.signalSide} vs regime ${ltf.type} would block`);
  }
  if (config.btcFilterEnabled && btcBlocks(config, input.regimeBtc) && config.btcBlockMode === "BLOCK" && failedStage !== "btc_filter") {
    addSecondary("btc_filter", "medium", "BTC filter: weak or sideways regime");
  }

  if (config.signalQualityEnabled && failedStage !== "signal_score" && verdict !== "ALLOW" && verdict !== "BYPASS") {
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
      addSecondary("signal_score", "medium", `${sc.total.toFixed(1)} < ${sc.threshold} (would block)`);
    } else {
      addSecondary("signal_score", "medium", `${sc.total.toFixed(1)} ≥ ${sc.threshold} (would pass)`);
    }
  }

  const pipelineDiagnostics =
    (verdict === "BLOCK" || verdict === "WAIT") && failedStage != null
      ? {
          primaryStage: failedStage,
          primarySeverity: severityForPrimaryStage(failedStage),
          secondary,
        }
      : undefined;

  const metricsOut = {
    ...metrics,
    ...((verdict === "BLOCK" || verdict === "WAIT") && failedStage ? { primaryBlockerSeverity: severityForPrimaryStage(failedStage) } : {}),
  };

  const passThresholds = buildPassThresholds(
    config,
    entry,
    config.feeGateEnabled ? feeEval.requiredMovePct : null,
  );

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
    },
    alignment,
    alignmentBlocked,
    pipelineDiagnostics,
    passThresholds,
  });

  return deepFreezeSnapshot(snap);
}

function rangeCompressionAt(candles, idx, windowBars) {
  const w = Math.min(windowBars, idx + 1);
  let hi = -Infinity;
  let lo = Infinity;
  const start = idx - w + 1;
  for (let i = start; i <= idx; i++) {
    const c = candles[i];
    const h = Number(c?.high ?? c?.close ?? 0);
    const l = Number(c?.low ?? c?.close ?? 0);
    if (Number.isFinite(h)) hi = Math.max(hi, h);
    if (Number.isFinite(l)) lo = Math.min(lo, l);
  }
  const price = Number(candles[idx]?.close);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(hi) || !Number.isFinite(lo)) return 0;
  return (hi - lo) / price;
}

/**
 * When `enabled` is false, still attach a BYPASS snapshot for every signal even if candle history
 * is shorter than the full ADX/EMA pipeline (otherwise `computeMarketDecisionSnapshot` returned null).
 */
function minimalBypassWhenNoCandles(cfg, symbol, timeframe) {
  const emptyLtf = {
    type: "UNCLEAR",
    strength: 0,
    confidence: 0,
    raw: { adx: 0, atrRatio: 0, emaSlope: 0, price: 0, ema: 0 },
  };
  const input = {
    config: cfg,
    symbol: String(symbol || "").toUpperCase(),
    timeframe: String(timeframe || ""),
    evaluatedAtIso: new Date().toISOString(),
    signalSide: null,
    regimeHistoryLtf: [emptyLtf],
    regimeHtf: null,
    regimeBtc: null,
    chop: { adx: 0, rangeCompression: 0 },
    scoring: {
      supertrendConfirmed: false,
      priceAboveEma: false,
      rsi: 50,
      htfTrendMatch: false,
      overextended: false,
      isWeakTrend: true,
    },
    entryTiming: { price: 0, ema: 0, atr: 0 },
    feeGate: {
      expectedMovePct: NaN,
      leverage: 1,
      roundTripFeeRate: cfg.defaultRoundTripFeeRate,
    },
  };
  const snap = evaluateMarketDecision(input);
  const reasons = [...(Array.isArray(snap.reasons) ? snap.reasons : []), "No candles — placeholder BYPASS snapshot"];
  return deepFreezeSnapshot({
    ...snap,
    reasons,
    metrics: { ...(snap.metrics && typeof snap.metrics === "object" ? snap.metrics : {}), warmupPartial: true, noCandles: true },
  });
}

function computeMarketDecisionSnapshotEngineOffWarmup({
  cfg,
  raw,
  idxRaw,
  row,
  decisionSnapshotBar,
  symbol,
  timeframe,
  regimeBtc,
  regimeHtf,
}) {
  if (raw.length === 0) return minimalBypassWhenNoCandles(cfg, symbol, timeframe);

  const idxUse = idxRaw >= 0 ? idxRaw : raw.length - 1;
  const closes = raw.map((c) => Number(c.close));
  const adxArr = adx(raw, 14);
  const atrArr = atr(raw, 14);
  const emaArr = ema(closes, cfg.emaLength);
  const rsiArr = rsi(closes, 14);

  const close = Number.isFinite(closes[idxUse]) ? closes[idxUse] : 0;
  const adxV = Number.isFinite(adxArr[idxUse]) ? adxArr[idxUse] : 0;
  const atrV = Number.isFinite(atrArr[idxUse]) ? atrArr[idxUse] : 0;
  const emaV = Number.isFinite(emaArr[idxUse]) ? emaArr[idxUse] : close;
  const prevEma = idxUse > 0 && Number.isFinite(emaArr[idxUse - 1]) ? emaArr[idxUse - 1] : emaV;
  const ltfNow = computeRegimeSliceFromBar({
    adx: adxV,
    price: close,
    ema: emaV,
    prevEma,
    atr: atrV,
    adxStrong: cfg.adxStrong,
    adxWeak: cfg.adxWeak,
    atrVolThreshold: cfg.atrVolThreshold,
  });

  const rangeComp = rangeCompressionAt(raw, idxUse, 10);
  const rsiLast = Number.isFinite(rsiArr[idxUse]) ? rsiArr[idxUse] : 50;
  const signalSide = row?.buySignal ? "BUY" : row?.sellSignal ? "SELL" : null;

  let expectedMovePct = NaN;
  const expMovePrice =
    signalSide === "BUY"
      ? decisionSnapshotBar?.expectedMoveLong
      : signalSide === "SELL"
        ? decisionSnapshotBar?.expectedMoveShort
        : null;
  if (expMovePrice != null && Number.isFinite(Number(expMovePrice)) && close > 0) {
    expectedMovePct = (Number(expMovePrice) / close) * 100;
  }

  const priceAboveEmaAligned =
    signalSide === "BUY" ? close > emaV : signalSide === "SELL" ? close < emaV : false;
  const atrPct = close > 0 && atrV > 0 ? atrV / close : 0;
  const distPct = close > 0 ? Math.abs(close - emaV) / close : 0;
  const overextended = atrPct > 0 && distPct > 2 * atrPct;
  const isWeakTrend = adxV < cfg.adxWeak || ltfNow?.type === "SIDEWAYS";

  const regimeHtfResolvedW = resolveRegimeHtfFromLtf(raw, timeframe, cfg, regimeHtf);
  const htfTrendMatchW =
    regimeHtfResolvedW != null &&
    ((ltfNow.type === "UPTREND" && regimeHtfResolvedW.type === "UPTREND") ||
      (ltfNow.type === "DOWNTREND" && regimeHtfResolvedW.type === "DOWNTREND"));

  const input = {
    config: cfg,
    symbol: String(symbol || "").toUpperCase(),
    timeframe: String(timeframe || ""),
    evaluatedAtIso: new Date().toISOString(),
    signalSide,
    regimeHistoryLtf: [ltfNow],
    regimeHtf: cfg.htfEnabled ? regimeHtfResolvedW : null,
    regimeBtc: cfg.btcFilterEnabled ? regimeBtc : null,
    chop: { adx: adxV, rangeCompression: rangeComp },
    scoring: {
      supertrendConfirmed: Boolean(row?.buySignal || row?.sellSignal),
      priceAboveEma: priceAboveEmaAligned,
      rsi: rsiLast,
      htfTrendMatch: Boolean(htfTrendMatchW),
      overextended,
      isWeakTrend,
    },
    entryTiming: { price: close, ema: emaV, atr: atrV },
    feeGate: {
      expectedMovePct,
      leverage: 1,
      roundTripFeeRate: cfg.defaultRoundTripFeeRate,
    },
  };

  const snap = evaluateMarketDecision(input);
  const minBarsFull = Math.max(30, cfg.emaLength + 2);
  const extra =
    idxRaw < 0
      ? "Bar timestamp not in series — used last candle for warm-up BYPASS snapshot."
      : `Warm-up BYPASS (${raw.length}/${minBarsFull} bars for full regime pipeline).`;
  const reasons = Array.isArray(snap.reasons) ? [...snap.reasons, extra] : [extra];
  const metrics = {
    ...(snap.metrics && typeof snap.metrics === "object" ? snap.metrics : {}),
    warmupPartial: true,
  };
  const atrPctOut = close > 0 && atrV > 0 ? atrV / close : 0;
  const emaSlopeBar =
    idxUse > 0 && Number.isFinite(emaArr[idxUse]) && Number.isFinite(emaArr[idxUse - 1])
      ? emaArr[idxUse] - emaArr[idxUse - 1]
      : null;

  return deepFreezeSnapshot({
    ...snap,
    reasons,
    metrics,
    classifierInputs: {
      price: close,
      ema: emaV,
      emaLength: cfg.emaLength,
      emaSlope: emaSlopeBar,
      adx: adxV,
      adxPeriod: 14,
      rsi: rsiLast,
      rsiPeriod: 14,
      atr: atrV,
      atrPeriod: 14,
      atrPct: atrPctOut,
      rangeCompression: rangeComp,
    },
  });
}

/**
 * @param {object} p
 * @param {Array<{ high?: number, low?: number, close: number }>} p.candles
 * @param {number} p.cTs
 * @param {{ buySignal?: boolean, sellSignal?: boolean, trend?: number }} p.row
 * @param {object} p.decisionSnapshotBar — from computeDecisionSnapshot
 * @param {string} p.symbol
 * @param {string} p.timeframe
 * @param {object} p.config — merged MarketDecisionEngineConfig
 * @param {object | null} [p.regimeBtc]
 * @param {object | null} [p.regimeHtf]
 */
export function computeMarketDecisionSnapshot({
  candles,
  cTs,
  row,
  decisionSnapshotBar,
  symbol,
  timeframe,
  config,
  regimeBtc = null,
  regimeHtf = null,
}) {
  const cfg = mergeMarketDecisionConfig(config);
  const raw = Array.isArray(candles) ? candles : [];
  const idxRaw = raw.findIndex((c) => Number(c?.ts) === Number(cTs));
  const minBarsFull = Math.max(30, cfg.emaLength + 2);
  if (idxRaw < 0 || raw.length < minBarsFull) {
    if (!cfg.enabled) {
      try {
        return computeMarketDecisionSnapshotEngineOffWarmup({
          cfg,
          raw,
          idxRaw,
          row,
          decisionSnapshotBar,
          symbol,
          timeframe,
          regimeBtc,
          regimeHtf,
        });
      } catch {
        return null;
      }
    }
    return null;
  }

  const closes = raw.map((c) => Number(c.close));
  const adxArr = adx(raw, 14);
  const atrArr = atr(raw, 14);
  const emaArr = ema(closes, cfg.emaLength);
  const rsiArr = rsi(closes, 14);

  const needHist = Math.max(cfg.stabilityLookback + 8, cfg.transitionLookback + 6, 24);
  const start = Math.max(0, idxRaw + 1 - needHist);
  const subRaw = raw.slice(start, idxRaw + 1);
  const subCloses = closes.slice(start, idxRaw + 1);
  const subAdx = adxArr.slice(start, idxRaw + 1);
  const subAtr = atrArr.slice(start, idxRaw + 1);
  const subEma = emaArr.slice(start, idxRaw + 1);

  const histCfg = {
    adxStrong: cfg.adxStrong,
    adxWeak: cfg.adxWeak,
    atrVolThreshold: cfg.atrVolThreshold,
  };
  const regimeHistoryLtf = buildRegimeHistoryLtf(subCloses, subAdx, subAtr, subEma, histCfg);

  const close = closes[idxRaw];
  const price = Number.isFinite(close) ? close : 0;
  const emaLast = emaArr[idxRaw] ?? 0;
  const atrLast = atrArr[idxRaw] ?? 0;
  const rsiLast = rsiArr[idxRaw] ?? 50;

  const signalSide = row?.buySignal ? "BUY" : row?.sellSignal ? "SELL" : null;

  let expectedMovePct = NaN;
  const expMovePrice =
    signalSide === "BUY"
      ? decisionSnapshotBar?.expectedMoveLong
      : signalSide === "SELL"
        ? decisionSnapshotBar?.expectedMoveShort
        : null;
  if (expMovePrice != null && Number.isFinite(Number(expMovePrice)) && price > 0) {
    expectedMovePct = (Number(expMovePrice) / price) * 100;
  }

  const chopAdx = adxArr[idxRaw] ?? 0;
  const rangeComp = rangeCompressionAt(raw, idxRaw, 10);

  const priceAboveEmaAligned =
    signalSide === "BUY"
      ? price > emaLast
      : signalSide === "SELL"
        ? price < emaLast
        : false;

  const atrPct = price > 0 && atrLast > 0 ? atrLast / price : 0;
  const distPct = price > 0 ? Math.abs(price - emaLast) / price : 0;
  const overextended = atrPct > 0 && distPct > 2 * atrPct;

  const ltfLast = regimeHistoryLtf[regimeHistoryLtf.length - 1];
  const isWeakTrend = (adxArr[idxRaw] ?? 0) < cfg.adxWeak || ltfLast?.type === "SIDEWAYS";

  const regimeHtfResolved = resolveRegimeHtfFromLtf(raw, timeframe, cfg, regimeHtf);
  const htfTrendMatch =
    regimeHtfResolved != null &&
    ((ltfLast.type === "UPTREND" && regimeHtfResolved.type === "UPTREND") ||
      (ltfLast.type === "DOWNTREND" && regimeHtfResolved.type === "DOWNTREND"));

  const input = {
    config: cfg,
    symbol: String(symbol || "").toUpperCase(),
    timeframe: String(timeframe || ""),
    evaluatedAtIso: new Date().toISOString(),
    signalSide,
    regimeHistoryLtf,
    regimeHtf: cfg.htfEnabled ? regimeHtfResolved : null,
    regimeBtc: cfg.btcFilterEnabled ? regimeBtc : null,
    chop: {
      adx: chopAdx,
      rangeCompression: rangeComp,
    },
    scoring: {
      supertrendConfirmed: Boolean(row?.buySignal || row?.sellSignal),
      priceAboveEma: priceAboveEmaAligned,
      rsi: rsiLast,
      htfTrendMatch: Boolean(htfTrendMatch),
      overextended,
      isWeakTrend,
    },
    entryTiming: {
      price,
      ema: emaLast,
      atr: atrLast,
    },
    feeGate: {
      expectedMovePct,
      leverage: 1,
      roundTripFeeRate: cfg.defaultRoundTripFeeRate,
    },
  };

  const snap = evaluateMarketDecision(input);
  const adxBar = adxArr[idxRaw];
  const rsiBar = rsiArr[idxRaw];
  const emaSlopeBar =
    idxRaw > 0 && Number.isFinite(emaArr[idxRaw]) && Number.isFinite(emaArr[idxRaw - 1])
      ? emaArr[idxRaw] - emaArr[idxRaw - 1]
      : null;

  return deepFreezeSnapshot({
    ...snap,
    /** Bar-close inputs used for regime classification (UI strip). */
    classifierInputs: {
      price,
      ema: emaLast,
      emaLength: cfg.emaLength,
      emaSlope: emaSlopeBar,
      adx: adxBar,
      adxPeriod: 14,
      rsi: rsiBar,
      rsiPeriod: 14,
      atr: atrLast,
      atrPeriod: 14,
      atrPct,
      rangeCompression: rangeComp,
    },
  });
}
