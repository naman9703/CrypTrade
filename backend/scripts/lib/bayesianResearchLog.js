/**
 * Bayesian research log — belief evolution about market propositions, not strategies.
 * Propositions are reusable across strategy families.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { INFORMATION_LEVELS } from "./informationHierarchy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, "bayesian-research-log.json");

/** Market propositions — not strategy names. */
export const MARKET_PROPOSITIONS = {
  liq_continuation_ohlcv: {
    prior: 0.7,
    alpha: 7,
    beta: 3,
    proposition: "Liquidity continuation after reclaim is predictable from OHLCV (L0–L1)",
    informationLevels: ["L0", "L1"],
    reusableAcross: ["Family A", "LIQ_MAP"],
  },
  regime_conditional_continuation: {
    prior: 0.5,
    alpha: 5,
    beta: 5,
    proposition: "Continuation probability depends on market regime (L1)",
    informationLevels: ["L0", "L1"],
    reusableAcross: ["Family A", "Family C"],
  },
  orderflow_improves_discrimination: {
    prior: 0.55,
    alpha: 5.5,
    beta: 4.5,
    proposition: "Historical order-book microstructure (L3) materially improves discrimination",
    informationLevels: ["L3"],
    requiredLevels: ["L3"],
    untestable: true,
    reusableAcross: ["execution", "microstructure hypotheses"],
  },
  oi_liquidations_improve_liq: {
    prior: 0.45,
    alpha: 4.5,
    beta: 5.5,
    proposition: "Open interest and funding (L2) improve hypothesis discrimination vs L0–L1 alone",
    informationLevels: ["L2"],
    requiredLevels: ["L2"],
    untestable: false,
    reusableAcross: ["Family A retest", "positioning hypotheses"],
  },
  trend_ohlcv_predictable: {
    prior: 0.35,
    alpha: 3.5,
    beta: 6.5,
    proposition: "Trend acceleration is predictable from OHLCV-derived features (L0–L1)",
    informationLevels: ["L0", "L1"],
    reusableAcross: ["Family C", "SUPERTREND_ELITE"],
  },
};

export function loadBeliefLog() {
  const base = { propositions: { ...MARKET_PROPOSITIONS }, history: [], updatedAt: null };
  if (!fs.existsSync(LOG_PATH)) return base;
  const data = JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));
  const saved = data.propositions ?? data.beliefs ?? {};
  for (const [k, defaults] of Object.entries(MARKET_PROPOSITIONS)) {
    const s = saved[k];
    if (s?.alpha != null && s?.beta != null) {
      base.propositions[k] = { ...defaults, alpha: s.alpha, beta: s.beta, posterior: s.posterior };
    }
  }
  base.history = data.history ?? [];
  return base;
}

export function saveBeliefLog(data) {
  fs.writeFileSync(LOG_PATH, JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2));
}

export function updateBelief(belief, strength, event) {
  const weight = event.weight ?? 1;
  const newAlpha = belief.alpha + strength * weight;
  const newBeta = belief.beta + (1 - strength) * weight;
  const posterior = newAlpha / (newAlpha + newBeta);
  return {
    ...belief,
    alpha: newAlpha,
    beta: newBeta,
    posterior: Number(posterior.toFixed(4)),
    lastEvent: event,
  };
}

export function applyEvidenceToBeliefs(experimentResults = [], uoaReport = null) {
  const log = loadBeliefLog();
  const events = [];

  const liqExps = experimentResults.filter((e) =>
    ["EXP-001", "EXP-002", "EXP-003", "EXP-004", "EXP-006"].includes(e.id),
  );
  if (liqExps.length) {
    const rejectRate = liqExps.filter((e) => e.accepted === false).length / liqExps.length;
    const strength = Math.max(0.05, 0.15 * (1 - rejectRate * 0.5));
    log.propositions.liq_continuation_ohlcv = updateBelief(log.propositions.liq_continuation_ohlcv, strength, {
      type: "validation_batch",
      detail: `${liqExps.length} experiments at L0–L1: ${(rejectRate * 100).toFixed(0)}% disproven`,
      weight: liqExps.length * 0.4,
    });
    events.push({
      proposition: "liq_continuation_ohlcv",
      strength,
      posterior: log.propositions.liq_continuation_ohlcv.posterior,
    });
  }

  if (uoaReport?.failureModes?.similar_expected_r > 0) {
    log.propositions.liq_continuation_ohlcv = updateBelief(log.propositions.liq_continuation_ohlcv, 0.1, {
      type: "uoa_unexplained_variance",
      detail: "Identical L1 features, divergent outcomes — L0–L1 may be exhausted for this formulation",
      weight: 2,
    });
    log.propositions.orderflow_improves_discrimination = updateBelief(
      log.propositions.orderflow_improves_discrimination,
      0.6,
      {
        type: "uoa_missing_information",
        detail: "Unexplained variance suggests L2+ information may be required — proposition untestable until ingested",
        weight: 1,
      },
    );
    events.push({ proposition: "liq_continuation_ohlcv", note: "L0-L1 plateau suspected" });
    events.push({ proposition: "orderflow_improves_discrimination", note: "L2 may be needed" });
  }

  log.history.push({ at: new Date().toISOString(), events });
  saveBeliefLog(log);
  return log;
}

export function beliefLogToMarkdown(log) {
  const lines = [
    "# Bayesian Research Log — Market Propositions",
    "",
    "Beliefs about what is predictable — reusable across strategy families.",
    "",
    "| Proposition | Levels | Prior | Posterior | Status |",
    "|-------------|--------|-------|-----------|--------|",
  ];
  for (const [key, p] of Object.entries(log.propositions ?? {})) {
    if (!p?.proposition && !p?.label) continue;
    const text = p.proposition ?? p.label ?? key;
    const posterior = p.posterior ?? p.alpha / (p.alpha + p.beta);
    const untestable = p.untestable || (p.requiredLevels ?? []).some((l) => !INFORMATION_LEVELS[l]?.available);
    const status = untestable ? "Untestable (missing info)" : posterior > 0.5 ? "Plausible" : "Unlikely";
    lines.push(
      `| ${text.slice(0, 60)}… | ${(p.informationLevels ?? []).join(", ")} | ${((p.prior ?? 0.5) * 100).toFixed(0)}% | **${(posterior * 100).toFixed(0)}%** | ${status} |`,
    );
  }
  if (log.history.length) {
    const last = log.history[log.history.length - 1];
    lines.push("", "## Latest update", "", ...last.events.map((e) => `- ${e.proposition}: ${e.note ?? `posterior ${e.posterior ?? "—"}`}`));
  }
  return lines.join("\n");
}

// Backward compat alias
export const DEFAULT_BELIEFS = MARKET_PROPOSITIONS;
