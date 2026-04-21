/**
 * UI labels for persisted snapshots (schema v1 used ALLOW+engine_disabled; v2 uses BYPASS).
 */

export function displayMarketDecisionVerdict(mds: Record<string, unknown> | null | undefined): string | null {
  if (!mds) return null;
  const v = typeof mds.verdict === "string" ? mds.verdict : null;
  const fs = mds.failedStage != null ? String(mds.failedStage) : "";
  if (v === "ALLOW" && fs === "engine_disabled") return "BYPASS";
  return v;
}

export function mdEngineIsBypass(mds: Record<string, unknown> | null | undefined): boolean {
  const d = displayMarketDecisionVerdict(mds);
  return d === "BYPASS";
}
