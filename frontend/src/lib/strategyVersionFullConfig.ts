import type { StrategyVersion } from "../types/strategy";
import { pickBotFromStrategyVersion } from "./strategyVersionDisplay.ts";
import {
  filterBotForProfile,
  profileAllowsKey,
  profileHasUiSection,
} from "./strategyConfigProfile.ts";

export type StrategyConfigRow = { label: string; value: string; enabled?: boolean };
export type StrategyConfigSection = { title: string; rows: StrategyConfigRow[] };

function fmtVal(v: unknown): string {
  if (v == null || v === "") return "—";
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "—";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  return String(v);
}

function gateRow(label: string, on: boolean): StrategyConfigRow {
  return { label, value: on ? "On" : "Off", enabled: on };
}

function rowsFromKeys(bot: Record<string, unknown>, defs: { key: string; label: string }[]): StrategyConfigRow[] {
  return defs.map(({ key, label }) => gateRow(label, bot[key] === true));
}

const ENTRY_GATES: { key: string; label: string }[] = [
  { key: "intelligenceGateEnabled", label: "Intelligence gate" },
  { key: "intelligenceGateManualStrategies", label: "Intelligence (manual strategies)" },
  { key: "intelligenceGateStrict", label: "Intelligence strict" },
  { key: "intelligenceGateHighWinRate", label: "Intelligence high win-rate" },
  { key: "signalStrengthGatesTrades", label: "Signal strength gate" },
  { key: "supertrendMoveQualityGate", label: "Move quality gate" },
  { key: "supertrendBigMoveGateEnabled", label: "Big-move gate" },
  { key: "supertrendBreakoutConfirm", label: "Breakout confirm" },
  { key: "supertrendConfirmationGateEnabled", label: "ST confirmation gate" },
  { key: "supertrendHtf4hEnabled", label: "HTF 4H align gate" },
  { key: "supertrendFuturesAiConfidenceFilter", label: "Futures AI confidence filter" },
  { key: "surfPulseMlGateEnabled", label: "SurfPulse ML gate" },
  { key: "volumeProfileGatesEnabled", label: "Volume profile gates" },
  { key: "volumeProfileSoftGates", label: "Volume profile soft gates" },
];

const INTRADAY_GATES: { key: string; label: string }[] = [
  { key: "intradayGateLiquidity", label: "Liquidity" },
  { key: "intradayGateSession", label: "Session / killzone" },
  { key: "intradayGateFib", label: "Fibonacci" },
  { key: "intradayGateVp", label: "Volume profile" },
  { key: "intradayGateOrderFlow", label: "Order flow" },
  { key: "intradayGateHtfRegime", label: "HTF regime" },
  { key: "intradayGateInstitutionalSr", label: "Institutional S/R" },
  { key: "intradayGateSmcIct", label: "SMC / ICT" },
];

const INTRADAY_OF_FLAGS: { key: string; label: string }[] = [
  { key: "intradayOfUseOrderBook", label: "Use order book" },
  { key: "intradayOfRequireKeyLevel", label: "Require key level" },
  { key: "intradayOfRequireConfirmation", label: "Require confirmation" },
  { key: "intradayOfAllowProxy", label: "Allow proxy flow" },
  { key: "intradayOfAllowCvdOnly", label: "Allow CVD-only" },
  { key: "intradayOfRequirePremiumDiscount", label: "Require premium/discount" },
  { key: "intradayOfTp1Enabled", label: "TP1 enabled" },
  { key: "intradayOfTp2Enabled", label: "TP2 enabled" },
  { key: "intradayOfBreakevenAfterPartial", label: "Breakeven after partial" },
  { key: "intradayOfEntryAtSignalClose", label: "Entry at signal close" },
  { key: "intradayOfExitOnDeltaAgainst", label: "Exit on delta against" },
  { key: "intradaySmcUseOrderFlow", label: "SMC uses order flow" },
  { key: "intradaySmcRequireMss", label: "SMC require MSS" },
  { key: "intradaySmcRequireRetrace", label: "SMC require retrace" },
  { key: "intradaySmcRequireChoch", label: "SMC require CHOCH" },
  { key: "intradaySmcRequireBos", label: "SMC require BOS" },
  { key: "intradaySmcRequireConfirm", label: "SMC require confirm" },
  { key: "intradaySmcRequireFvgRetrace", label: "SMC FVG retrace" },
  { key: "intradaySmcRequireHtfBias", label: "SMC HTF bias" },
  { key: "intradaySmcRequirePremiumDiscount", label: "SMC premium/discount" },
  { key: "intradaySmcOneTradePerDay", label: "One trade per day" },
];

const INTRADAY_NUMERIC: { key: string; label: string }[] = [
  { key: "intradayOfKillzoneMode", label: "Killzone mode" },
  { key: "intradayOfMinConfluence", label: "Min confluence" },
  { key: "intradayOfMinStackBars", label: "Min stack bars" },
  { key: "intradayOfMinRr", label: "Min R:R" },
  { key: "intradayOfMaxHoldBars", label: "Max hold bars" },
  { key: "intradayOfPartialFrac", label: "Partial fraction" },
  { key: "intradaySmcIctMode", label: "SMC ICT mode" },
  { key: "intradaySmcMinScore", label: "SMC min score" },
  { key: "intradaySmcMinRr", label: "SMC min R:R" },
  { key: "intradaySmcMinAdx", label: "SMC min ADX" },
  { key: "intradaySmcMaxHoldBars", label: "SMC max hold bars" },
];

const ELITE_KEYS: { key: string; label: string }[] = [
  { key: "eliteStRequireHtf4hAlign", label: "Require HTF 4H align" },
  { key: "eliteStMinMoveQualityScore", label: "Min move quality score" },
  { key: "eliteStMinAdx", label: "Min ADX" },
  { key: "eliteStTrailAfterTp1", label: "Trail after TP1" },
];

function pushSection(sections: StrategyConfigSection[], title: string, rows: StrategyConfigRow[]) {
  if (!rows.length) return;
  sections.push({ title, rows });
}

/** Full signal-brain configuration for the strategy detail drawer. */
export function buildStrategyVersionConfigSections(version: StrategyVersion): StrategyConfigSection[] {
  const rawBot = pickBotFromStrategyVersion(version);
  const manual = String(rawBot.manualStrategy ?? "").toUpperCase();
  const bot = filterBotForProfile(rawBot, manual);
  const md =
    bot.marketDecision != null && typeof bot.marketDecision === "object"
      ? (bot.marketDecision as Record<string, unknown>)
      : {};
  const sections: StrategyConfigSection[] = [];

  pushSection(sections, "Signal routing", [
    { label: "Strategy mode", value: fmtVal(bot.strategyMode) },
    { label: "Manual strategy", value: manual || "—" },
    { label: "ST period × mult", value: `${fmtVal(bot.supertrendPeriod)} × ${fmtVal(bot.supertrendMultiplier)}` },
    { label: "Wilder ATR", value: fmtVal(bot.supertrendWilderAtr) },
    { label: "Spot autotrade", value: fmtVal(bot.supertrendSpotAuto) },
    { label: "Futures autotrade", value: fmtVal(bot.supertrendFuturesAuto) },
  ]);

  pushSection(
    sections,
    "Entry gates",
    rowsFromKeys(
      bot,
      ENTRY_GATES.filter(({ key }) => profileAllowsKey(key, manual)),
    ),
  );

  if (profileHasUiSection(manual, "marketDecision")) {
    pushSection(sections, "Market decision engine", [
      gateRow("MDE enabled", md.enabled === true),
      ...(md.enabled === true
        ? [
            { label: "Regime filter", value: fmtVal(md.regimeFilterEnabled), enabled: md.regimeFilterEnabled === true },
            { label: "Signal quality", value: fmtVal(md.signalQualityEnabled), enabled: md.signalQualityEnabled === true },
            { label: "Min regime confidence", value: fmtVal(md.minRegimeConfidence) },
          ]
        : []),
    ]);
  }

  if (profileHasUiSection(manual, "intradayGates")) {
    pushSection(sections, "Intraday gates", rowsFromKeys(bot, INTRADAY_GATES));
    const ofFlags = rowsFromKeys(bot, INTRADAY_OF_FLAGS);
    const enabledOf = ofFlags.filter((r) => r.enabled);
    pushSection(sections, "Intraday / order flow", [
      ...ofFlags,
      ...INTRADAY_NUMERIC.filter(({ key }) => bot[key] != null && bot[key] !== "").map(({ key, label }) => ({
        label,
        value: fmtVal(bot[key]),
      })),
    ]);
    if (enabledOf.length === 0 && ofFlags.length) {
      /* keep section — user sees all OFF explicitly */
    }
  }

  if (profileHasUiSection(manual, "elite")) {
    pushSection(
      sections,
      "Elite settings",
      ELITE_KEYS.filter(({ key }) => bot[key] != null).map(({ key, label }) => ({
        label,
        value: fmtVal(bot[key]),
        enabled: bot[key] === true,
      })),
    );
  }

  pushSection(sections, "Exit & trailing", [
    { label: "Trailing auto", value: fmtVal(bot.trailingStopLossAuto) },
    { label: "Trailing mode", value: fmtVal(bot.futuresTrailingStopMode) },
    { label: "Trail buffer mode", value: fmtVal(bot.trailBufferMode) },
    { label: "Trail buffer rate", value: fmtVal(bot.trailBufferRate) },
    { label: "Fixed SL %", value: fmtVal(bot.supertrendFuturesFixedSlPct) },
    { label: "Fixed TP %", value: fmtVal(bot.supertrendFuturesFixedTpPct) },
    { label: "Entry open style", value: fmtVal(bot.supertrendFuturesEntryOpenStyle) },
  ]);

  pushSection(sections, "Leverage & AI", [
    { label: "Leverage mode", value: fmtVal(bot.futuresLeverageMode) },
    { label: "Leverage", value: fmtVal(bot.futuresLeverage) },
    { label: "AI threshold", value: fmtVal(bot.aiThreshold) },
    { label: "Futures min AI prob", value: fmtVal(bot.supertrendFuturesMinAiProb) },
    { label: "SurfPulse ML threshold", value: fmtVal(bot.surfPulseMlThreshold) },
    { label: "Signal strength min", value: fmtVal(bot.signalStrengthOpenMin) },
  ]);

  return sections;
}
