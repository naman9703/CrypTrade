/**
 * UI semantics for intraday gate checkboxes — mirrors backend `resolveIntradayGates`.
 * Legacy gates default ON (`!== false`); institutional S/R and SMC/ICT default OFF (`=== true`).
 */

export const INTRADAY_LEGACY_GATE_KEYS = [
  "intradayGateLiquidity",
  "intradayGateSession",
  "intradayGateFib",
  "intradayGateVp",
  "intradayGateOrderFlow",
  "intradayGateHtfRegime",
] as const;

export const INTRADAY_OPT_IN_GATE_KEYS = ["intradayGateInstitutionalSr", "intradayGateSmcIct"] as const;

export type IntradayLegacyGateKey = (typeof INTRADAY_LEGACY_GATE_KEYS)[number];
export type IntradayOptInGateKey = (typeof INTRADAY_OPT_IN_GATE_KEYS)[number];
export type IntradayGateUiKey = IntradayLegacyGateKey | IntradayOptInGateKey;

/** Effective enabled state for a gate checkbox. */
export function isIntradayGateChecked(
  bot: Record<string, unknown> | null | undefined,
  key: IntradayGateUiKey,
): boolean {
  if (!bot) return key === "intradayGateInstitutionalSr" || key === "intradayGateSmcIct" ? false : true;
  if (key === "intradayGateInstitutionalSr") {
    return bot.intradayGateInstitutionalSr === true || bot.intradaySrAPlusMode === true;
  }
  if (key === "intradayGateSmcIct") {
    return bot.intradayGateSmcIct === true || bot.intradaySmcIctMode === true;
  }
  return bot[key] !== false;
}

/** Patch to apply when toggling a gate checkbox. */
export function intradayGateTogglePatch(key: IntradayGateUiKey, on: boolean): Record<string, boolean> {
  if (key === "intradayGateSmcIct") {
    if (on) {
      return {
        intradayGateSmcIct: true,
        intradaySmcIctMode: true,
        intradayGateLiquidity: false,
        intradayGateSession: false,
        intradayGateFib: false,
        intradayGateVp: false,
        intradayGateOrderFlow: false,
        intradayGateHtfRegime: false,
        intradayGateInstitutionalSr: false,
        intradaySrAPlusMode: false,
      };
    }
    return { intradayGateSmcIct: false, intradaySmcIctMode: false };
  }
  if (key === "intradayGateInstitutionalSr") {
    return { intradayGateInstitutionalSr: on, intradaySrAPlusMode: on };
  }
  return { [key]: on };
}

/**
 * Canonical gate booleans on a bot record (WS merge + dirty compare).
 * Keeps paired SMC / institutional flags consistent so checkboxes do not flicker.
 */
export function normalizeIntradayGatesOnBot(bot: Record<string, unknown>): Record<string, unknown> {
  const out = { ...bot };
  for (const k of INTRADAY_LEGACY_GATE_KEYS) {
    out[k] = out[k] !== false;
  }
  const profile = String(out.intradaySmcIctProfile ?? "sweep").toLowerCase();
  const full = profile === "full" || profile === "ict2022";
  const balanced = profile === "balanced" || profile === "daily";
  out.intradaySmcIctProfile = full
    ? "full"
    : balanced
      ? "balanced"
      : profile === "sweep" || profile === "lite"
        ? "sweep"
        : profile;
  out.intradaySmcRequireMss = out.intradaySmcRequireMss === true;
  out.intradaySmcRequireRetrace = out.intradaySmcRequireRetrace === true;
  out.intradaySmcRequireChoch = out.intradaySmcRequireChoch === true;
  out.intradaySmcRequireBos = out.intradaySmcRequireBos === true;
  out.intradaySmcRequireConfirm = out.intradaySmcRequireConfirm === true;
  out.intradaySmcRequireFvgRetrace = out.intradaySmcRequireFvgRetrace === true;
  out.intradayGateInstitutionalSr =
    out.intradayGateInstitutionalSr === true || out.intradaySrAPlusMode === true;
  out.intradayGateSmcIct = out.intradayGateSmcIct === true || out.intradaySmcIctMode === true;
  out.intradaySmcIctMode = out.intradayGateSmcIct === true;
  return out;
}

/** Read SMC/ICT sub-options from bot with backend-aligned defaults. */
export function readIntradaySmcCfg(bot: Record<string, unknown> | null | undefined) {
  return {
    intradaySmcIctProfile: String(bot?.intradaySmcIctProfile ?? "sweep"),
    intradaySmcPickMode: String(bot?.intradaySmcPickMode ?? "per_signal"),
    intradaySmcKillzoneMode: String(bot?.intradaySmcKillzoneMode ?? "LONDON_NY"),
    intradaySmcEntryZoneMode: String(bot?.intradaySmcEntryZoneMode ?? "EITHER"),
    intradaySmcHtfStrictness: String(bot?.intradaySmcHtfStrictness ?? "either"),
    intradaySmcHtfBiasMode: String(bot?.intradaySmcHtfBiasMode ?? "parallel"),
    intradaySmcMinAdx: Number(bot?.intradaySmcMinAdx ?? 15),
    intradaySmcMinRr: Number(bot?.intradaySmcMinRr ?? 1.5),
    intradaySmcSlMode: String(bot?.intradaySmcSlMode ?? "structure"),
    intradaySmcMaxTpRr: Number(bot?.intradaySmcMaxTpRr ?? 3),
    intradaySmcMaxHoldBars: Number(bot?.intradaySmcMaxHoldBars ?? 48),
    intradaySmcRequireMss: bot?.intradaySmcRequireMss === true,
    intradaySmcRequireRetrace: bot?.intradaySmcRequireRetrace === true,
    intradaySmcRequireHtfBias: bot?.intradaySmcRequireHtfBias !== false,
    intradaySmcRequireChoch: bot?.intradaySmcRequireChoch === true,
    intradaySmcRequireBos: bot?.intradaySmcRequireBos === true,
    intradaySmcRequireConfirm: bot?.intradaySmcRequireConfirm === true,
    intradaySmcRequireFvgRetrace: bot?.intradaySmcRequireFvgRetrace === true,
    intradaySmcRequirePremiumDiscount: bot?.intradaySmcRequirePremiumDiscount === true,
    intradaySmcPremiumDiscountOte: bot?.intradaySmcPremiumDiscountOte === true,
  };
}
