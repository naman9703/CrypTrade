/**
 * Negative results registry — prevent revisiting disproven hypotheses.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, "negative-results.json");

export function loadNegativeResults() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { results: [], updatedAt: null };
  }
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
}

export function saveNegativeResults(data) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2));
}

function inferFailureConditions(exp) {
  const conditions = [];

  if (exp.slices?.regime?.slices) {
    const regimes = Object.entries(exp.slices.regime.slices);
    const failed = regimes.filter(([, s]) => (s.monotonicity ?? 0) <= 0 || (s.spread ?? 0) < 0.1);
    const passed = regimes.filter(([, s]) => (s.monotonicity ?? 0) > 0 && (s.spread ?? 0) >= 0.1);
    if (failed.length && passed.length) {
      conditions.push(`Mixed across regimes — failed in ${failed.map(([r]) => r).join(", ")}`);
    } else if (failed.length === regimes.length) {
      conditions.push(`Failed in all regimes (${failed.map(([r]) => r).join(", ")})`);
    }
  }

  if (exp.slices?.coin?.slices) {
    const coins = Object.entries(exp.slices.coin.slices);
    const positive = coins.filter(([, s]) => (s.monotonicity ?? 0) > 0 && (s.spread ?? 0) > 0);
    const negative = coins.filter(([, s]) => (s.monotonicity ?? 0) <= 0);
    if (positive.length === 1 && coins.length > 2) {
      conditions.push(`Stable only on ${positive.map(([c]) => c).join(", ")}`);
    }
    if (negative.length > positive.length) {
      conditions.push(`Unstable across assets — negative on ${negative.map(([c]) => c).join(", ")}`);
    }
  }

  if (exp.fdrSignificant === false) conditions.push("Lost significance after FDR correction");
  if (String(exp.result ?? "").includes("WF-mixed")) conditions.push("Walk-forward inconsistent across folds");
  if (exp.holdout?.monotonicity != null && exp.holdout.monotonicity <= 0) {
    conditions.push("Holdout monotonicity negative");
  }

  return conditions;
}

/**
 * Sync from experiment results — rejected hypotheses with reasons and failure conditions.
 */
export function syncFromExperiments(experimentResults) {
  const existing = loadNegativeResults();
  const byId = new Map(existing.results.map((r) => [r.id, r]));

  for (const exp of experimentResults) {
    if (exp.accepted === true) continue;
    const whyRejected = [];
    if (String(exp.result ?? "").includes("WF-mixed")) whyRejected.push("walk_forward_inconsistent");
    if (String(exp.result ?? "").includes("coin-weak")) whyRejected.push("unstable_across_asset_groups");
    if (exp.fdrSignificant === false) whyRejected.push("fdr_not_significant");
    if (exp.promotion?.failed?.length) whyRejected.push(...exp.promotion.failed);
    if (exp.accepted === false && !whyRejected.length) whyRejected.push("failed_promotion_criteria");

    const failureConditions = inferFailureConditions(exp);

    byId.set(exp.id, {
      id: exp.id,
      hypothesis: exp.hypothesis,
      whyRejected: whyRejected.length ? whyRejected : ["insufficient_evidence"],
      failureConditions: failureConditions.length ? failureConditions : ["No specific condition identified"],
      result: exp.result,
      accepted: exp.accepted,
      recordedAt: new Date().toISOString(),
      doNotRevisitUntil: "new_data_regime_or_formulation_change",
    });
  }

  const results = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  saveNegativeResults({ results });
  return results;
}

export function negativeResultsToMarkdown(results) {
  const lines = [
    "# Negative Results Registry",
    "",
    "Do not unknowingly revisit thoroughly disproven hypotheses.",
    "",
    "| ID | Hypothesis | Why Rejected | Failure Conditions |",
    "|----|------------|--------------|-------------------|",
  ];
  for (const r of results) {
    lines.push(
      `| ${r.id} | ${(r.hypothesis ?? "").slice(0, 50)}… | ${r.whyRejected.join(", ")} | ${(r.failureConditions ?? []).join("; ")} |`,
    );
  }
  return lines.join("\n");
}
