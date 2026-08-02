import { normalizeIntradayGatesOnBot } from "./intradayGatesUi";
import { profileAllowsKey } from "./strategyConfigProfile.ts";
import { cfgRawActiveBotForCompare } from "./strategyConfigSlices.ts";

/**
 * Client-side mirror of backend `strategyInstanceSplit.INSTANCE_FIELD_KEYS`
 * for comparing live bot edits vs the saved strategy version (signal brain only).
 *
 * Snapshots use the same **key set** as `bot.js` → `buildTradingConfigPersistPayload().bot`
 * so WS-only fields (`running`, `lastDecision`, …) do not keep "Configuration changed" stuck on.
 * Keep this list in sync with that function's `bot: { … }` literal.
 */
export const STRATEGY_INSTANCE_FIELD_KEYS = [
  "symbol",
  "timeframe",
  "symbolMode",
  "marketMode",
  "universe",
  "universeCoinSelectMode",
  "universePinnedSymbols",
  "universeCoinBase",
  "universeCustomSymbols",
  "riskPerTrade",
  "riskPerTradeUnit",
  "maxDailyLoss",
  "maxDailyLossUnit",
  "allowedBudgetInputMode",
  "allowedBudgetUsdt",
  "allowedBudgetWalletPct",
  "capitalAllotmentCompoundPnlUi",
] as const;

/** Must match `backend/src/state/bot.js` → `buildTradingConfigPersistPayload` → `bot` keys. */
const PERSIST_BOT_KEYS_FOR_STRATEGY_COMPARE: readonly string[] = [
  "symbol",
  "timeframe",
  "symbolMode",
  "universePinnedSymbol",
  "universeCoinBase",
  "universeCustomSymbols",
  "universeCoinSelectMode",
  "universePinControl",
  "universeAutoCoinPick",
  "universePinnedSymbols",
  "aiThreshold",
  "riskPerTrade",
  "maxDailyLoss",
  "riskPerTradeUnit",
  "maxDailyLossUnit",
  "capitalSplitAcrossCoins",
  "allowedBudgetUsdt",
  "allowedBudgetWalletPct",
  "allowedBudgetInputMode",
  "allowedBudgetPnlAnchorMs",
  "multiTradeUsePctOfUsable",
  "multiTradePctOfUsable",
  "capitalAllotmentCompoundPnlUi",
  "capitalCycleStrategyBalanceUsdt",
  "capitalCyclePoolAnchorUsdt",
  "capitalCycleRealizedPnlUsdt",
  "capitalCycleSymbols",
  "perTradeBudgetCapEnabled",
  "perTradeBudgetInputMode",
  "multiCoinCapitalSizingActive",
  "multiBudgetSplitMode",
  "multiBudgetCoinUsdt",
  "multiBudgetCoinPct",
  "strategyMode",
  "manualStrategy",
  "marketMode",
  "futuresLeverageMode",
  "futuresLeverage",
  "supertrendSpotAuto",
  "supertrendFuturesAuto",
  "supertrendFuturesAiConfidenceFilter",
  "signalStrengthGatesTrades",
  "supertrendMoveQualityGate",
  "supertrendMoveQualityMinScore",
  "supertrendMoveQualityMinAdx",
  "supertrendMoveQualityMinMoveSlRatio",
  "supertrendMoveQualityExpectedMoveAtrMult",
  "supertrendMoveQualityMinAtrExpansion",
  "supertrendMoveQualityMinBodyVsAvg",
  "supertrendMoveQualityMinDirectionalBody",
  "supertrendMoveQualityMinVolumeVsAvg",
  "marketDecision",
  "supertrendBreakoutConfirm",
  "supertrendBreakoutMaxBars",
  "signalStrengthOpenMin",
  "smartSignalStrengthThreshold",
  "smartSignalStrengthThresholdMeta",
  "supertrendFuturesMinAiProb",
  "surfPulseMlGateEnabled",
  "surfPulseMlThreshold",
  "intelligenceGateEnabled",
  "intelligenceGateManualStrategies",
  "intelligenceGateStrict",
  "intelligenceGateHighWinRate",
  "supertrendConfirmationGateEnabled",
  "supertrendConfirmationMinAdx",
  "supertrendConfirmationMinVolRatio",
  "supertrendConfirmationMinBodyAtrRatio",
  "supertrendConfirmationMaxAdverseWickFrac",
  "supertrendConfirmationMaxDistFromStAtr",
  "supertrendConfirmationRequireHtfAlign",
  "supertrendHtf4hEnabled",
  "supertrendHtf4hPeriod",
  "supertrendHtf4hMultiplier",
  "volumeProfileEnabled",
  "volumeProfileSoftGates",
  "volumeProfileGatesEnabled",
  "intradayVpBrackets",
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
  "intradaySmcMinAdx",
  "intradaySmcHtfStrictness",
  "intradaySmcHtfBiasMode",
  "intradaySmcRequireHtfBias",
    "intradaySmcChochStrict",
    "intradaySmcBosMaxBars",
    "intradaySmcChochMaxBars",
    "intradaySmcRequirePremiumDiscount",
    "intradaySmcPremiumDiscountOte",
    "intradaySmcDealingRangeLookback",
    "intradaySmcOteMin",
    "intradaySmcOteMax",
    "intradaySmcPremiumDiscountTolPct",
    "srIntradayMaxTradesPerDay",
  "srIntradayMinBarGap",
  "intradayLiqStrictMode",
  "intradayLiqMinSweepExtensionPct",
  "intradayLiqSlBufferPct",
  "intradayLiqSessionExtreme",
  "intradayLiqSessionExtremeMinTouches",
  "intradayLiqSessionNarratives",
  "intradayLiqMinScore",
  "intradayLiqMinQuality",
  "intradayLiqMinWickRatio",
  "intradayLiqMinReclaimBodyRatio",
  "intradayLiqMinReclaimClosePct",
  "intradayLiqRejectSameBarReclaim",
  "intradayLiqOnePickPerDay",
  "intradayLiqMaxTradesPerSidePerDay",
  "intradayLiqRequireHtfAlign",
  "intradayLiqHtfAlignPdhPdl",
  "intradayLiqMinHtfSep",
  "intradayLiqMaxTpRr",
  "intradayLiqMaxSlPct",
  "intradayLiqMinSlPct",
  "intradayLiqMaxSweepBars",
  "intradayLiqFirstCycleOnly",
  "intradayLiqEntryAtSignalClose",
  "intradayLiqMaxHoldBars",
  "intradayLiqPlaybook",
  "intradayLiqPickMode",
  "intradayLiqUseEntryScore",
  "intradayLiqUseEntryScoreV2",
  "intradayLiqMinEntryScore",
  "intradayLiqReclaimHoldBars",
  "intradayLiqRequireChoch",
  "intradayLiqMarketStateGate",
  "intradayLiqDaySituationBias",
  "intradayLiqRangeCompressionMin",
  "intradayLiqMaxAdx",
  "intradayLiqContinuationGate",
  "intradayLiqSweepQualityGate",
  "intradayLiqBreakdownDayBias",
  "intradayLiqRequireDisplacementV2",
  "intradayLiqSweepDisplacementMinAtrMult",
  "intradayLiqMitigationEntry",
  "intradayLiqMitigationFrac",
  "intradayLiqMitigationWaitBars",
  "intradayLiqActiveHourStart",
  "intradayLiqActiveHourEnd",
  "intradayLiqRequireSameBarReclaim",
  "intradayLiqSweepMinVolRatio",
  "intradayLiqRequirePremiumDiscountAlign",
  "intradayLiqRequireKillzone",
  "intradayLiqVetoCounterTrend",
  "intradayLiqMaxDailyRangeUsedPct",
  "liqMapLookbackBars",
  "liqMapMaxAgeBars",
  "liqMapMinTouches",
  "liqMapMinWickRatio",
  "liqMapMinRvol",
  "liqMapMinBodyRatio",
  "liqMapSweepPct",
  "liqMapEqualTolPct",
  "liqMapNormalizeThresholds",
  "liqMapSweepAtrFrac",
  "liqMapEqualTolAtrFrac",
  "liqMapAutoCalibrate",
  "liqMapAutoProfileBars",
  "liqMapAutoTrailTune",
  "liqMapHybridExit",
  "liqMapQualityGate",
  "liqMapQualityGateMode",
  "liqMapSoftGateScoreBand",
  "liqMapQualityAuto",
  "liqMapMinQualityScore",
  "liqMapRequireUnresolved",
  "liqMapRequireDirectionalClose",
  "liqMapEntryModel",
  "liqMapHtfPoolTfs",
  "liqMapHtfLookbackBars",
  "liqMapHtfSwingLeft",
  "liqMapHtfSwingRight",
  "liqMapHtfEqualMinTouches",
  "liqMapUseDailyWeeklyPools",
  "liqMapUseTrendlinePools",
  "liqMapEntryTiming",
  "liqMapRequireMss",
  "liqMapRequireChoch",
  "liqMapRequireRetrace",
  "liqMapRequireReclaimHold",
  "liqMapStructureLookbackBars",
  "liqMapMssMaxBarsAfterSweep",
  "liqMapEntryZoneMode",
  "liqMapFvgEntryMode",
  "liqMapMssRequireDisplacement",
  "liqMapDisplacementBodyMult",
  "liqMapDisplacementAtrMult",
  "liqMapFvgMinGapPct",
  "liqMapStrictPdZone",
  "liqMapObMinDisplacementAtr",
  "liqMapRr",
  "liqMapHtfMode",
  "liqMapKillzone",
  "liqMapMinAtrPctile",
  "liqMapMaxAtrPctile",
  "liqMapAtrPctileLookback",
  "liqMapMinAdx",
  "liqMapMaxAdx",
  "liqMapMinAtrPct",
  "liqMapMaxAtrPct",
  "liqMapMaxHoldBars",
  "liqMapMaxSlPct",
  "liqMapSlMode",
  "liqMapSlBufferPct",
  "liqMapSlBufferAtrFrac",
  "liqMapOnePerDay",
  "liqMapOnePerSidePerDay",
  "liqMapRvolLookback",
  "liqMapExitMode",
  "liqMapTrailMode",
  "liqMapMaxTpRr",
  "liqMapMaxOpposingRr",
  "liqMapMinTp2Rr",
  "liqMapFallbackTpRr",
  "liqMapPartialFrac",
  "liqMapBreakevenAfterPartial",
  "liqMapUse4hConfirm",
  "liqMapAtrSlMult",
  "liqMapSlRegimeAdjust",
  "liqMapSlRegimeLowMult",
  "liqMapSlRegimeHighMult",
  "liqMapTrailStPeriod",
  "liqMapTrailStMult",
  "liqMapTrailAtrHwmMult",
  "liqMapTrailMfeGiveback",
  "liqMapTrailMfeMinR",
  "liqMapTrailStepAtrMult",
  "liqMapTrailMergeSt",
  "liqMapDynamicRunnerMaxTpRr",
  "liqMapDynamicRunnerMinTpRr",
  "liqMapProjectedTpAtrMult",
  "liqMapProjectedTpRangeMult",
  "liqMapProjectionLookbackBars",
  "liqMapDynamicExitPolicy",
  "liqMapDynExitQualityHi",
  "liqMapDynExitQualityMid",
  "liqMapDynExitRrHi",
  "liqMapDynExitRrMid",
  "liqMapDynExitPartialHi",
  "liqMapDynExitPartialMid",
  "liqMapDynExitPartialBase",
  "liqMapDynExitTrailAtrHi",
  "liqMapDynExitTrailAtrMid",
  "liqMapDynExitTrailAtrBase",
  "liqMapDynExitWeakTp1Rr",
  "liqMapStructuralTp1Rr",
  "liqMapDeadTradeExitBars",
  "liqMapDeadTradeMinMfeR",
  "liqMapDeadTradeMaxLossR",
  "liqCascadeInterval",
  "liqCascadeZScoreMin",
  "liqCascadeLookbackBars",
  "liqCascadeWindowBars",
  "liqCascadeMinDispAtr",
  "liqCascadeStrongDispAtr",
  "liqCascadeMinOiDropPct",
  "liqCascadeOiGateMode",
  "liqCascadeOiWindowBars",
  "liqCascadeConfirmMode",
  "liqCascadeConfirmLiqBars",
  "liqCascadeExhaustionDecay",
  "liqCascadeDirectionMode",
  "liqCascadeMinAtrPct",
  "liqCascadeSlBufferPct",
  "liqCascadeTpAtrMult",
  "liqCascadeTpRr",
  "liqCascadeMinRr",
  "liqCascadeMaxHoldBars",
  "liqCascadeMaxTradesPerDay",
  "liqCascadeMinBarGap",
  "liqCascadeEventCooldownLiqBars",
  "liqCascadeTradeSides",
  "liqCascadeMinLiqUsdBar",
  "liqCascadeLiveTickEnabled",
  "liqCascadeLiqSource",
  "liqCascadeOiSource",
  "microEventDirectionMode",
  "microEventTypesEnabled",
  "microEventMinConfluenceScore",
  "microEventMinConfirmLayers",
  "microEventLiqWindowSec",
  "microEventLiqZMin",
  "microEventLiqMinUsd",
  "microEventLiqDomRatio",
  "microEventLiqRequired",
  "microEventOiGateEnabled",
  "microEventOiMinDropPct1m",
  "microEventOiMinDropPct5m",
  "microEventBookGateEnabled",
  "microEventMinImbalance",
  "microEventMaxOppositeWallUsd",
  "microEventCvdGateEnabled",
  "microEventMinAggressiveUsd",
  "microEventMinCvdSlope",
  "microEventFundingGateEnabled",
  "microEventMinFundingZ",
  "microEventCrowdedSideFilter",
  "microEventMacroGateEnabled",
  "microEventMacroScoreBoost",
  "microEventSlBufferPct",
  "microEventTpRr",
  "microEventMaxHoldSec",
  "microEventMaxTradesPerHour",
  "microEventCooldownSec",
  "microEventLiveTickEnabled",
  "microEventTradeSides",
  "intradaySmcSlMode",
  "intradaySmcMaxTpRr",
  "intradaySmcMaxHoldBars",
  "intradaySmcKillzoneMode",
  "intradaySmcEntryZoneMode",
  "intradaySmcFvgEntryMode",
  "intradaySmcTp2Mode",
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
  "intradayLiqTp1Enabled",
  "intradayLiqTp2Enabled",
  "intradayLiqBreakevenAfterPartial",
  "intradayLiqPartialTp",
  "intradayLiqPartialFrac",
  "intradayLiqTp1Rr",
  "intradayLiqTp2Rr",
  "intradayLiqTp2PartialFrac",
  "intradayLiqMinRr",
  "intradayFibStrictMode",
  "intradayFibConfirmNextBar",
  "intradayFibRequireRsiAlign",
  "intradayFibRequireHtfAlign",
  "intradayFibLearnedRulesEnabled",
  "intradayFibRequireRetraceCoherence",
  "intradayFibAllowedRatios",
  "intradayFibGoldenRetraceMin",
  "intradayFibGoldenRetraceMax",
  "intradayFibMinRetraceRatio",
  "intradayFibMaxRetraceRatio",
  "intradayFibMinWickRatio",
  "intradayFibMinAdx",
  "intradayFibMinLegAtrMult",
  "intradayFibMinHtfSep",
  "intradayFibMinScore",
  "intradayFibTpMode",
  "intradayFibExtensionFrac",
  "intradayFibMinRr",
  "intradayFibMinLegAtrMult",
  "intradayFibMaxBarsSinceSwing",
  "intradayFibBracketSource",
  "intradayFibGoldenScalpTpPct",
  "intradayFibGoldenScalpSlPct",
  "intradayFibEntryAtSignalClose",
  "intradayTierMode",
  "backtestBreakevenAtMfePct",
  "vpLookbackBars",
  "vpMinRR",
  "vpTierAOnly",
  "vpAllowHvnFlip",
  "vpRequireHtfAlign",
  "vpRegimeImmunity",
  "vpIncludePriorSession",
  "vpEnableNakedPoc",
  "vpBreakoutUsePriorSession",
  "vpHardBlockCeilingFloor",
  "vpStructureBrackets",
  "requireVpSetup",
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
  "vpMinBarVolRatio",
  "vpMinAtrPct",
  "vpMaxAtrPct",
  "vpNearTolPct",
  "vpRejectionMinVolRatio",
  "vpRejectionSpikePct",
  "vpOutsideVaLookback",
  "vpProfileMode",
  "vpVolumeDistribute",
  "volumeProfileGateMode",
  "vpPlaybook",
  "vpAllowedSetups",
  "eliteStRequireHtf4hAlign",
  "eliteStHtf4hPeriod",
  "eliteStHtf4hMultiplier",
  "eliteStRequireHtf1hEmaAlign",
  "eliteStHtf1hMinSep",
  "eliteStHtf1hSepMode",
  "eliteStHtf1hMinSepAtrMult",
  "eliteStHtf1hMinSepFloor",
  "eliteStHtf1hMinSepCeil",
  "eliteStHtf1hSepPercentileLookback",
  "eliteStHtf1hSepPercentileMult",
  "eliteStHtf1hSepAdxBase",
  "eliteStHtf1hSepAdxAlpha",
  "eliteStHtf1hSepAdxRef",
  "eliteStHtf1hSepCalibratePct",
  "eliteStHtf1hSepCalibrateBars",
  "eliteStAutoCalibrate",
  "eliteStAutoProfileBars",
  "eliteStAutoBracketMode",
  "eliteStAutoMinAdxFloor",
  "eliteStAutoMinAdxCeil",
  "eliteStMinAdx",
  "eliteStRequireAdxRising",
  "eliteStAdxRisingLookback",
  "eliteStMinVolumeVsAvg",
  "eliteStRequireAtrExpansion",
  "eliteStMinAtrExpansion",
  "eliteStAtrExpansionLookback",
  "eliteStLiqSweepEnabled",
  "eliteStAutoFullTune",
  "supertrendBigMoveGateEnabled",
  "supertrendBigMoveMinStrength",
  "supertrendBigMoveMinMoveSlRatio",
  "supertrendBigMoveMinAdx",
  "supertrendBigMoveMinScore",
  "supertrendBigMoveMaxCandlesSinceFlip",
  "supertrendBigMoveMinVolumeVsAvg",
  "supertrendBigMoveExpectedMoveAtrMult",
  "supertrendFuturesExitOnFlip",
  "trailingStopLossAuto",
  "futuresTrailingStopMode",
  "futuresTrailingStFeeBreakeven",
  "futuresTrailingStAdvanced",
  "trailingStopExtraScalpingPcts",
  "trailOpenFeeRate",
  "trailCloseFeeRate",
  "tradeHistoryMakerOpenFeeRate",
  "tradeHistoryMakerCloseFeeRate",
  "tradeHistoryTakerOpenFeeRate",
  "tradeHistoryTakerCloseFeeRate",
  "trailFeeBeMultiplier",
  "trailBufferRate",
  "trailActivationSlippageFrac",
  "trailT01LockSlippageFrac",
  "trailBufferAtrMult",
  "trailBufferMode",
  "trailPostT02ActivationBufferRate",
  "trailMinSlDistFrac",
  "trailMinGapFromMarkFrac",
  "trailMaintMarginRate",
  "trailPostT02SpacingFrac",
  "trailPostT02MaxExtraTiers",
  "trailSizingMode",
  "trailDynamicBeAtrMult",
  "trailDynamicBeT01LockAtrMult",
  "trailDynamicBeRegimeAdjust",
  "trailDynamicBeRegimeLowMult",
  "trailDynamicBeRegimeHighMult",
  "trailDynamicAdvAtrHwmMult",
  "trailDynamicAdvMfeGivebackFrac",
  "trailDynamicAdvMfeMinR",
  "trailDynamicAdvMergeSupertrend",
  "trailDynamicAdvAtrSource",
  "trailDynamicAdvPostT02StepAtrMult",
  "trailOnlyAfterTp2Fill",
  "trailOnlyAfterPartialFill",
  "supertrendFuturesFixedSlPct",
  "supertrendFuturesFixedTpPct",
  "supertrendFuturesUseFixedSl",
  "supertrendFuturesUseFixedTp",
  "supertrendFuturesTwoWay",
  "supertrendFuturesMaxEntrySlippagePct",
  "supertrendFuturesEntryOpenStyle",
  "supertrendFuturesEntryRecheckMs",
  "supertrendFuturesIocFallbackMarket",
  "supertrendFuturesRequireMarkPrice",
  "supertrendFuturesRequireBookTicker",
  "supertrendFuturesMaxSignalLagMs",
  "supertrendPeriod",
  "supertrendMultiplier",
  "supertrendWilderAtr",
  "trendHtfStRegimeGate",
  "trendHtfStSurgicalLossFilter",
  "trendHtfStQualityFilter",
  "trendHtfStFlipExitBeforeSl",
  "trendHtfStMaxEntryRangeAtr",
  "trendHtfStMinHtfSep",
  "trendHtfStRegimeTpTrend",
  "trendHtfStRegimeTpMixed",
  "trendHtfStRegimeTpChop",
  "backtestBreakevenAtMfePct",
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
  "riskScale",
  "volTargetSizing",
  "volTargetAtrPct",
  "volTargetMaxMult",
  "volTargetMinMult",
  "riskKillSwitchDdPct",
  "riskConsecutiveLossLimit",
  "riskWeeklyMaxLossPct",
];

/** Live engine counters — not strategy parameters; exclude from dirty compare. */
const RUNTIME_ONLY_BOT_KEYS = new Set<string>([
  "capitalCycleStrategyBalanceUsdt",
  "capitalCyclePoolAnchorUsdt",
  "capitalCycleRealizedPnlUsdt",
  "capitalCycleSymbols",
  "allowedBudgetPnlAnchorMs",
  /** Learned each bar on the backend — must not flip "Configuration changed". */
  "smartSignalStrengthThreshold",
  "smartSignalStrengthThresholdMeta",
]);

function stripInstanceFieldsFromCfgRaw(cfgRaw: Record<string, unknown>): Record<string, unknown> {
  const root = { ...cfgRaw };
  const hasBotSubtree = root.bot && typeof root.bot === "object" && !Array.isArray(root.bot);
  const target = hasBotSubtree
    ? { ...(root.bot as Record<string, unknown>) }
    : ({ ...root } as Record<string, unknown>);
  for (const key of STRATEGY_INSTANCE_FIELD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(target, key)) delete target[key];
  }
  if (hasBotSubtree) return { ...root, bot: target };
  return target;
}

function pickPersistBotShape(flat: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeIntradayGatesOnBot(flat);
  const out: Record<string, unknown> = {};
  for (const k of PERSIST_BOT_KEYS_FOR_STRATEGY_COMPARE) {
    if (RUNTIME_ONLY_BOT_KEYS.has(k)) continue;
    const v = normalized[k];
    // Sparse shape — matches DB cfg_raw (JSON omits undefined). Dense objects made
    // "Configuration changed" stick on after Save when compared to sparse baselines.
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function flatSignalBrainBotForCompare(root: Record<string, unknown>): Record<string, unknown> {
  const stripped = stripInstanceFieldsFromCfgRaw(root);
  const flat =
    stripped.bot && typeof stripped.bot === "object" && !Array.isArray(stripped.bot)
      ? ({ ...(stripped.bot as Record<string, unknown>) } as Record<string, unknown>)
      : ({ ...stripped } as Record<string, unknown>);
  delete flat.v;
  delete flat.tradingFormDefaults;
  return normalizeIntradayGatesOnBot(flat);
}

/** Fast fingerprint of persist-relevant bot fields — skip dirty recompute when unchanged. */
export function signalBrainBotFingerprint(bot: unknown): string {
  const uiFlat = flatSignalBrainBotForCompare(persistLikePayloadFromUiBot(bot));
  const manual = String(uiFlat.manualStrategy ?? "").toUpperCase();
  let h = "";
  for (const k of PERSIST_BOT_KEYS_FOR_STRATEGY_COMPARE) {
    if (RUNTIME_ONLY_BOT_KEYS.has(k)) continue;
    if (!profileAllowsKey(k, manual)) continue;
    const v = uiFlat[k];
    if (v === undefined) continue;
    h += `${k}\0${stableStringify(v)}\0`;
  }
  return h;
}

/** True when live UI bot matches saved strategy cfg_raw (signal brain only). */
export function signalBrainPersistBotsEqual(
  bot: unknown,
  cfgRaw: Record<string, unknown> | null | undefined,
): boolean {
  const uiFlat = flatSignalBrainBotForCompare(persistLikePayloadFromUiBot(bot));
  const manual = String(uiFlat.manualStrategy ?? "").toUpperCase();
  const cfgFlat = normalizeIntradayGatesOnBot(
    cfgRawActiveBotForCompare(
      cfgRaw && typeof cfgRaw === "object" ? ({ ...cfgRaw } as Record<string, unknown>) : { v: 1, bot: {} },
    ),
  );
  for (const k of PERSIST_BOT_KEYS_FOR_STRATEGY_COMPARE) {
    if (RUNTIME_ONLY_BOT_KEYS.has(k)) continue;
    if (!profileAllowsKey(k, manual)) continue;
    const a = uiFlat[k];
    const b = cfgFlat[k];
    if (a === undefined && b === undefined) continue;
    if (stableStringify(a) !== stableStringify(b)) return false;
  }
  return true;
}

/** cfg_raw shape aligned with what Save persists (for dirty baseline after Save). */
export function canonicalCfgRawFromUiBot(bot: unknown): Record<string, unknown> {
  if (!bot || typeof bot !== "object" || Array.isArray(bot)) {
    return stripInstanceFieldsFromCfgRaw({ v: 1, bot: {} });
  }
  return canonicalSignalBrainRecord(persistLikePayloadFromUiBot(bot));
}

/** Fingerprint of instance-owned fields (symbol/risk/capital) for config view refresh. */
export function instanceOperationalViewFingerprint(bot: unknown): string {
  return stableStringify(instanceOperationalFromUiBot(bot));
}

/** Mirror of backend `extractInstanceConfig` — sent with Save so we skip pre-save `/api/bot/config` flush. */
export function instanceOperationalFromUiBot(bot: unknown): Record<string, unknown> {
  const payload = persistLikePayloadFromUiBot(bot);
  const b =
    payload.bot && typeof payload.bot === "object" && !Array.isArray(payload.bot)
      ? (payload.bot as Record<string, unknown>)
      : (payload as Record<string, unknown>);
  const universe =
    b.universe && typeof b.universe === "object" && !Array.isArray(b.universe)
      ? (b.universe as Record<string, unknown>)
      : {
          mode: b.universeCoinSelectMode ?? null,
          pinnedSymbols: b.universePinnedSymbols ?? null,
          coinBase: b.universeCoinBase ?? null,
          customSymbols: b.universeCustomSymbols ?? null,
          autoCoinPick: b.universeAutoCoinPick ?? null,
        };
  return {
    inst_symbol: b.symbol ?? null,
    inst_timeframe: b.timeframe ?? null,
    inst_symbol_mode: b.symbolMode ?? null,
    inst_market_mode: b.marketMode ?? null,
    inst_universe: universe,
    inst_risk_per_trade: b.riskPerTrade ?? null,
    inst_risk_unit: b.riskPerTradeUnit ?? null,
    inst_max_daily_loss: b.maxDailyLoss ?? null,
    inst_max_daily_loss_unit: b.maxDailyLossUnit ?? null,
    inst_capital_mode: b.allowedBudgetInputMode ?? null,
    inst_capital_usdt: b.allowedBudgetUsdt ?? null,
    inst_capital_pct: b.allowedBudgetWalletPct ?? null,
    inst_compound_pnl: b.capitalAllotmentCompoundPnlUi ?? null,
  };
}

/** Match `getTradingConfigPersistPayload` / WS bot: nested `bot` or flat legacy. */
export function persistLikePayloadFromUiBot(bot: unknown): Record<string, unknown> {
  if (!bot || typeof bot !== "object" || Array.isArray(bot)) return { v: 1, bot: {} };
  const o = bot as Record<string, unknown>;
  if (o.bot && typeof o.bot === "object" && !Array.isArray(o.bot)) return { ...o };
  const v = typeof o.v === "number" ? o.v : 1;
  const tradingFormDefaults = o.tradingFormDefaults;
  const botOnly = { ...o };
  delete botOnly.v;
  delete botOnly.tradingFormDefaults;
  return {
    v,
    bot: botOnly as Record<string, unknown>,
    ...(tradingFormDefaults && typeof tradingFormDefaults === "object" && !Array.isArray(tradingFormDefaults)
      ? { tradingFormDefaults }
      : {}),
  };
}

/** Strip instance fields, then keep only persist-payload bot keys (+ v / tradingFormDefaults). */
function canonicalSignalBrainRecord(root: Record<string, unknown>): Record<string, unknown> {
  const stripped = stripInstanceFieldsFromCfgRaw(root);
  const v = typeof stripped.v === "number" ? stripped.v : 1;
  const flat =
    stripped.bot && typeof stripped.bot === "object" && !Array.isArray(stripped.bot)
      ? ({ ...(stripped.bot as Record<string, unknown>) } as Record<string, unknown>)
      : ({ ...stripped } as Record<string, unknown>);
  delete flat.v;
  delete flat.tradingFormDefaults;
  const bot = pickPersistBotShape(flat);
  const out: Record<string, unknown> = { v, bot };
  const tfd = stripped.tradingFormDefaults;
  if (tfd && typeof tfd === "object" && !Array.isArray(tfd)) {
    out.tradingFormDefaults = { ...(tfd as Record<string, unknown>) };
  }
  return out;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((x) => stableStringify(x)).join(",")}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

/** Canonical signal-brain JSON for equality vs `StrategyVersion.cfgRaw`. */
export function signalBrainSnapshotFromUiBot(bot: unknown): string {
  if (!bot || typeof bot !== "object" || Array.isArray(bot)) {
    return stableStringify(canonicalSignalBrainRecord({ v: 1, bot: {} }));
  }
  const payload = persistLikePayloadFromUiBot(bot);
  return stableStringify(canonicalSignalBrainRecord(payload));
}

export function signalBrainSnapshotFromCfgRaw(cfgRaw: Record<string, unknown> | null | undefined): string {
  if (!cfgRaw || typeof cfgRaw !== "object") {
    return stableStringify(canonicalSignalBrainRecord({ v: 1, bot: {} }));
  }
  return stableStringify(canonicalSignalBrainRecord({ ...cfgRaw }));
}
