/**
 * UI labels for persisted snapshots. Verdict is stored as ALLOW / BLOCK / WAIT / BYPASS (legacy).
 * When the master switch is off, {@link MarketDecisionSnapshot.engineDisabled} is true and verdict
 * is still the hypothetical outcome (not BYPASS).
 */

export function displayMarketDecisionVerdict(mds: Record<string, unknown> | null | undefined): string | null {
  if (!mds) return null;
  const v = typeof mds.verdict === "string" ? mds.verdict : null;
  return v;
}

/** True when the displayed verdict is legacy BYPASS (warm-up / old snapshots), not "engine off + real verdict". */
export function mdEngineIsBypass(mds: Record<string, unknown> | null | undefined): boolean {
  if (!mds) return false;
  if (mds.engineDisabled === true) return false;
  return displayMarketDecisionVerdict(mds) === "BYPASS";
}

/** Master switch off or legacy BYPASS — filters are not applied to trading, but you may still read the verdict. */
export function mdEnforcementOff(mds: Record<string, unknown> | null | undefined): boolean {
  if (!mds) return false;
  if (mds.engineDisabled === true) return true;
  const v = typeof mds.verdict === "string" ? mds.verdict : "";
  if (v === "BYPASS") return true;
  const fs = mds.failedStage != null ? String(mds.failedStage) : "";
  if (v === "ALLOW" && fs === "engine_disabled") return true;
  return false;
}
