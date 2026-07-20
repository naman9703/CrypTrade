/**
 * Decision policy — choose candidates by expected utility, not heuristic score.
 * Replaces the day-picker with a principled decision rule.
 */
import { num } from "./liqResearchStats.js";

/**
 * Per day-side group, apply decision policy.
 * @param {object[]} candidates — with expectedUtility from estimator
 */
export function applyDecisionPolicy(candidates, policy = "max_expected_utility") {
  const byDaySide = new Map();
  for (const c of candidates) {
    const key = `${c.symbol}|${c.dayId}|${c.side}`;
    if (!byDaySide.has(key)) byDaySide.set(key, []);
    byDaySide.get(key).push(c);
  }

  const selected = new Set();
  for (const list of byDaySide.values()) {
    let pick = null;
    if (policy === "max_expected_utility") {
      pick = [...list].sort((a, b) => num(b.expectedUtility) - num(a.expectedUtility))[0];
    } else if (policy === "max_score") {
      pick = [...list].sort(
        (a, b) => num(b.weightedQuality ?? b.scoreV2_total) - num(a.weightedQuality ?? a.scoreV2_total),
      )[0];
    } else if (policy === "max_expected_r") {
      pick = [...list].sort((a, b) => num(b.expectedR) - num(a.expectedR))[0];
    } else if (policy === "max_distributional_utility") {
      pick = [...list].sort((a, b) => num(b.expectedUtility) - num(a.expectedUtility))[0];
    }
    if (pick?.candidateKey) selected.add(pick.candidateKey);
  }

  return candidates.map((c) => ({
    ...c,
    selectedByPolicy: selected.has(c.candidateKey) ? 1 : 0,
    policy,
  }));
}

/**
 * Compare policies on multi-candidate days.
 */
export function compareDecisionPolicies(candidatesWithEstimates, outcome = "fwd_closeR_20", opts = {}) {
  const policies = opts.policies ?? ["max_score", "max_expected_r", "max_distributional_utility"];
  const results = {};

  for (const policy of policies) {
    const tagged = applyDecisionPolicy(
      candidatesWithEstimates.map((c) => ({ ...c, candidateKey: c.candidateKey ?? `${c.entryTs}|${c.side}` })),
      policy,
    );
    const picked = tagged.filter((c) => c.selectedByPolicy === 1);
    const actuals = picked.map((c) => num(c[outcome] ?? c.actualR)).filter((v) => v != null);
    results[policy] = {
      n: picked.length,
      avgOutcome: actuals.length ? actuals.reduce((a, b) => a + b, 0) / actuals.length : null,
    };
  }

  const oracle = [];
  const byDay = new Map();
  for (const c of candidatesWithEstimates) {
    const key = `${c.symbol}|${c.dayId}|${c.side}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(c);
  }
  for (const list of byDay.values()) {
    if (list.length < 2) continue;
    const best = [...list].sort((a, b) => num(b[outcome] ?? b.actualR) - num(a[outcome] ?? a.actualR))[0];
    oracle.push(num(best[outcome] ?? best.actualR));
  }

  results.oracle = {
    n: oracle.length,
    avgOutcome: oracle.length ? oracle.reduce((a, b) => a + b, 0) / oracle.length : null,
  };

  return results;
}

/**
 * Oracle predictability — can estimated E[R] rank the oracle candidate?
 */
export function oraclePredictability(multiDayGroups, outcome = "fwd_closeR_20", pickBy = "expectedUtility") {
  let correctTop = 0;
  let total = 0;
  const rankErrors = [];

  for (const list of multiDayGroups) {
    if (list.length < 2) continue;
    total++;
    const oracle = [...list].sort((a, b) => num(b[outcome] ?? b.actualR) - num(a[outcome] ?? a.actualR))[0];
    const byEst = [...list].sort((a, b) => num(b[pickBy]) - num(a[pickBy]))[0];
    if (oracle.candidateKey === byEst.candidateKey) correctTop++;
    const oracleR = num(oracle[outcome] ?? oracle.actualR);
    const estR = num(byEst[pickBy]);
    if (oracleR != null && estR != null) rankErrors.push(Math.abs(oracleR - estR));
  }

  return {
    multiCandidateDays: total,
    oraclePredictedCorrectly: correctTop,
    oraclePredictPct: total ? (correctTop / total) * 100 : 0,
    avgRankError: rankErrors.length ? rankErrors.reduce((a, b) => a + b, 0) / rankErrors.length : null,
    pickBy,
    researchQuestion: "Why are we failing to distinguish the Oracle candidate?",
  };
}
