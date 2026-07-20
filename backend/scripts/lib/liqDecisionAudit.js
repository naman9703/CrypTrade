/**
 * Decision audit — evaluate day-picker policy independently from entry logic.
 * Counterfactual: "if we had selected differently, what would have happened?"
 */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mean(arr) {
  const xs = arr.filter((v) => v != null && Number.isFinite(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

const DEFAULT_OUTCOME = "fwd_closeR_20";

/**
 * Group candidates into day-side decision units.
 */
export function groupDecisionDays(candidates, outcome = DEFAULT_OUTCOME) {
  const groups = new Map();
  for (const c of candidates) {
    const key = `${c.symbol}|${c.dayId}|${c.side}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...c, _outcome: num(c[outcome]) });
  }
  return [...groups.entries()].map(([key, list]) => {
    const [symbol, dayId, side] = key.split("|");
    const picked = list.filter((c) => Number(c.selectedByDayPicker) === 1);
    const rejected = list.filter((c) => Number(c.selectedByDayPicker) !== 1);
    return { key, symbol, dayId: Number(dayId), side, all: list, picked, rejected, n: list.length };
  });
}

/**
 * Per decision-day audit with counterfactuals.
 */
export function auditDecisionDay(group, outcome = DEFAULT_OUTCOME) {
  const withOutcome = group.all.filter((c) => num(c[outcome]) != null);
  if (!withOutcome.length) return null;

  const byScore = [...withOutcome].sort(
    (a, b) => Number(b.weightedQuality ?? b.entryContextScore ?? 0) - Number(a.weightedQuality ?? a.entryContextScore ?? 0),
  );
  const byOutcome = [...withOutcome].sort((a, b) => num(b[outcome]) - num(a[outcome]));
  const byTime = [...withOutcome].sort((a, b) => Number(a.entryTs) - Number(b.entryTs));

  const actual = group.picked[0] ?? null;
  const oracle = byOutcome[0];
  const scorePick = byScore[0];
  const earliest = byTime[0];
  const latest = byTime[byTime.length - 1];

  const actualR = actual ? num(actual[outcome]) : null;
  const oracleR = num(oracle[outcome]);
  const scoreR = num(scorePick[outcome]);
  const earliestR = num(earliest[outcome]);
  const latestR = num(latest[outcome]);

  const rejectedBetter =
    group.rejected.length > 0 &&
    actualR != null &&
    group.rejected.some((c) => num(c[outcome]) > actualR);

  return {
    symbol: group.symbol,
    dayId: group.dayId,
    side: group.side,
    candidateCount: group.n,
    actualR,
    oracleR,
    scorePickR: scoreR,
    earliestR,
    latestR,
    oracleGap: actualR != null && oracleR != null ? oracleR - actualR : null,
    scoreVsOracle: scoreR != null && oracleR != null ? scoreR - oracleR : null,
    actualVsLatest: actualR != null && latestR != null ? actualR - latestR : null,
    rejectedBetter,
    pickerMatchedScore: actual?.candidateKey === scorePick?.candidateKey,
    pickerMatchedOracle: actual?.candidateKey === oracle?.candidateKey,
    pickerMatchedLatest: actual?.candidateKey === latest?.candidateKey,
    avgRejectedR: mean(group.rejected.map((c) => num(c[outcome]))),
    avgPickedR: actualR,
  };
}

/**
 * Full decision audit summary.
 */
export function runDecisionAudit(candidates, outcome = DEFAULT_OUTCOME) {
  const days = groupDecisionDays(candidates, outcome);
  const multi = days.filter((d) => d.n > 1);
  const audits = multi.map((d) => auditDecisionDay(d, outcome)).filter(Boolean);

  const oracleGaps = audits.map((a) => a.oracleGap).filter((v) => v != null);
  const scoreVsOracle = audits.map((a) => a.scoreVsOracle).filter((v) => v != null);
  const rejectedBetterDays = audits.filter((a) => a.rejectedBetter).length;

  const picked = candidates.filter((c) => Number(c.selectedByDayPicker) === 1);
  const rejected = candidates.filter((c) => Number(c.selectedByDayPicker) !== 1);

  return {
    outcome,
    totalCandidates: candidates.length,
    decisionDays: days.length,
    multiCandidateDays: multi.length,
    audits,
    summary: {
      avgOracleGap: mean(oracleGaps),
      avgScoreVsOracle: mean(scoreVsOracle),
      pctDaysRejectedBetter: multi.length ? (rejectedBetterDays / multi.length) * 100 : 0,
      pickerMatchedOraclePct: audits.length
        ? (audits.filter((a) => a.pickerMatchedOracle).length / audits.length) * 100
        : 0,
      pickerMatchedScorePct: audits.length
        ? (audits.filter((a) => a.pickerMatchedScore).length / audits.length) * 100
        : 0,
      pickerMatchedLatestPct: audits.length
        ? (audits.filter((a) => a.pickerMatchedLatest).length / audits.length) * 100
        : 0,
      avgPickedOutcome: mean(picked.map((c) => num(c[outcome]))),
      avgRejectedOutcome: mean(rejected.map((c) => num(c[outcome]))),
      pickedMinusRejected: mean(picked.map((c) => num(c[outcome]))) - mean(rejected.map((c) => num(c[outcome]))),
      counterfactualOracleTotalR: mean(oracleGaps) * multi.length,
    },
    diagnosis: buildDiagnosis(audits, mean(picked.map((c) => num(c[outcome]))), mean(rejected.map((c) => num(c[outcome])))),
  };
}

function buildDiagnosis(audits, avgPicked, avgRejected) {
  const hints = [];
  if (avgRejected > avgPicked) {
    hints.push("picker_negative_evidence: rejected candidates outperform picked on average");
  }
  const latestWins = audits.filter((a) => a.pickerMatchedLatest && !a.pickerMatchedScore).length;
  if (latestWins > audits.length * 0.2) {
    hints.push("time_of_day: later setups may outperform score-ranked picks");
  }
  const scoreMissesOracle = audits.filter((a) => a.scoreVsOracle < -0.1).length;
  if (scoreMissesOracle > audits.length * 0.3) {
    hints.push("score_calibration: highest score ≠ highest forward outcome");
  }
  const oracleGap = mean(audits.map((a) => a.oracleGap).filter((v) => v != null));
  if (oracleGap > 0.2) {
    hints.push("opportunity_cost: meaningful R left on table vs oracle pick");
  }
  return hints.length ? hints : ["picker_neutral: no dominant failure mode detected"];
}

export function decisionAuditToMarkdown(report) {
  const s = report.summary;
  const lines = [
    "# LIQ Decision Audit",
    "",
    `Outcome: **${report.outcome}** | Candidates: ${report.totalCandidates} | Multi-candidate days: ${report.multiCandidateDays}`,
    "",
    "## Picker vs Alternatives",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Avg picked ${report.outcome} | ${fmt(s.avgPickedOutcome)} |`,
    `| Avg rejected ${report.outcome} | ${fmt(s.avgRejectedOutcome)} |`,
    `| Picked − Rejected | ${fmt(s.pickedMinusRejected)} |`,
    `| % days rejected beat pick | ${fmt(s.pctDaysRejectedBetter)}% |`,
    `| Avg oracle gap (best − actual) | ${fmt(s.avgOracleGap)}R |`,
    `| Picker matched oracle | ${fmt(s.pickerMatchedOraclePct)}% |`,
    `| Picker matched highest score | ${fmt(s.pickerMatchedScorePct)}% |`,
    `| Picker matched latest setup | ${fmt(s.pickerMatchedLatestPct)}% |`,
    "",
    "## Diagnosis",
    "",
    ...report.diagnosis.map((d) => `- ${d}`),
    "",
    "## Interpretation",
    "",
    "Do not redesign the picker until the failure mode is identified.",
    "Oracle gap = counterfactual upside if best forward-outcome candidate had been chosen.",
  ];
  return lines.join("\n");
}

function fmt(v) {
  return v == null ? "—" : Number(v).toFixed(3);
}
