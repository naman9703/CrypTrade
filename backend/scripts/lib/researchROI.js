/**
 * Research Return on Investment (RROI) — platform KPI, not trading CAGR.
 */
export function computeRROI(quarterMetrics = {}) {
  const {
    hypothesesTested = 0,
    hypothesesRejected = 0,
    hypothesesPromoted = 0,
    uncertaintyReduction = 0,
    holdoutDecisionQualityDelta = 0,
    engineeringDays = 1,
    computeCost = "medium",
  } = quarterMetrics;

  const computeMultiplier = { low: 1, medium: 2, high: 4 }[computeCost] ?? 2;
  const effort = Math.max(1, engineeringDays * computeMultiplier);

  const informationGain =
    hypothesesRejected * 0.3 +
    hypothesesPromoted * 1.0 +
    uncertaintyReduction * 2.0 +
    Math.max(0, holdoutDecisionQualityDelta) * 5.0;

  const rroi = informationGain / effort;

  return {
    period: quarterMetrics.period ?? "current",
    hypothesesTested,
    hypothesesRejected,
    hypothesesPromoted,
    uncertaintyReduction,
    holdoutDecisionQualityDelta,
    engineeringDays,
    computeCost,
    informationGain: Number(informationGain.toFixed(3)),
    rroi: Number(rroi.toFixed(3)),
    interpretation:
      rroi > 0.5
        ? "High research productivity — platform learning efficiently"
        : rroi > 0.2
          ? "Moderate — rejections and uncertainty reduction contributing"
          : "Low — review whether effort matches information gain",
    note: "RROI measures platform learning, not trading returns.",
  };
}

export function rroiToMarkdown(rroi) {
  return [
    "# Research Return on Investment (RROI)",
    "",
    "Platform KPI — not CAGR, Sharpe, or oracle predictability.",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Hypotheses tested | ${rroi.hypothesesTested} |`,
    `| Rejected with confidence | ${rroi.hypothesesRejected} |`,
    `| Promoted | ${rroi.hypothesesPromoted} |`,
    `| Uncertainty reduction | ${rroi.uncertaintyReduction} |`,
    `| Holdout decision quality Δ | ${rroi.holdoutDecisionQualityDelta} |`,
    `| Engineering days | ${rroi.engineeringDays} |`,
    `| **RROI** | **${rroi.rroi}** |`,
    "",
    rroi.interpretation,
    "",
    `> ${rroi.note}`,
  ].join("\n");
}
