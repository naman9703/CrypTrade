/**
 * Per-parameter market decision rows (parity with frontend/src/lib/marketDecision/stageChecks.ts).
 */

function rsiBiasPassesForConfig(signalSide, rsi, longMin, shortMax) {
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

function btcBlocksLocal(config, btc) {
  if (!config.btcFilterEnabled || btc == null) return false;
  if (btc.raw.adx < config.btcMinAdx) return true;
  if (btc.type === "SIDEWAYS" || btc.type === "UNCLEAR") return true;
  return false;
}

export function buildMarketDecisionStageChecks(args) {
  const {
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
  } = args;
  const rows = [];
  const push = (id, label, verdict, detail) => rows.push({ id, label, verdict, detail });

  const cm = input.classifierMetrics;
  const scoring = input.scoring;
  const htf = input.regimeHtf;

  if (!useRegime) {
    push("regime_filter", "Regime filter (master)", "N_A", "Regime filter layer disabled in config.");
  } else {
    if (!confidencePassed && config.confidenceMode === "BLOCK") {
      push(
        "regime_confidence",
        "Regime confidence",
        "BLOCK",
        `${ltf.confidence.toFixed(0)}% < min ${config.minRegimeConfidence}% (BLOCK mode)`,
      );
    } else if (!confidencePassed && config.confidenceMode === "PENALTY") {
      push(
        "regime_confidence",
        "Regime confidence",
        "ALLOW",
        `${ltf.confidence.toFixed(0)}% < min ${config.minRegimeConfidence}% — penalty −${config.confidencePenalty} to score (not a hard block)`,
      );
    } else {
      push(
        "regime_confidence",
        "Regime confidence",
        "ALLOW",
        `${ltf.confidence.toFixed(0)}% ≥ min ${config.minRegimeConfidence}%`,
      );
    }

    push(
      "regime_type",
      "Regime type (LTF)",
      "N_A",
      `${ltf.type} · strength ${ltf.strength.toFixed(0)} · classifier confidence ${ltf.confidence.toFixed(0)}%`,
    );

    if (!config.transitionBlockEnabled) {
      push("transition", "Regime transition block", "N_A", "Transition block disabled.");
    } else if (transition.detected) {
      push("transition", "Regime transition block", "BLOCK", transition.detail ?? "Chop + trend mix in lookback");
    } else {
      push("transition", "Regime transition block", "ALLOW", "No chop/trend transition flag in lookback.");
    }
  }

  if (cm) {
    const atrPct = Number(cm.atrPct);
    const th = Number(cm.atrVolThreshold);
    if (Number.isFinite(atrPct) && Number.isFinite(th) && th >= 0) {
      const pct = atrPct * 100;
      const thPct = th * 100;
      if (atrPct <= th) {
        push(
          "atr_volatile",
          "ATR % vs VOLATILE threshold",
          "ALLOW",
          `%ATR ${pct.toFixed(3)}% ≤ ${thPct.toFixed(3)}% — not forced into VOLATILE by ATR rule`,
        );
      } else {
        push(
          "atr_volatile",
          "ATR % vs VOLATILE threshold",
          "BLOCK",
          `%ATR ${pct.toFixed(3)}% > ${thPct.toFixed(3)}% — regime treats this as high vol (VOLATILE bucket)`,
        );
      }
    }
  }

  if (!config.chopEnabled || !useRegime) {
    push("chop_layer", "Chop layer (composite)", "N_A", !config.chopEnabled ? "Chop disabled." : "Regime filter off.");
  } else {
    if (config.chopAdxEnabled) {
      const adx = Number(chop.metrics.adx);
      const need = config.adxWeak;
      if (Number.isFinite(adx) && Number.isFinite(need)) {
        if (adx >= need) {
          push("chop_adx", "Chop · ADX weak", "ALLOW", `ADX ${adx.toFixed(1)} ≥ weak floor ${need} (no weak-ADX chop flag)`);
        } else {
          push("chop_adx", "Chop · ADX weak", "BLOCK", `ADX ${adx.toFixed(1)} < ${need} (weak trend / chop risk)`);
        }
      }
    } else {
      push("chop_adx", "Chop · ADX weak", "N_A", "Chop ADX sub-rule disabled.");
    }

    if (config.chopRangeEnabled) {
      const rc = Number(chop.metrics.rangeCompression);
      const need = config.chopRangeThreshold;
      if (Number.isFinite(rc) && Number.isFinite(need)) {
        if (rc >= need) {
          push(
            "chop_range",
            "Chop · range compression",
            "ALLOW",
            `Range₁₀ ${(rc * 100).toFixed(3)}% ≥ min ${(need * 100).toFixed(3)}%`,
          );
        } else {
          push(
            "chop_range",
            "Chop · range compression",
            "BLOCK",
            `Range₁₀ ${(rc * 100).toFixed(3)}% < ${(need * 100).toFixed(3)}% (tight range)`,
          );
        }
      }
    } else {
      push("chop_range", "Chop · range compression", "N_A", "Chop range sub-rule disabled.");
    }

    if (config.chopFlipEnabled) {
      const fl = Math.floor(Number(chop.metrics.flips));
      const maxF = config.chopMaxFlips;
      if (Number.isFinite(fl) && Number.isFinite(maxF)) {
        if (fl <= maxF) {
          push("chop_flips", "Chop · regime flips", "ALLOW", `Flips ${fl} ≤ max ${maxF}`);
        } else {
          push("chop_flips", "Chop · regime flips", "BLOCK", `Flips ${fl} > max ${maxF}`);
        }
      }
    } else {
      push("chop_flips", "Chop · regime flips", "N_A", "Chop flip sub-rule disabled.");
    }

    if (!chop.isChoppy) {
      push("chop_composite", "Chop · composite", "ALLOW", "No chop flags fired.");
    } else if (config.chopHardBlock) {
      push("chop_composite", "Chop · composite", "BLOCK", chop.reasons.join(" · ") || "Choppy");
    } else {
      push(
        "chop_composite",
        "Chop · composite",
        "ALLOW",
        `Chop flagged but soft mode — penalty −${config.penaltyChop} to score: ${chop.reasons.join(" · ")}`,
      );
    }
  }

  if (!config.btcFilterEnabled) {
    push("btc", "BTC filter", "N_A", "Disabled.");
  } else if (btcBlocksLocal(config, input.regimeBtc)) {
    if (config.btcBlockMode === "BLOCK") {
      push("btc", "BTC filter", "BLOCK", "Weak or sideways BTC regime (BLOCK mode).");
    } else {
      push(
        "btc",
        "BTC filter",
        "ALLOW",
        `Weak/sideways BTC — penalty −${config.btcFilterPenalty} to score (PENALTY mode)`,
      );
    }
  } else {
    push("btc", "BTC filter", "ALLOW", "BTC regime passes filter.");
  }

  if (!input.signalSide || !useRegime) {
    push("direction", "Direction vs regime", "N_A", !input.signalSide ? "No signal side on snapshot." : "Regime filter off.");
  } else if (directionMismatchFlag) {
    if (config.directionMismatchMode === "BLOCK") {
      push("direction", "Direction vs regime", "BLOCK", `${input.signalSide} vs regime ${ltf.type} (BLOCK mode)`);
    } else {
      push(
        "direction",
        "Direction vs regime",
        "ALLOW",
        `${input.signalSide} vs ${ltf.type} — penalty −${config.directionMismatchPenalty} to score (PENALTY mode)`,
      );
    }
  } else {
    push("direction", "Direction vs regime", "ALLOW", `${input.signalSide} aligns with ${ltf.type}.`);
  }

  if (!config.signalQualityEnabled) {
    push("score_total", "Composite score", "N_A", "Signal quality scoring disabled.");
    push("score_st", "Score · Supertrend confirm", "N_A", "—");
    push("score_ema", "Score · EMA alignment", "N_A", "—");
    push("score_rsi", "Score · RSI bias", "N_A", "—");
    push("score_htf", "Score · HTF match", "N_A", "—");
  } else if (scoreOut) {
    if (scoreOut.passed) {
      push(
        "score_total",
        "Composite score",
        "ALLOW",
        `${scoreOut.total.toFixed(1)} ≥ threshold ${scoreOut.threshold.toFixed(1)}`,
      );
    } else {
      const failMsg =
        scoreOut.failKind === "htf_match"
          ? `${scoreOut.total.toFixed(1)} vs threshold ${scoreOut.threshold.toFixed(1)} — HTF layer on but higher timeframe does not align (score blocked)`
          : `${scoreOut.total.toFixed(1)} < threshold ${scoreOut.threshold.toFixed(1)}`;
      push("score_total", "Composite score", "BLOCK", failMsg);
    }
    const stOk = scoring.supertrendConfirmed;
    push("score_st", "Score · Supertrend confirm", stOk ? "ALLOW" : "BLOCK", stOk ? "+weight" : "missed points");
    const emaOk = scoring.priceAboveEma;
    push("score_ema", "Score · EMA alignment", emaOk ? "ALLOW" : "BLOCK", emaOk ? "+weight" : "missed points");
    const rsiLm = Number(config.scoreRsiLongMin);
    const rsiSm = Number(config.scoreRsiShortMax);
    const longM = Number.isFinite(rsiLm) ? rsiLm : 52;
    const shortM = Number.isFinite(rsiSm) ? rsiSm : 48;
    const rsiOk = rsiBiasPassesForConfig(input.signalSide, scoring.rsi, longM, shortM);
    const r = Number(scoring.rsi);
    const rv = Number.isFinite(r) ? r.toFixed(1) : "—";
    let rsiDetail;
    if (input.signalSide === "SELL") rsiDetail = `${rsiOk ? "Met" : "Miss"} — RSI ${rv} (short needs ≤ ${shortM})`;
    else if (input.signalSide === "BUY") rsiDetail = `${rsiOk ? "Met" : "Miss"} — RSI ${rv} (long needs ≥ ${longM})`;
    else rsiDetail = `${rsiOk ? "Met" : "Miss"} — RSI ${rv} (long ≥ ${longM} · short ≤ ${shortM})`;
    push("score_rsi", "Score · RSI bias", rsiOk ? "ALLOW" : "BLOCK", rsiDetail);
    if (!config.htfEnabled || Number(config.weightHtfMatch) <= 0) {
      push("score_htf", "Score · HTF match", "N_A", "HTF off or HTF weight 0 — not in composite.");
    } else {
      const htfOk =
        htf != null &&
        ((ltf.type === "UPTREND" && htf.type === "UPTREND") ||
          (ltf.type === "DOWNTREND" && htf.type === "DOWNTREND"));
      const h = Boolean(scoring.htfTrendMatch) || htfOk;
      push(
        "score_htf",
        "Score · HTF match",
        h ? "ALLOW" : "BLOCK",
        h ? "+weight · aligns with LTF" : "missed points — HTF layer on; must align to pass score",
      );
    }
    if (scoring.isWeakTrend) {
      push("penalty_weak", "Penalty · weak trend", "BLOCK", `−${config.penaltyWeakTrend} to score`);
    } else {
      push("penalty_weak", "Penalty · weak trend", "ALLOW", "No weak-trend penalty.");
    }
    if (scoring.overextended) {
      push("penalty_overext", "Penalty · overextension", "BLOCK", `−${config.penaltyOverextension} to score`);
    } else {
      push("penalty_overext", "Penalty · overextension", "ALLOW", "No overextension penalty.");
    }
  }

  if (entry.mode === "INSTANT") {
    push("entry_timing", "Entry timing", "ALLOW", "INSTANT — always ENTER.");
  } else if (entry.recommendation === "ENTER") {
    push("entry_timing", "Entry timing", "ALLOW", `${entry.mode}: ${entry.reasons[0] ?? "ENTER"}`);
  } else {
    push("entry_timing", "Entry timing", "WAIT", `${entry.mode}: ${entry.reasons[0] ?? "WAIT"}`);
  }

  if (!config.feeGateEnabled) {
    push("fee_gate", "Fee vs expected move", "N_A", "Fee gate disabled.");
  } else if (feeEval.passed) {
    push(
      "fee_gate",
      "Fee vs expected move",
      "ALLOW",
      feeEval.reasons[0] ?? `required ${feeEval.requiredMovePct.toFixed(3)}% (${feeEval.requiredMoveBasis})`,
    );
  } else {
    push(
      "fee_gate",
      "Fee vs expected move",
      "BLOCK",
      feeEval.reasons[0] ?? `need ≥ ${feeEval.requiredMovePct.toFixed(3)}% move`,
    );
  }

  return rows;
}
