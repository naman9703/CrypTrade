import { applySmcEngineExclusivity } from "./intradayGates.js";

/**
 * Bot keys mirrored from the Trading Panel intraday / SMC section into backtest snapshots.
 */

export const INTRADAY_PANEL_OVERRIDE_KEYS = [
  "intradayGateLiquidity",
  "intradayGateSession",
  "intradayGateFib",
  "intradayGateVp",
  "intradayGateOrderFlow",
  "intradayOfKillzoneMode",
  "intradayOfRequireKeyLevel",
  "intradayOfRequireConfirmation",
  "intradayOfMinStackBars",
  "intradayOfMinConfluence",
  "intradayOfUseOrderBook",
  "intradayOfAllowProxy",
  "intradayOfLevelProximityPct",
  "intradayOfDivergenceLookback",
  "intradayOfAbsorptionVolMult",
  "intradayOfAbsorptionRangeAtrMult",
  "intradayOfStackDeltaRatio",
  "intradayOfBookImbalanceMin",
  "intradayOfSoloMinScore",
  "intradayOfVetoMode",
  "intradayOfMinPartialScore",
  "intradayOfConfluenceMode",
  "intradayOfAllowCvdOnly",
  "intradayOfRequirePremiumDiscount",
  "intradayOfTp1Enabled",
  "intradayOfTp2Enabled",
  "intradayOfPartialFrac",
  "intradayOfMinRr",
  "intradayOfBreakevenAfterPartial",
  "intradayOfApproachLookback",
  "intradayOfEntryAtSignalClose",
  "intradayOfExitOnDeltaAgainst",
  "intradayOfExitGraceBars",
  "intradayOfExitMinDeltaRatio",
  "intradayOfMaxHoldBars",
  "intradaySmcUseOrderFlow",
  "intradayGateHtfRegime",
  "intradayGateInstitutionalSr",
  "intradayGateSmcIct",
  "intradaySmcIctMode",
  "intradaySmcMinScore",
  "intradaySmcIctProfile",
  "intradaySmcPickMode",
  "intradaySmcOneTradePerDay",
  "intradaySmcRequireMss",
  "intradaySmcRequireRetrace",
  "intradaySmcRequireChoch",
  "intradaySmcRequireBos",
  "intradaySmcRequireConfirm",
  "intradaySmcRequireFvgRetrace",
  "intradaySmcLookbackBars",
  "intradaySmcMinRr",
  "intradaySmcBosMaxBars",
  "intradaySmcChochMaxBars",
  "intradaySmcEntryZoneMode",
  "intradaySmcFvgEntryMode",
  "intradaySmcTp2Mode",
  "intradaySmcKillzoneMode",
  "intradaySmcMinAdx",
  "intradaySmcHtfStrictness",
  "intradaySmcHtfBiasMode",
  "intradaySmcRequireHtfBias",
  "intradaySmcRequirePremiumDiscount",
  "intradaySmcPremiumDiscountOte",
  "intradaySmcDealingRangeLookback",
  "intradaySmcOteMin",
  "intradaySmcOteMax",
  "intradaySmcPremiumDiscountTolPct",
  "intradaySrAPlusMode",
  "intradaySrMinVolRatio",
  "intradaySrMinHtfSep",
  "intradaySrZoneWidthPct",
  "intradaySrBosMaxBarsAfterReclaim",
  "intradaySrMinConfirmWick",
  "intradaySrRequireBos",
  "intradaySrRequireConfirm",
  "intradaySrRequireVolume",
  "intradaySrRequireHtfTrend",
  "intradaySmcSlMode",
  "intradaySmcMaxTpRr",
  "intradaySmcMaxHoldBars",
  "intradayLiqTp1Enabled",
  "intradayLiqTp2Enabled",
  "intradayLiqBreakevenAfterPartial",
  "intradayLiqPartialTp",
  "intradayLiqMinRr",
  "intradayLiqMaxHoldBars",
  "intradayLiqMaxTpRr",
  "intradayLiqMinSweepExtensionPct",
  // Regime-adaptive strategy + institutional risk overlay.
  "regimeAdaptiveEnableTrend",
  "regimeAdaptiveEnableRange",
  "regimeAdaptiveEnableBreakout",
  "regimeAdaptiveMinGrade",
  "regimeAdaptiveConfidenceFloor",
  "regimeAdaptiveMaxTradesPerDay",
  "regimeAdaptiveMinBarGap",
  "regimeAdaptiveKillzoneMode",
  "regimeAdaptiveTrendRR",
  "regimeAdaptiveRangeRR",
  "regimeAdaptiveBreakoutRR",
  "regimeAdaptiveAtrSlMult",
  "regimeAdaptiveTrendAdx",
  "regimeAdaptiveSqueezePctile",
  "regimeAdaptiveVolatileAtrPct",
  "situationMaxTradesPerDay",
  "situationMinBarGap",
  "situationMinScore",
  "situationMaxLossStreak",
  "situationMaxExhaustionPerDay",
  "situationExhaustionMinBarsFromOpen",
  "riskScale",
  "volTargetSizing",
  "volTargetAtrPct",
  "volTargetMaxMult",
  "volTargetMinMult",
  "riskKillSwitchDdPct",
  "riskConsecutiveLossLimit",
  "riskWeeklyMaxLossPct",
];

const LEGACY_GATE_KEYS = [
  "intradayGateLiquidity",
  "intradayGateSession",
  "intradayGateFib",
  "intradayGateVp",
  "intradayGateOrderFlow",
  "intradayGateHtfRegime",
];

/** Live/backtest overlay — copy panel keys as-is (no profile-derived forcing). */
export function pickRawIntradayPanelFromBot(bot = {}) {
  const out = {};
  const keys = [
    ...LEGACY_GATE_KEYS,
    ...INTRADAY_PANEL_OVERRIDE_KEYS,
    "intradaySrAPlusMode",
    "srIntradayMaxTradesPerDay",
    "srIntradayMinBarGap",
    "srIntradayMinScore",
    "intradayMinTechniqueCount",
    "intradayRequireSessionReclaim",
    "intradayRequireFibOrVp",
    "intradayLearnedRulesEnabled",
    "intradayLiqStrictMode",
    "intradayLiqSessionExtreme",
    "intradayLiqOnePickPerDay",
    "intradaySmcChochStrict",
    "intradaySmcRequireHtfBias",
  ];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(bot, key) && bot[key] !== undefined) {
      out[key] = bot[key];
    }
  }
  const smcOn = out.intradayGateSmcIct === true || out.intradaySmcIctMode === true;
  out.intradayGateSmcIct = smcOn;
  out.intradaySmcIctMode = smcOn;
  const instOn = out.intradayGateInstitutionalSr === true || out.intradaySrAPlusMode === true;
  out.intradayGateInstitutionalSr = instOn;
  out.intradaySrAPlusMode = instOn;
  return out;
}

/** `midpoint` | `ce` = FVG CE; `zone` = full-zone retrace (legacy). */
function normalizeSmcFvgEntryMode(raw) {
  const m = String(raw ?? "zone").toLowerCase();
  return m === "midpoint" || m === "ce" ? "midpoint" : "zone";
}

/** `internal` | `opposing` | `tiered` — frozen research uses internal swing TP2. */
function normalizeSmcTp2Mode(raw) {
  const m = String(raw ?? "opposing").toLowerCase();
  return m === "internal" || m === "tiered" ? m : "opposing";
}

/** When SMC/ICT keys are explicitly saved on the snapshot, do not re-derive from profile defaults. */
function smcExplicitBool(bot, key, derive) {
  if (Object.prototype.hasOwnProperty.call(bot, key) && bot[key] !== undefined) {
    return bot[key] === true;
  }
  return derive();
}

/** Canonical SMC/ICT checklist fields (always explicit booleans for cache + engine). */
export function materializeSmcIctOpts(bot = {}) {
  const smcOn = bot.intradayGateSmcIct === true || bot.intradaySmcIctMode === true;
  const profile = String(bot.intradaySmcIctProfile ?? "sweep").toLowerCase();
  const fullProfile = profile === "full" || profile === "ict2022";
  const balancedProfile = profile === "balanced" || profile === "daily";
  const requireRetrace = smcExplicitBool(bot, "intradaySmcRequireRetrace", () =>
    fullProfile || balancedProfile
      ? true
      : bot.intradaySmcRequireFvgRetrace === true,
  );
  const out = {
    intradayGateSmcIct: smcOn,
    intradaySmcIctMode: smcOn,
    intradaySmcIctProfile: fullProfile
      ? "full"
      : balancedProfile
        ? "balanced"
        : profile === "sweep" || profile === "lite"
          ? "sweep"
          : profile,
    intradaySmcPickMode: String(bot.intradaySmcPickMode ?? "per_signal").toLowerCase(),
    intradaySmcOneTradePerDay:
      bot.intradaySmcOneTradePerDay != null
        ? bot.intradaySmcOneTradePerDay === true
        : String(bot.intradaySmcPickMode ?? "per_signal").toLowerCase() !== "per_signal",
    intradaySmcRequireMss: smcExplicitBool(bot, "intradaySmcRequireMss", () =>
      fullProfile || balancedProfile ? true : false,
    ),
    intradaySmcRequireRetrace: requireRetrace,
    intradaySmcRequireChoch: smcExplicitBool(bot, "intradaySmcRequireChoch", () => fullProfile),
    intradaySmcRequireBos: smcExplicitBool(bot, "intradaySmcRequireBos", () => fullProfile),
    intradaySmcRequireConfirm: smcExplicitBool(bot, "intradaySmcRequireConfirm", () => false),
    intradaySmcRequireFvgRetrace: requireRetrace,
    intradaySmcRequirePremiumDiscount: smcExplicitBool(bot, "intradaySmcRequirePremiumDiscount", () =>
      fullProfile,
    ),
    intradaySmcPremiumDiscountOte: smcExplicitBool(bot, "intradaySmcPremiumDiscountOte", () => false),
    intradaySmcDealingRangeLookback: Math.max(
      10,
      Math.min(200, Math.round(Number(bot.intradaySmcDealingRangeLookback ?? 48))),
    ),
    intradaySmcLookbackBars: Math.max(3, Math.min(200, Math.round(Number(bot.intradaySmcLookbackBars ?? 30)))),
    intradaySmcKillzoneMode: Object.prototype.hasOwnProperty.call(bot, "intradaySmcKillzoneMode")
      ? String(bot.intradaySmcKillzoneMode).toUpperCase()
      : String("LONDON_NY").toUpperCase(),
    intradaySmcEntryZoneMode:
      bot.intradaySmcEntryZoneMode === "FVG" || bot.intradaySmcEntryZoneMode === "OB"
        ? bot.intradaySmcEntryZoneMode
        : "EITHER",
    intradaySmcFvgEntryMode: Object.prototype.hasOwnProperty.call(bot, "intradaySmcFvgEntryMode")
      ? normalizeSmcFvgEntryMode(bot.intradaySmcFvgEntryMode)
      : undefined,
    intradaySmcTp2Mode: Object.prototype.hasOwnProperty.call(bot, "intradaySmcTp2Mode")
      ? normalizeSmcTp2Mode(bot.intradaySmcTp2Mode)
      : undefined,
    intradaySmcBosMaxBars: Math.max(1, Math.min(20, Math.round(Number(bot.intradaySmcBosMaxBars ?? 5)))),
    intradaySmcChochMaxBars: Math.max(1, Math.min(20, Math.round(Number(bot.intradaySmcChochMaxBars ?? 8)))),
    intradaySmcMinAdx: Math.max(0, Math.min(100, Math.round(Number(bot.intradaySmcMinAdx ?? 18)))),
    intradaySmcHtfStrictness: Object.prototype.hasOwnProperty.call(bot, "intradaySmcHtfStrictness")
      ? String(bot.intradaySmcHtfStrictness).toLowerCase()
      : "either",
    intradaySmcHtfBiasMode: (() => {
      if (Object.prototype.hasOwnProperty.call(bot, "intradaySmcHtfBiasMode")) {
        const m = String(bot.intradaySmcHtfBiasMode).toLowerCase();
        return m === "ema" || m === "structure" ? m : "parallel";
      }
      return "parallel";
    })(),
    intradaySmcMinScore: Math.max(1, Math.min(20, Math.round(Number(bot.intradaySmcMinScore ?? 7)))),
    intradaySmcRequireHtfBias: bot.intradaySmcRequireHtfBias !== false,
    intradaySmcSlMode: bot.intradaySmcSlMode === "structure" ? "structure" : "sweep",
    intradaySmcMaxTpRr: Math.max(0, Math.min(20, Number(bot.intradaySmcMaxTpRr ?? 5))),
    intradaySmcMaxHoldBars: Math.max(0, Math.min(2000, Math.round(Number(bot.intradaySmcMaxHoldBars ?? 48)))),
  };
  if (bot.intradaySmcMinRr != null && Number.isFinite(Number(bot.intradaySmcMinRr))) {
    out.intradaySmcMinRr = Math.max(0, Number(bot.intradaySmcMinRr));
  }
  if (Object.prototype.hasOwnProperty.call(bot, "intradaySmcFvgEntryMode")) {
    out.intradaySmcFvgEntryMode = normalizeSmcFvgEntryMode(bot.intradaySmcFvgEntryMode);
  }
  if (Object.prototype.hasOwnProperty.call(bot, "intradaySmcTp2Mode")) {
    out.intradaySmcTp2Mode = normalizeSmcTp2Mode(bot.intradaySmcTp2Mode);
  }
  return out;
}

/**
 * Full intraday panel slice with explicit gate booleans (live bot or cfg snapshot).
 * @param {Record<string, unknown>} bot
 */
export function materializeIntradayPanelFromBot(bot = {}) {
  const base = applySmcEngineExclusivity(bot);
  const explicit = {};
  for (const key of LEGACY_GATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(base, key) && base[key] !== undefined) {
      explicit[key] = base[key] === true;
    }
  }
  for (const key of INTRADAY_PANEL_OVERRIDE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(base, key) && base[key] !== undefined) {
      explicit[key] = base[key];
    }
  }
  if (base.intradaySrAPlusMode != null) explicit.intradaySrAPlusMode = base.intradaySrAPlusMode === true;
  if (base.srIntradayMaxTradesPerDay != null) explicit.srIntradayMaxTradesPerDay = base.srIntradayMaxTradesPerDay;
  if (base.srIntradayMinBarGap != null) explicit.srIntradayMinBarGap = base.srIntradayMinBarGap;
  if (base.intradayLiqStrictMode != null) explicit.intradayLiqStrictMode = base.intradayLiqStrictMode;
  if (base.intradaySmcChochStrict != null) explicit.intradaySmcChochStrict = base.intradaySmcChochStrict;

  const out = { ...materializeSmcIctOpts({ ...base, ...explicit }), ...explicit };

  out.intradayGateInstitutionalSr =
    out.intradayGateInstitutionalSr === true || out.intradaySrAPlusMode === true;
  out.intradaySrAPlusMode = out.intradayGateInstitutionalSr;
  out.intradayGateSmcIct = out.intradayGateSmcIct === true || out.intradaySmcIctMode === true;
  out.intradaySmcIctMode = out.intradayGateSmcIct;
  return out;
}

/** @param {Record<string, unknown>} cfg */
export function materializeIntradayPanelOnCfg(cfg = {}) {
  return { ...cfg, ...materializeIntradayPanelFromBot(cfg) };
}

/** @deprecated use materializeIntradayPanelFromBot */
export function pickIntradayPanelOverlay(liveBot) {
  return materializeIntradayPanelFromBot(liveBot);
}
