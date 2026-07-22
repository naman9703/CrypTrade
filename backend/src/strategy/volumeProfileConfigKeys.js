/**
 * VOLUME_PROFILE signal-brain keys — must stay in sync across:
 * - strategySignalBrainKeys.js
 * - frontend strategyBrainSnapshot.ts
 * - bot.js applyVolumeProfilePatchToState / public snapshot
 * - http.js botConfig zod schema
 */

export const VOLUME_PROFILE_BOOL_KEYS = [
  "vpTierAOnly",
  "vpAllowHvnFlip",
  "vpRequireHtfAlign",
  "vpRegimeImmunity",
  "vpSellMacroAdapt",
  "vpBuyChaseFilter",
  "vpBuyChaseNonBullOnly",
  "vpValSellBearOnly",
  "vpValSellRequirePrior60dBear",
  "vpValSellBlockBull60",
  "vpValSellBlockBull60Dump",
  "vpValSellBlockBull60NonVac",
  "vpValSellBlockBull60Extending",
  "vpValSellBlockWeakBearVacuum",
  "vpValSellBlockWeakBearVacuumHighPrior60",
  "vpValSellBlockFlatPrior60",
  "vpValSellChaseFilter",
  "vpValSellBlockReliefBounce",
  "vpValSellRequireBearTrend",
  "vpBuyRejectionBlockBullTrend",
  "vpBuyRejectionBlockBullStructured",
  "vpBuyRejectionBlockUnpreparedMacro",
  "vpBuyRejectionBlockPrior120",
  "vpBuyBreakoutBlockBullTight",
  "vpBuyBreakoutBlockBullVacuum",
  "vpNoveltyEnabled",
  "vpPreparedRegimeOnly",
  "vpPreparedAllowlistOnly",
  "vpPreparedBlockVacuumVah",
  "vpPreparedBlockVacuumValBear",
  "vpRejectionDepthExtendedOnly",
  "vpRejectionSellBlockExtendedDown",
  "vpBuyBreakoutMaxPathNonBullOnly",
  "vpIncludePriorSession",
  "vpEnableNakedPoc",
  "vpBreakoutUsePriorSession",
  "vpHardBlockCeilingFloor",
  "vpStructureBrackets",
  "requireVpSetup",
];

export const VOLUME_PROFILE_NUMBER_KEYS = [
  "vpLookbackBars",
  "vpMinRR",
  "vpMinScore",
  "vpMinAdx",
  "vpMinHtfSepPct",
  "vpMinRunPct",
  "vpMinCloseBeyondPct",
  "vpMinBreakoutBody",
  "vpMinBreakoutCloseStrength",
  "vpBreakoutMinVolRatio",
  "vpValBreakdownMinVolRatio",
  "vpBreakoutMinPathPct",
  "vpLvnMinVolRatio",
  "vpLvnSizeMult",
  "vpMinWickRatio",
  "vpMaxTradesPerDay",
  "vpMinBarGap",
  "vpSessionStartHour",
  "vpSessionEndHour",
  "vpMaxSlPct",
  "vpMaxTpPct",
  "vpValueAreaPct",
  "vpCompositeDays",
  "vpBins",
  "vpMaxPriorTrendPct",
  "vpPriorTrendLookback",
  "vpBuyBreakoutMinHtfSep",
  "vpBuyRelaxedMinHtfSep",
  "vpBuyHighPathMinPct",
  "vpSellBreakdownMinHtfSep",
  "vpSellMinHtfSepPct",
  "vpSellMacroBullMinHtfSepPct",
  "vpSellMacroPrior20dBullPct",
  "vpSellNonBearMinHtfSepPct",
  "vpSellBearPrior60dPct",
  "vpValSellPrior60dBearPct",
  "vpValSellBull60Pct",
  "vpValSellBull60DumpPrior20dPct",
  "vpValSellBull60ExtendRatio",
  "vpValSellWeakBearVacPrior60Pct",
  "vpValSellFlatPrior60LoPct",
  "vpValSellFlatPrior60HiPct",
  "vpValSellChaseMaxPrior5dPct",
  "vpValSellReliefBounceMaxPct",
  "vpValSellReliefBounceMinPrior60dPct",
  "vpPreparedVacuumPathPct",
  "vpPreparedBearPrior60dPct",
  "vpSellWeakBearMinHtfSepPct",
  "vpSellWeakBearPrior20dFloorPct",
  "vpBuyChaseMaxPrior5dPct",
  "vpBuyChaseBullPrior60dPct",
  "vpVacuumPathPct",
  "vpVacuumRetestBars",
  "vpVacuumRetestTolPct",
  "vpVacuumRetestMaxTpPct",
  "vpMinBarVolRatio",
  "vpMinAtrPct",
  "vpMaxAtrPct",
  "vpNearTolPct",
  "vpRejectionMinVolRatio",
  "vpRejectionSpikePct",
  "vpRejectionMinWickRatio",
  "vpRejectionMinCloseDepth",
  "vpBuyRejectionMinCloseStrength",
  "vpBuyRejectionMinBody",
  "vpBuyRejectionPrior120Pct",
  "vpRejectionExtendedPriorPct",
  "vpRejectionPriorLookback",
  "vpBuyBreakoutMaxPathPct",
  "vpSellBreakdownMaxPathPct",
  "vpBuyVacuumBullPriorPct",
  "vpBuyVacuumPriorLookback",
  "vpBuyVacuumMaxPrior5dPct",
  "vpBuyVacuumPrior5dLookback",
  "vpOutsideVaLookback",
];

export const VOLUME_PROFILE_STRING_KEYS = [
  "vpProfileMode",
  "vpVolumeDistribute",
  "volumeProfileGateMode",
  "vpPlaybook",
  "vpVacuumEntryMode",
];

export const VOLUME_PROFILE_ARRAY_KEYS = [
  "vpAllowedSetups",
  "vpPreparedCellKeys",
  "vpPreparedBlockCellKeys",
];

/** All VP strategy knobs that must persist on VOLUME_PROFILE (and SR_INTRADAY overlays). */
export const VOLUME_PROFILE_CFG_KEYS = [
  ...VOLUME_PROFILE_BOOL_KEYS,
  ...VOLUME_PROFILE_NUMBER_KEYS,
  ...VOLUME_PROFILE_STRING_KEYS,
  ...VOLUME_PROFILE_ARRAY_KEYS,
];

const SETUP_ALLOW = new Set([
  "lvn_vacuum",
  "vah_breakout",
  "val_breakdown",
  "poc_bounce",
  "va_rejection",
  "naked_poc",
  "hvn_flip",
]);

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** Normalize a bot/src object into clamped VP public fields. */
export function volumeProfilePublicSnapshot(src = {}) {
  const out = {};
  for (const k of VOLUME_PROFILE_BOOL_KEYS) {
    if (src[k] !== undefined) out[k] = Boolean(src[k]);
  }
  if (src.vpLookbackBars != null && Number.isFinite(Number(src.vpLookbackBars))) {
    out.vpLookbackBars = clamp(Math.round(Number(src.vpLookbackBars)), 48, 2000);
  }
  if (src.vpMinRR != null && Number.isFinite(Number(src.vpMinRR))) {
    out.vpMinRR = clamp(Number(src.vpMinRR), 0.8, 5);
  }
  if (src.vpMinScore != null && Number.isFinite(Number(src.vpMinScore))) {
    out.vpMinScore = clamp(Math.round(Number(src.vpMinScore)), 0, 30);
  }
  if (src.vpMinAdx != null && Number.isFinite(Number(src.vpMinAdx))) {
    out.vpMinAdx = clamp(Number(src.vpMinAdx), 0, 100);
  }
  if (src.vpMinHtfSepPct != null && Number.isFinite(Number(src.vpMinHtfSepPct))) {
    out.vpMinHtfSepPct = clamp(Number(src.vpMinHtfSepPct), 0, 0.05);
  }
  if (src.vpMinRunPct != null && Number.isFinite(Number(src.vpMinRunPct))) {
    out.vpMinRunPct = clamp(Number(src.vpMinRunPct), 0, 0.1);
  }
  if (src.vpMinCloseBeyondPct != null && Number.isFinite(Number(src.vpMinCloseBeyondPct))) {
    out.vpMinCloseBeyondPct = clamp(Number(src.vpMinCloseBeyondPct), 0, 0.05);
  }
  if (src.vpMinBreakoutBody != null && Number.isFinite(Number(src.vpMinBreakoutBody))) {
    out.vpMinBreakoutBody = clamp(Number(src.vpMinBreakoutBody), 0, 1);
  }
  if (src.vpMinBreakoutCloseStrength != null && Number.isFinite(Number(src.vpMinBreakoutCloseStrength))) {
    out.vpMinBreakoutCloseStrength = clamp(Number(src.vpMinBreakoutCloseStrength), 0, 1);
  }
  if (src.vpBreakoutMinVolRatio != null && Number.isFinite(Number(src.vpBreakoutMinVolRatio))) {
    out.vpBreakoutMinVolRatio = clamp(Number(src.vpBreakoutMinVolRatio), 0, 10);
  }
  if (src.vpValBreakdownMinVolRatio != null && Number.isFinite(Number(src.vpValBreakdownMinVolRatio))) {
    out.vpValBreakdownMinVolRatio = clamp(Number(src.vpValBreakdownMinVolRatio), 0, 10);
  }
  if (src.vpBreakoutMinPathPct != null && Number.isFinite(Number(src.vpBreakoutMinPathPct))) {
    out.vpBreakoutMinPathPct = clamp(Number(src.vpBreakoutMinPathPct), 0, 0.1);
  }
  if (src.vpLvnMinVolRatio != null && Number.isFinite(Number(src.vpLvnMinVolRatio))) {
    out.vpLvnMinVolRatio = clamp(Number(src.vpLvnMinVolRatio), 0, 10);
  }
  if (src.vpLvnSizeMult != null && Number.isFinite(Number(src.vpLvnSizeMult))) {
    out.vpLvnSizeMult = clamp(Number(src.vpLvnSizeMult), 0.5, 5);
  }
  if (src.vpMinWickRatio != null && Number.isFinite(Number(src.vpMinWickRatio))) {
    out.vpMinWickRatio = clamp(Number(src.vpMinWickRatio), 0, 1);
  }
  if (src.vpMaxTradesPerDay != null && Number.isFinite(Number(src.vpMaxTradesPerDay))) {
    out.vpMaxTradesPerDay = clamp(Math.round(Number(src.vpMaxTradesPerDay)), 1, 20);
  }
  if (src.vpMinBarGap != null && Number.isFinite(Number(src.vpMinBarGap))) {
    out.vpMinBarGap = clamp(Math.round(Number(src.vpMinBarGap)), 0, 200);
  }
  if (src.vpSessionStartHour != null && Number.isFinite(Number(src.vpSessionStartHour))) {
    out.vpSessionStartHour = clamp(Math.round(Number(src.vpSessionStartHour)), 0, 23);
  }
  if (src.vpSessionEndHour != null && Number.isFinite(Number(src.vpSessionEndHour))) {
    out.vpSessionEndHour = clamp(Math.round(Number(src.vpSessionEndHour)), 0, 24);
  }
  if (src.vpMaxSlPct != null && Number.isFinite(Number(src.vpMaxSlPct))) {
    out.vpMaxSlPct = clamp(Number(src.vpMaxSlPct), 0.001, 0.05);
  }
  if (src.vpMaxTpPct != null && Number.isFinite(Number(src.vpMaxTpPct))) {
    out.vpMaxTpPct = clamp(Number(src.vpMaxTpPct), 0.001, 0.1);
  }
  if (src.vpValueAreaPct != null && Number.isFinite(Number(src.vpValueAreaPct))) {
    out.vpValueAreaPct = clamp(Number(src.vpValueAreaPct), 0.5, 0.95);
  }
  if (src.vpCompositeDays != null && Number.isFinite(Number(src.vpCompositeDays))) {
    out.vpCompositeDays = clamp(Math.round(Number(src.vpCompositeDays)), 1, 30);
  }
  if (src.vpBins != null && Number.isFinite(Number(src.vpBins))) {
    out.vpBins = clamp(Math.round(Number(src.vpBins)), 10, 200);
  }
  if (src.vpMaxPriorTrendPct != null && Number.isFinite(Number(src.vpMaxPriorTrendPct))) {
    out.vpMaxPriorTrendPct = clamp(Number(src.vpMaxPriorTrendPct), 0, 0.1);
  }
  if (src.vpPriorTrendLookback != null && Number.isFinite(Number(src.vpPriorTrendLookback))) {
    out.vpPriorTrendLookback = clamp(Math.round(Number(src.vpPriorTrendLookback)), 2, 100);
  }
  for (const k of [
    "vpBuyBreakoutMinHtfSep",
    "vpBuyRelaxedMinHtfSep",
    "vpBuyHighPathMinPct",
    "vpSellBreakdownMinHtfSep",
    "vpSellMinHtfSepPct",
    "vpSellMacroBullMinHtfSepPct",
    "vpSellMacroPrior20dBullPct",
    "vpBuyChaseMaxPrior5dPct",
    "vpMinBarVolRatio",
    "vpMinAtrPct",
    "vpMaxAtrPct",
    "vpNearTolPct",
    "vpRejectionMinVolRatio",
    "vpRejectionSpikePct",
    "vpRejectionMinWickRatio",
    "vpRejectionMinCloseDepth",
    "vpBuyBreakoutMaxPathPct",
    "vpSellBreakdownMaxPathPct",
  ]) {
    if (src[k] != null && Number.isFinite(Number(src[k]))) out[k] = Math.max(0, Number(src[k]));
  }
  if (src.vpOutsideVaLookback != null && Number.isFinite(Number(src.vpOutsideVaLookback))) {
    out.vpOutsideVaLookback = clamp(Math.round(Number(src.vpOutsideVaLookback)), 2, 48);
  }
  if (src.vpProfileMode != null) {
    const m = String(src.vpProfileMode).toLowerCase();
    if (["rolling", "session_utc", "composite_utc", "session", "composite"].includes(m)) {
      out.vpProfileMode = m;
    }
  }
  if (src.vpVolumeDistribute != null) {
    const d = String(src.vpVolumeDistribute).toLowerCase();
    if (["uniform", "close_weighted"].includes(d)) out.vpVolumeDistribute = d;
  }
  if (src.volumeProfileGateMode != null) {
    const g = String(src.volumeProfileGateMode).toLowerCase();
    if (["off", "soft", "strict"].includes(g)) out.volumeProfileGateMode = g;
  }
  if (src.vpPlaybook != null) {
    const p = String(src.vpPlaybook).toUpperCase();
    if (p === "FREQ" || p === "TIER_A" || p === "") out.vpPlaybook = p;
  }
  if (Array.isArray(src.vpAllowedSetups)) {
    out.vpAllowedSetups = src.vpAllowedSetups.map(String).filter((s) => SETUP_ALLOW.has(s));
  }
  if (Array.isArray(src.vpPreparedCellKeys)) {
    out.vpPreparedCellKeys = src.vpPreparedCellKeys.map(String).filter(Boolean);
  }
  if (Array.isArray(src.vpPreparedBlockCellKeys)) {
    out.vpPreparedBlockCellKeys = src.vpPreparedBlockCellKeys.map(String).filter(Boolean);
  }
  return out;
}

/** Apply patch → state (only known VP keys). */
export function applyVolumeProfilePatchToState(state, patch) {
  if (!patch || typeof patch !== "object") return;
  const merged = { ...volumeProfilePublicSnapshot(state), ...patch };
  Object.assign(state, volumeProfilePublicSnapshot(merged));
}
