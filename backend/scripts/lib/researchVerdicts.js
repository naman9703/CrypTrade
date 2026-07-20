/**
 * Research verdict taxonomy — distinguish disproven, unsupported, untestable.
 */
export const VERDICT = {
  DISPROVEN: "disproven",
  UNSUPPORTED: "unsupported",
  UNTESTABLE: "untestable_with_current_data",
  PROMOTED: "promoted",
  INCONCLUSIVE: "inconclusive",
};

/**
 * Classify experiment outcome into governance verdict.
 */
export function classifyVerdict(exp, dataCapabilities = []) {
  if (exp.accepted === true) return VERDICT.PROMOTED;
  if (exp.requiredData && !dataCapabilities.includes(exp.requiredData)) {
    return VERDICT.UNTESTABLE;
  }
  if (exp.n != null && exp.n < 100) return VERDICT.UNSUPPORTED;
  if (exp.accepted === false && exp.fdrSignificant === false && (exp.n ?? 0) >= 200) {
    return VERDICT.DISPROVEN;
  }
  if (exp.accepted === false) return VERDICT.DISPROVEN;
  return VERDICT.INCONCLUSIVE;
}

export function verdictLabel(v) {
  const labels = {
    [VERDICT.DISPROVEN]: "Disproven — hypothesis rejected with available data",
    [VERDICT.UNSUPPORTED]: "Unsupported — insufficient evidence to conclude",
    [VERDICT.UNTESTABLE]: "Untestable — requires data not currently available",
    [VERDICT.PROMOTED]: "Promoted — survives evidence gates",
    [VERDICT.INCONCLUSIVE]: "Inconclusive — more research needed",
  };
  return labels[v] ?? v;
}
