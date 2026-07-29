/**
 * INTRADAY_PRO / SR_INTRADAY — trade-by-trade veto stack + tier-A big-move trail.
 * npm run backtest:intraday-autopsy -- BNBUSDT 15m
 */

import { resolveIntradayGates, isSmcIctEngineActive, applySmcEngineExclusivity } from "../intradayGates.js";
import { INSTANCE_FIELD_KEYS } from "../../lib/strategyInstanceSplit.js";

const INSTANCE_PRESET_SKIP = new Set(INSTANCE_FIELD_KEYS);

export const INTRADAY_PRO_BASE = {
  strategyMode: "MANUAL",
  manualStrategy: "SR_INTRADAY",
  marketMode: "FUTURES",
  supertrendFuturesAuto: false,
  trailingStopLossAuto: false,
  futuresTrailingStopMode: "SUPERTREND",
  supertrendFuturesExitOnFlip: false,
  supertrendHtf4hEnabled: true,
  supertrendHtf4hPeriod: 10,
  supertrendHtf4hMultiplier: 3,
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 2.5,
  riskPerTradeUnit: "PCT",
  slippagePct: 0.0005,
  supertrendFuturesFixedSlPct: 0.0035,
  supertrendFuturesFixedTpPct: 0.01,
  srIntradayMaxTradesPerDay: 5,
  srIntradayMinBarGap: 4,
  srIntradayMinScore: 8,
  intradaySoloGateMinScore: 5,
  intradayFibStrictMode: true,
  intradayFibLookback: 80,
  intradayFibPivotLeft: 3,
  intradayFibPivotRight: 3,
  intradayFibMinLegAtrMult: 2,
  intradayFibAllowedRatios: [0.5, 0.618],
  intradayFibTolPct: 0.0016,
  intradayFibMinRetraceRatio: 0.48,
  intradayFibMaxRetraceRatio: 0.72,
  intradayFibMaxBarsSinceSwing: 28,
  intradayFibMinWickRatio: 0.4,
  intradayFibMinAdx: 22,
  intradayFibRequireHtfAlign: true,
  intradayFibMinRr: 1.25,
  intradayFibMaxSlPct: 0.006,
  intradayFibMaxTpPct: 0.012,
  intradayFibMinScore: 8,
  intradayFibConfirmNextBar: true,
  intradayFibMinHtfSep: 0.00065,
  intradayFibSessionStartHour: 8,
  intradayFibSessionEndHour: 20,
  srIntradaySessionStartHour: 7,
  srIntradaySessionEndHour: 22,
  intradayMinTechniqueCount: 3,
  intradayRequireSessionReclaim: true,
  intradayRequireFibOrVp: true,
  intradayLearnedRulesEnabled: true,
  intradayGateLiquidity: true,
  intradayGateSession: true,
  intradayLiqStrictMode: true,
  intradayGateFib: true,
  intradayGateVp: true,
  intradayGateOrderFlow: true,
  intradayGateHtfRegime: true,
  intradayBigMoveMinScore: 11,
};

/** Primary: fixed TP scalps with loss vetoes */
export const INTRADAY_PRO_15M = {
  ...INTRADAY_PRO_BASE,
  symbol: "BNBUSDT",
  timeframe: "15m",
};

/**
 * Fib gate only — golden-pocket entry + swing SL + extension TP.
 * Enable only "Fibonacci" under Indicators.
 *
 * Tuned via npm run backtest:fib-sweep (BNB 15m, Jan–May 2026) over technical ranges:
 * - Entry: 0.618 retrace + coherence + HTF align (classic golden pocket)
 * - SL: beyond impulse swing extreme
 * - TP: 161.8% extension (0.618 × leg range past the extreme) — better R:R than leg-high alone
 * - Filters: min leg 2.5× ATR, ADX≥20, fresh swing ≤18 bars, min R:R 1.5 at signal
 */
export const INTRADAY_PRO_FIB_15M = {
  ...INTRADAY_PRO_BASE,
  symbol: "BNBUSDT",
  timeframe: "15m",
  intradayGateLiquidity: false,
  intradayGateSession: false,
  intradayGateFib: true,
  intradayGateVp: false,
  intradayGateOrderFlow: false,
  intradayGateHtfRegime: false,
  intradayLearnedRulesEnabled: false,
  supertrendHtf4hEnabled: false,
  intradayFibStrictMode: true,
  intradayFibAllowedRatios: [0.618],
  intradayFibRequireRetraceCoherence: true,
  intradayFibGoldenRetraceMin: 0.55,
  intradayFibGoldenRetraceMax: 0.68,
  intradayFibLearnedRulesEnabled: true,
  intradayFibMinRetraceRatio: 0.55,
  intradayFibMaxRetraceRatio: 0.68,
  intradayFibConfirmNextBar: false,
  intradayFibRequireRsiAlign: false,
  intradayFibRequireHtfAlign: true,
  intradayFibMinWickRatio: 0.4,
  intradayFibMinHtfSep: 0.00065,
  intradayFibMinAdx: 20,
  intradayFibMinLegAtrMult: 2.5,
  intradayFibMaxBarsSinceSwing: 18,
  intradayFibTolPct: 0.0014,
  intradayFibHtfAlignMode: "required",
  intradayFibProfile: "sniper",
  intradayFibSessionStartHour: 7,
  intradayFibSessionEndHour: 22,
  intradayFibTpMode: "extension",
  intradayFibExtensionFrac: 0.618,
  intradayFibMinRr: 1.5,
  intradayFibMaxSlPct: 0,
  intradayFibMaxTpPct: 0,
  intradayFibMinScore: 8,
  intradayRequireFibOrVp: false,
  intradayRequireSessionReclaim: false,
  intradayMinTechniqueCount: 1,
  intradayTierMode: "all",
  srIntradayMinScore: 8,
  srIntradayMaxTradesPerDay: 3,
  srIntradayMinBarGap: 2,
  intradayFibAnchorEntry: true,
  supertrendFuturesFixedTpPct: 0,
  supertrendFuturesFixedSlPct: 0,
  backtestBreakevenAtMfePct: 0,
  intradayFibEntryAtSignalClose: true,
};

/** Volume Profile structure gates + HVN/LVN brackets (Way 1–5) */
export const INTRADAY_PRO_VP_15M = {
  ...INTRADAY_PRO_BASE,
  symbol: "BNBUSDT",
  timeframe: "15m",
  intradayGateVp: true,
  intradayVpBrackets: true,
  volumeProfileSoftGates: true,
  volumeProfileGatesEnabled: false,
  intradayLvnSizeMult: 2,
  vpProfileMode: "rolling",
  vpLookbackBars: 384,
  vpCompositeDays: 5,
  vpVolumeDistribute: "close_weighted",
  vpIncludePriorSession: true,
  vpEnableNakedPoc: true,
  vpBreakoutUsePriorSession: true,
  vpValueAreaPct: 0.7,
  vpMinRR: 1.35,
  vpMinRunPct: 0.003,
  requireVpSetup: false,
  srIntradayMinScore: 9,
};

/** Tier-A only + ST trail for big moves */
export const INTRADAY_PRO_BIGMOVE_15M = {
  ...INTRADAY_PRO_BASE,
  symbol: "BNBUSDT",
  timeframe: "15m",
  intradayTierMode: "A",
  srIntradayMinScore: 10,
  trailingStopLossAuto: true,
  supertrendFuturesExitOnFlip: true,
  supertrendFuturesFixedTpPct: 0,
  supertrendPeriod: 10,
  supertrendMultiplier: 2.5,
  supertrendWilderAtr: true,
  backtestBreakevenAtMfePct: 0.004,
};

export const INTRADAY_PRO_5M = {
  ...INTRADAY_PRO_BASE,
  symbol: "BNBUSDT",
  timeframe: "5m",
  srIntradayMinBarGap: 8,
};

export const SR_INTRADAY_SNIPER_BASE = INTRADAY_PRO_15M;
export const SR_INTRADAY_BNB_15M = INTRADAY_PRO_15M;
export const SR_INTRADAY_BNB_5M = INTRADAY_PRO_5M;
export const SR_INTRADAY_BTC_15M = { ...INTRADAY_PRO_15M, symbol: "BTCUSDT" };
export const SR_INTRADAY_TRAIL_15M = INTRADAY_PRO_BIGMOVE_15M;

export const SR_INTRADAY_RECOMMENDED_TIMEFRAME = "15m";
export const SR_INTRADAY_RECOMMENDED_SYMBOL = "BNBUSDT";

/**
 * When only the Fibonacci gate is on, missing fib params must not fall back to strict
 * code defaults (confirm=true, etc.) — merge production fib preset for undefined keys.
 */
/**
 * Practical liquidity sweep — PDH/PDL reclaim, partial @ 1R + BE, opposing-liquidity TP2.
 * Tuned BNB 15m Jan–May 2026 (~22 trades, ~64% WR, ~+20% @ 2.5% risk/sl):
 * - Min sweep extension 0.8% (filters weak stops; fewer but higher-quality setups)
 * - Min R:R 1.5 at signal (payoff needs partial @ 1R path; blocks marginal ~1.2R trades)
 * - Allow later same-day cycles (firstCycleOnly off — failed breakdowns can re-offer)
 * - Reclaim body filters off by default (tighten via UI if you want fewer entries)
 */
export const INTRADAY_PRO_LIQ_15M = {
  ...INTRADAY_PRO_BASE,
  symbol: "BNBUSDT",
  timeframe: "15m",
  intradayGateLiquidity: true,
  intradayGateSession: false,
  intradayGateFib: false,
  intradayGateVp: false,
  intradayGateOrderFlow: false,
  intradayGateHtfRegime: false,
  /** Explicit — draft merge must not leave a prior SMC/ICT path on. */
  intradayGateSmcIct: false,
  intradaySmcIctMode: false,
  intradayGateInstitutionalSr: false,
  intradaySrAPlusMode: false,
  intradayLearnedRulesEnabled: false,
  supertrendHtf4hEnabled: false,
  intradayLiqStrictMode: true,
  intradayLiqMinScore: 6,
  intradayLiqMinQuality: 0,
  intradayLiqMinRr: 1.5,
  intradayLiqMinWickRatio: 0,
  intradayLiqRejectSameBarReclaim: true,
  intradayLiqFirstCycleOnly: false,
  intradayLiqMinReclaimClosePct: 0,
  // Reject weak/false reclaims (e.g. trade #1: 0.29 body that re-broke the level
  // next bar) — require a decisive rejection candle so genuine breakouts aren't faded.
  intradayLiqMinReclaimBodyRatio: 0.35,
  intradayLiqMaxSlPct: 0.035,
  intradayLiqMaxSweepBars: 40,
  intradayLiqMinSweepExtensionPct: 0.008,
  /** Off by default — enable in UI for established session highs/lows (e.g. 650 cluster). */
  intradayLiqSessionExtreme: false,
  intradayLiqSessionExtremeMinTouches: 3,
  intradayLiqSessionExtremeMinExtensionPct: 0.008,
  intradayLiqSessionExtremeMinDistFromSession: 0.005,
  intradayLiqPartialTp: true,
  intradayLiqTp1Enabled: true,
  intradayLiqTp2Enabled: true,
  intradayLiqPartialFrac: 0.5,
  intradayLiqMaxTradesPerSidePerDay: 1,
  intradayLiqOnePickPerDay: true,
  intradayLiqRequireHtfAlign: true,
  intradayLiqMinHtfSep: 0.0008,
  intradayLiqEntryAtSignalClose: true,
  /** Backtest/live `time_stop` after this many closed bars (15m default ≈ 12h). 0 = off. */
  intradayLiqMaxHoldBars: 48,
  /** Cap TP2 at this R multiple when opposing pool is farther (0 = uncapped). */
  intradayLiqMaxTpRr: 5,
  intradayRequireSessionReclaim: false,
  intradayRequireFibOrVp: false,
  intradayMinTechniqueCount: 1,
  srIntradayMinScore: 5,
  srIntradayMaxTradesPerDay: 3,
  srIntradayMinBarGap: 4,
  supertrendFuturesFixedTpPct: 0,
  supertrendFuturesFixedSlPct: 0,
  /** 0% = structure brackets from sweep wick + opposing pool, not panel fixed %. */
  supertrendFuturesUseFixedSl: true,
  supertrendFuturesUseFixedTp: true,
  backtestBreakevenAtMfePct: 0,
  intradayLiqBreakevenAfterPartial: true,
  /** Context-aware entry score (displacement + reclaim hold + HTF/level). Validated multi-coin OOS. */
  intradayLiqUseEntryScore: true,
  intradayLiqMinEntryScore: 52,
  intradayLiqReclaimHoldBars: 1,
  /** Classical PDH/PDL reclaim — not LIQ_DAILY trend-router (that preset sets true). */
  intradayLiqBreakdownDayBias: false,
};

/**
 * LIQ_CORE — concept-only classical sweep+reclaim rebuild (2026-07-23).
 * Doctrine: docs/LIQ_CORE_PLAYBOOK.md
 * - Chronological picks (no EOD quality look-ahead)
 * - PDH/PDL + session EQH/EQL; no body/score/CHoCH/V2 binary stacks
 * - Parallel to legacy LIQ_15M / failed LIQ_15M_V2 / FREQ_EDGE
 */
export const INTRADAY_PRO_LIQ_CORE_15M = {
  ...INTRADAY_PRO_LIQ_15M,
  intradayLiqPlaybook: "LIQ_CORE",
  intradayLiqPickMode: "chronological",
  intradayLiqOnePickPerDay: false,
  intradayLiqSessionExtreme: true,
  intradayLiqSessionExtremeMinTouches: 3,
  intradayLiqRejectSameBarReclaim: false,
  intradayLiqMinReclaimBodyRatio: 0,
  intradayLiqMinReclaimClosePct: 0,
  intradayLiqMinSweepExtensionPct: 0,
  intradayLiqMinRr: 1,
  intradayLiqRequireHtfAlign: false,
  intradayLiqUseEntryScore: false,
  intradayLiqUseEntryScoreV2: false,
  intradayLiqMinEntryScore: 0,
  // Path confirm (2026-07-23 P1): wait 2 bars after reclaim — PF 0.53→0.60, freq 7.5→6.4/wk.
  // Still EDGE FAIL; not a live lock. Distinct from rejected dead-trade (post-entry SL compress).
  intradayLiqReclaimHoldBars: 2,
  intradayLiqRequireChoch: false,
  intradayLiqMarketStateGate: false,
  intradayLiqDaySituationBias: false,
  intradayLiqContinuationGate: false,
  intradayLiqSweepQualityGate: false,
  intradayLiqRequireDisplacementV2: false,
  intradayLiqBreakdownDayBias: false,
  intradayLiqVetoCounterTrend: false,
  intradayLiqTrendContinuation: false,
  intradayLiqMaxTradesPerSidePerDay: 2,
  srIntradayMaxTradesPerDay: 4,
  srIntradayMinBarGap: 2,
  intradayLiqMaxHoldBars: 48,
  // Exit geometry (2026-07-23 T1): closer structural TP improves PF/WR without cutting N.
  // Dead-trade compression REJECTED on CORE (clips slow runners). Still EDGE FAIL — not a live lock.
  intradayLiqMaxTpRr: 2,
  intradayLiqMinQuality: 0,
  intradayLiqMinScore: 5,
  // Exit enhance (2026-07-23 W/L): winners need full-size runners; early TP1 partials hurt PF.
  intradayLiqPartialTp: false,
  intradayLiqTp1Enabled: false,
  // X5 (2026-07-23): with TP1 off, BreakevenAfterPartial would still arm beAt1RWithoutPartial
  // and clip runners at 1R (154 BE exits on BNB 3y). Off so full size can reach TP2.
  // Still EDGE FAIL — not a live lock. HOLD ret slightly worse; FULL PF 0.53→0.65.
  intradayLiqBreakevenAfterPartial: false,
};

/** Multi-coin research patch — resolve per symbol via fillLiqSoloPresetDefaults (CORE stays CORE). */
export const INTRADAY_PRO_LIQ_CORE_PORTFOLIO_15M = {
  ...INTRADAY_PRO_LIQ_CORE_15M,
  symbol: "BNBUSDT",
  symbols: ["BNBUSDT", "ETHUSDT", "BTCUSDT"],
};

/**
 * LIQ_ACCEPT — sweep hold-beyond continuation (failed reclaim → trade WITH sweep).
 * BNB-first research preset (2026-07-23). Not certified until WF+MC+gates pass.
 */
export const INTRADAY_PRO_LIQ_ACCEPT_BNB_15M = {
  ...INTRADAY_PRO_LIQ_CORE_15M,
  symbol: "BNBUSDT",
  intradayLiqPlaybook: "LIQ_ACCEPT",
  intradayLiqClassicEnabled: false,
  intradayLiqAcceptEnabled: true,
  intradayLiqAcceptHoldBars: 2,
  intradayLiqReclaimHoldBars: 0,
  intradayLiqMinSweepExtensionPct: 0.003,
  intradayLiqRequireHtfAlign: false,
  intradayLiqBreakdownDayBias: false,
  intradayLiqVetoCounterTrend: false,
};

/**
 * BNB progress-confirm research sleeve (2026-07-23).
 * Stop entry after minR favorable excursion; cancel on level rebreak.
 * PDH/PDL-only (session extremes off). Not a live lock until hard A/B + gates.
 */
export const INTRADAY_PRO_LIQ_BNB_PROGRESS_15M = {
  ...INTRADAY_PRO_LIQ_CORE_15M,
  symbol: "BNBUSDT",
  intradayLiqSessionExtreme: false,
  intradayLiqProgressConfirm: true,
  intradayLiqProgressConfirmWaitBars: 8,
  intradayLiqProgressConfirmMinR: 0.5,
};

/**
 * BNB LIQ research sleeve (2026-07-23 → improve pass).
 * Asia+London + same-bar + toxic + maxSl 0.8% + prem/disc + vol≥1.5 +
 * PDH/PDL only (session extremes OFF).
 * Hard 2023-07→2026-07: FULL ~+28% PF~1.44 @ ~0.27/wk; Y24/Y25/Y26/H12 green.
 * Y23H2 residual ~flat/−1%. Still RESEARCH_SLEEVE_LOW_FREQ (≪2/wk) — not live
 * until WF+MC+gates. Live LIQ solo uses selectIntradayPicks (parity).
 * Decisions: `2026-07-23-liq-bnb-ast-vol15-sleeve.md`,
 * `2026-07-23-liq-bnb-freq-restore-noSess.md`.
 */
export const INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M = {
  ...INTRADAY_PRO_LIQ_CORE_15M,
  symbol: "BNBUSDT",
  intradayLiqSessionNarratives: ["asia_accum", "london_sweep"],
  /** Cover Asia+London; narratives own the session filter. */
  srIntradaySessionStartHour: 0,
  srIntradaySessionEndHour: 24,
  /** Session EQH/EQL off — A/B: lifts FULL and greens early sample vs AST. */
  intradayLiqSessionExtreme: false,
  intradayLiqRequireSameBarReclaim: true,
  intradayLiqDaySituationBias: true,
  intradayLiqMaxSlPct: 0.008,
  intradayLiqRequirePremiumDiscountAlign: true,
  intradayLiqSweepMinVolRatio: 1.5,
  maxDailyLoss: 3,
  maxDailyLossUnit: "PCT",
  riskConsecutiveLossLimit: 3,
};

/**
 * BNB LIQ prepared-cell research sleeve (2026-07-24/25).
 * Guide-gap close: displacement ≥1.2 ATR + MinSl ≥1% + mitigation retest (frac 0.5)
 * + toxic day-situation abstain. Closes ICT steps 3–4 partially (disp + retest entry).
 *
 * Hard (fees+slip): Y1 +14% PF 1.15 @ 1.32/wk; HOLD +3.8% PF 1.03 @ 1.76/wk;
 * FULL 2023-07→2026-07 +12.9% PF 1.04 @ 1.56/wk. Expectancy green Y1+HOLD+FULL.
 * RESEARCH_SLEEVE — tw still &lt;2/wk deploy floor; not live until WF+MC+gates + freq restore.
 * Return-max cousin (hours 0–20 + mitFrac 0.35): FULL ~+60% PF~1.16 @ ~1.5/wk — see decision.
 * Decision: `2026-07-25-liq-bnb-prepared-mit-sleeve.md`.
 */
export const INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_15M = {
  ...INTRADAY_PRO_LIQ_CORE_15M,
  symbol: "BNBUSDT",
  intradayLiqRequireDisplacementV2: true,
  intradayLiqSweepDisplacementMinAtrMult: 1.2,
  intradayLiqMinSlPct: 0.01,
  intradayLiqMitigationEntry: true,
  intradayLiqMitigationFrac: 0.5,
  intradayLiqMitigationWaitBars: 6,
  intradayLiqDaySituationBias: true,
  maxDailyLoss: 3,
  maxDailyLossUnit: "PCT",
  riskConsecutiveLossLimit: 3,
};

/**
 * BNB LIQ prepared return-max research sleeve (2026-07-25).
 * Same prepared physics + hours 0–20 UTC + lighter mitigation frac 0.35.
 * FULL ~+60% PF~1.16 @ ~1.5/wk; Y1/HOLD expectancy green. Lower freq than PREPARED_MIT.
 * RESEARCH_SLEEVE_LOW_FREQ — not live.
 */
export const INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_H020_15M = {
  ...INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_15M,
  intradayLiqMitigationFrac: 0.35,
  intradayLiqMitigationWaitBars: 8,
  intradayLiqActiveHourStart: 0,
  intradayLiqActiveHourEnd: 20,
};

/**
 * BNB LIQ freq-restored research sleeve (2026-07-25).
 * One-sided toxic: abstain BUY-into-breakdown only + mitFrac 0.30 / wait 8 / hours 0–20.
 * Cleared Y1+HOLD tw≥2 with EG; FULL ~+31% PF~1.07 @ ~2.25/wk.
 * RESEARCH_SLEEVE — not live until WF+MC+4-gates.
 * Decision: `2026-07-25-liq-bnb-onesided-freq-restore.md`.
 */
export const INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M = {
  ...INTRADAY_PRO_LIQ_CORE_15M,
  symbol: "BNBUSDT",
  intradayLiqRequireDisplacementV2: true,
  intradayLiqSweepDisplacementMinAtrMult: 1.2,
  intradayLiqMinSlPct: 0.01,
  intradayLiqMitigationEntry: true,
  intradayLiqMitigationFrac: 0.3,
  intradayLiqMitigationWaitBars: 8,
  intradayLiqActiveHourStart: 0,
  intradayLiqActiveHourEnd: 20,
  intradayLiqDaySituationBias: "buy_breakdown",
  // Compressed-regime stand-down (14d/100d avg daily-range). Hard A/B 2026-07-25:
  // flips every red half green/flat; FULL +22.8% → +64.5% at tw≥2.
  intradayLiqRangeCompressionMin: 0.75,
  // Strong-trend stand-down (never-green SL autopsy → hard A/B 2026-07-25):
  // maxAdx50 clears 4-gates (Calmar 1.17, MC p5 +8.5%); tw ~1.7 FULL / 1.5 OOS.
  intradayLiqMaxAdx: 50,
  maxDailyLoss: 3,
  maxDailyLossUnit: "PCT",
  riskConsecutiveLossLimit: 3,
};

/**
 * BNB LIQ one-sided return-max cousin (sell_breakout + disp 1.1 ATR).
 * Y1+HOLD tw≥2 EG; FULL ~+44% PF~1.09 @ ~2.13/wk. RESEARCH_SLEEVE — not live.
 */
export const INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_SELLBO_15M = {
  ...INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M,
  intradayLiqDaySituationBias: "sell_breakout",
  intradayLiqMitigationFrac: 0.35,
  intradayLiqMitigationWaitBars: 8,
  intradayLiqSweepDisplacementMinAtrMult: 1.1,
};

export const INTRADAY_PRO_LIQ_ACCEPT_SIGNATURE_KEYS = [
  "intradayLiqPlaybook",
  "intradayLiqClassicEnabled",
  "intradayLiqAcceptEnabled",
  "intradayLiqAcceptHoldBars",
  "intradayLiqMinSweepExtensionPct",
  "intradayLiqMaxTpRr",
  "intradayLiqPartialTp",
  "intradayLiqTp1Enabled",
];

export const INTRADAY_PRO_LIQ_CORE_SIGNATURE_KEYS = [
  "intradayLiqPlaybook",
  "intradayLiqPickMode",
  "intradayLiqOnePickPerDay",
  "intradayLiqSessionExtreme",
  "intradayLiqRejectSameBarReclaim",
  "intradayLiqMinReclaimBodyRatio",
  "intradayLiqMinRr",
  "intradayLiqUseEntryScore",
  "intradayLiqPartialTp",
  "intradayLiqTp1Enabled",
  "intradayLiqBreakevenAfterPartial",
  "intradayLiqMaxTpRr",
  "intradayLiqReclaimHoldBars",
];

/**
 * LIQ v2 — context-driven classical sweep+reclaim (market state, sweep quality,
 * continuation room, expanded liquidity hierarchy, entry score v2).
 * OOS validation (research-liq-feature-expectancy.mjs) FAILED promotion gates —
 * too many binary filters destroyed recall. Use RESEARCH preset + feature analysis instead.
 */
export const INTRADAY_PRO_LIQ_15M_V2 = {
  ...INTRADAY_PRO_LIQ_15M,
  intradayLiqLevels: "daily,weekly,asian",
  intradayLiqMarketStateGate: true,
  intradayLiqDaySituationBias: true,
  intradayLiqContinuationGate: true,
  intradayLiqMinContinuationR: 1.2,
  intradayLiqMaxDailyRangeUsedPct: 0.78,
  intradayLiqSweepQualityGate: true,
  intradayLiqMaxSweepVelocityAtr: 0.85,
  intradayLiqMinSweepVelocityAtr: 0.02,
  intradayLiqMaxSweepAttempts: 4,
  intradayLiqMaxAbsorptionProxy: 0.72,
  intradayLiqUseEntryScoreV2: true,
  intradayLiqUseEntryScore: false,
  intradayLiqMinEntryScore: 58,
  intradayLiqRequireDisplacementV2: false,
  intradayLiqUseHtfPools: false,
};

/**
 * LIQ research — full feature extraction, NO binary context gates.
 * Score-only path for empirical feature→expectancy analysis (export CSV, not production).
 */
export const INTRADAY_PRO_LIQ_15M_RESEARCH = {
  ...INTRADAY_PRO_LIQ_15M,
  intradayLiqLevels: "daily,weekly,asian",
  intradayLiqUseEntryScoreV2: true,
  intradayLiqUseEntryScore: false,
  intradayLiqMinEntryScore: 45,
  intradayLiqMarketStateGate: false,
  intradayLiqDaySituationBias: false,
  intradayLiqContinuationGate: false,
  intradayLiqSweepQualityGate: false,
  intradayLiqRequireDisplacementV2: false,
  intradayLiqUseHtfPools: false,
};

/**
 * Candidate harvest — every sweep+reclaim with features + forward labels (no selection gates).
 */
export const INTRADAY_PRO_LIQ_CANDIDATE_HARVEST = {
  ...INTRADAY_PRO_LIQ_15M,
  intradayLiqHarvestMode: true,
  intradayLiqMinimalCandidate: true,
  intradayLiqLevels: "daily,weekly,asian",
  intradayLiqUseEntryScoreV2: true,
  intradayLiqUseEntryScore: false,
  intradayLiqMinEntryScore: 0,
  intradayLiqMinRr: 0,
  intradayLiqRequireHtfAlign: false,
  intradayLiqFirstCycleOnly: false,
  intradayLiqMarketStateGate: false,
  intradayLiqDaySituationBias: false,
  intradayLiqContinuationGate: false,
  intradayLiqSweepQualityGate: false,
  intradayLiqRequireDisplacementV2: false,
  intradayLiqUseHtfPools: false,
  intradayLiqMaxFadeDayRangePct: 0,
  intradayLiqPostDisplacementCooldownBars: 0,
  intradayLiqMinReclaimBodyRatio: 0,
  intradayLiqMinReclaimClosePct: 0,
  intradayLiqMinWickRatio: 0,
};

/**
 * Multi-coin LIQ portfolio — BNB + BTC only (Jan–May 2026 research).
 * ETH/SOL/XRP LIQ solo gates were net-negative OOS; do not add without re-validation.
 * ~+11% combined @ 3.5% risk/coin (1k each), ~0.07%/day — NOT 2%/day; best SR_INTRADAY path found.
 * BNB solo LIQ: ~+17% IS / ~+0.5% OOS (May 2026, 1 trade) @ 2.5% risk.
 */
export const INTRADAY_PRO_LIQ_PORTFOLIO_15M = {
  ...INTRADAY_PRO_LIQ_15M,
  riskPerTrade: 3.5,
  futuresLeverage: 12,
  universeCustomSymbols: ["BNBUSDT", "BTCUSDT"],
  universeCoinBase: "CUSTOM",
  universeCoinSelectMode: "MULTIPLE",
  multiBudgetSplitMode: "EQUAL",
  multiCoinCapitalSizingActive: true,
  backtestApplyLiveMultiCoinSplit: true,
};

/**
 * ETHUSDT 15m — classical SWEEP_RECLAIM fade + trail exit.
 * Entry: PDH/PDL + session extremes; structural day veto + context score.
 * Fake-breakout filters: sweep poke wick, vol spike, reclaim close penetration,
 * sweep attempt cap — not post-reclaim displacement (killed frequency with no WR lift).
 */
export const INTRADAY_PRO_LIQ_ETH_15M = {
  ...INTRADAY_PRO_LIQ_15M,
  symbol: "ETHUSDT",
  timeframe: "15m",
  riskPerTrade: 3.5,
  srIntradaySweepPct: 0.001,
  intradayLiqMinSweepExtensionPct: 0.004,
  intradayLiqMinRr: 0,
  intradayLiqMinReclaimBodyRatio: 0.35,
  intradayLiqMinReclaimClosePct: 0.0002,
  intradayLiqMinScore: 5,
  intradayLiqMinQuality: 0,
  intradayLiqRequireHtfAlign: false,
  intradayLiqVetoCounterTrend: true,
  intradayLiqBreakdownDayBias: true,
  intradayLiqEntryMode: "fade",
  intradayLiqPdhPdlOnly: false,
  intradayLiqMinAdx: 0,
  intradayLiqMaxAdx: 0,
  intradayLiqMaxTpRr: 3.35,
  intradayLiqSessionExtreme: true,
  intradayLiqSessionExtremeMinTouches: 2,
  intradayLiqSessionExtremeMinExtensionPct: 0.001,
  intradayLiqOnePickPerDay: false,
  srIntradayMaxTradesPerDay: 3,
  intradayLiqAllowTrailOnlyExit: true,
  trailingStopLossAuto: true,
  trailOnlyAfterTp2Fill: false,
  intradayLiqPartialTp: false,
  intradayLiqTp1Enabled: false,
  intradayLiqTp2Enabled: false,
  intradayLiqMaxHoldBars: 200,
  intradayLiqMaxFadeDayRangePct: 0.06,
  intradayLiqPostDisplacementCooldownBars: 4,
  intradayLiqDisplacementBarAtrMult: 2,
  intradayLiqRequireSweepDisplacement: false,
  intradayLiqTrailRequireDisplacement: false,
  intradayLiqSweepDisplacementMinAtrMult: 0,
  intradayLiqRequirePostReclaimDisplacement: false,
  intradayLiqPostReclaimDispAtrMult: 0.6,
  intradayLiqMinSweepPokeWickRatio: 0.2,
  intradayLiqSweepMinVolRatio: 0.9,
  intradayLiqSweepQualityGate: false,
  intradayLiqMaxSweepAttempts: 3,
  intradayLiqMaxAbsorptionProxy: 0.7,
  intradayLiqUseEntryScore: false,
  intradayLiqTrailUseContextScore: true,
  intradayLiqMinEntryScore: 38,
  intradayLiqReclaimHoldBars: 0,
  backtestTrailMicroTf: "5m",
};

/**
 * LIQ + VP confluence — liquidity sweep TRIGGER, VP LOCATION filter (textbook stack).
 * Both gates on → evaluateIntradayBar composite path (not LIQ solo fast path).
 * minTechniqueCount=2 requires scored tags from BOTH liquidity and VP gates.
 */
export const LIQ_VP_CONFLUENCE_CORE = {
  intradayLiqPlaybook: "LIQ_VP_CONFLUENCE",
  intradayGateLiquidity: true,
  intradayGateSession: false,
  intradayGateVp: true,
  intradayGateFib: false,
  intradayGateOrderFlow: false,
  intradayGateHtfRegime: false,
  intradayLearnedRulesEnabled: false,
  volumeProfileEnabled: true,
  volumeProfileSoftGates: true,
  volumeProfileGatesEnabled: false,
  intradayVpBrackets: true,
  vpProfileMode: "rolling",
  vpLookbackBars: 384,
  vpVolumeDistribute: "close_weighted",
  vpIncludePriorSession: true,
  vpEnableNakedPoc: true,
  vpBreakoutUsePriorSession: true,
  vpValueAreaPct: 0.7,
  vpMinRR: 1.35,
  requireVpSetup: false,
  intradayMinTechniqueCount: 2,
  intradayRequireFibOrVp: true,
  intradayRequireLiqOrSession: true,
  intradayRequireSessionReclaim: false,
  intradayDualGateMinScore: 7,
  intradayLiqStrictMode: true,
};

/** BNB 15m — LIQ partial @1R + VP edge confluence at sweep level */
export const INTRADAY_PRO_LIQ_VP_CONFLUENCE_BNB_15M = {
  ...INTRADAY_PRO_LIQ_15M,
  ...LIQ_VP_CONFLUENCE_CORE,
  symbol: "BNBUSDT",
  timeframe: "15m",
  intradayLiqBreakdownDayBias: false,
  intradayLiqOnePickPerDay: false,
  srIntradayMaxTradesPerDay: 3,
  srIntradayMinScore: 8,
};

/** ETH 15m — LIQ trail exit + VP confluence on entry */
export const INTRADAY_PRO_LIQ_VP_CONFLUENCE_ETH_15M = {
  ...INTRADAY_PRO_LIQ_ETH_15M,
  ...LIQ_VP_CONFLUENCE_CORE,
  symbol: "ETHUSDT",
  timeframe: "15m",
};

export const INTRADAY_PRO_LIQ_VP_CONFLUENCE_PORTFOLIO_15M = {
  ...INTRADAY_PRO_LIQ_VP_CONFLUENCE_BNB_15M,
  riskPerTrade: 2.5,
  futuresLeverage: 12,
  universeCustomSymbols: ["BNBUSDT", "ETHUSDT"],
  universeCoinBase: "CUSTOM",
  universeCoinSelectMode: "MULTIPLE",
  multiBudgetSplitMode: "EQUAL",
  multiCoinCapitalSizingActive: true,
  backtestApplyLiveMultiCoinSplit: true,
};

export function resolveLiqVpConfluencePreset(symbol) {
  const sym = String(symbol ?? "").toUpperCase();
  if (sym === "ETHUSDT") return INTRADAY_PRO_LIQ_VP_CONFLUENCE_ETH_15M;
  return INTRADAY_PRO_LIQ_VP_CONFLUENCE_BNB_15M;
}

/**
 * LIQ + VP proximity — keep LIQ solo fast path; veto sweeps far from VP structure.
 * One change vs baseline: `intradayLiqVpProximityMaxPct` (sweep level near POC/VAH/VAL/HVN).
 */
export const LIQ_VP_PROXIMITY_CORE = {
  intradayLiqPlaybook: "LIQ_VP_PROXIMITY",
  intradayLiqVpProximityMaxPct: 0.0015,
  volumeProfileEnabled: true,
  vpProfileMode: "rolling",
  vpLookbackBars: 384,
  vpVolumeDistribute: "close_weighted",
  vpIncludePriorSession: true,
  vpEnableNakedPoc: true,
  vpBreakoutUsePriorSession: true,
  vpValueAreaPct: 0.7,
  intradayGateLiquidity: true,
  intradayGateSession: false,
  intradayGateVp: false,
  intradayGateFib: false,
  intradayGateOrderFlow: false,
  intradayGateHtfRegime: false,
};

export const INTRADAY_PRO_LIQ_VP_PROXIMITY_BNB_15M = {
  ...INTRADAY_PRO_LIQ_15M,
  ...LIQ_VP_PROXIMITY_CORE,
  symbol: "BNBUSDT",
  timeframe: "15m",
};

export const INTRADAY_PRO_LIQ_VP_PROXIMITY_ETH_15M = {
  ...INTRADAY_PRO_LIQ_ETH_15M,
  ...LIQ_VP_PROXIMITY_CORE,
  symbol: "ETHUSDT",
  timeframe: "15m",
};

export const INTRADAY_PRO_LIQ_VP_PROXIMITY_PORTFOLIO_15M = {
  ...INTRADAY_PRO_LIQ_VP_PROXIMITY_BNB_15M,
  riskPerTrade: 2.5,
  futuresLeverage: 12,
  universeCustomSymbols: ["BNBUSDT", "ETHUSDT"],
  universeCoinBase: "CUSTOM",
  universeCoinSelectMode: "MULTIPLE",
  multiBudgetSplitMode: "EQUAL",
  multiCoinCapitalSizingActive: true,
  backtestApplyLiveMultiCoinSplit: true,
};

export function resolveLiqVpProximityPreset(symbol, proximityPct = 0.0015) {
  const sym = String(symbol ?? "").toUpperCase();
  const base = sym === "ETHUSDT" ? INTRADAY_PRO_LIQ_VP_PROXIMITY_ETH_15M : INTRADAY_PRO_LIQ_VP_PROXIMITY_BNB_15M;
  return { ...base, intradayLiqVpProximityMaxPct: proximityPct };
}

/**
 * BTCUSDT 15m — research-promoted PDH/PDL sweep+reclaim (BTC-only; do not multi-coin).
 * Autopsy 2025: only positive LIQ coin (+7.9% baseline); losers fade breakdown/breakout days.
 * Structural gates: breakdown-day veto, CHoCH after sweep, London/NY killzone, PDH/PDL only.
 * Research-grade — not SUPERTREND_ELITE validation-gate approved.
 */
export const INTRADAY_PRO_LIQ_BTC_15M = {
  ...INTRADAY_PRO_LIQ_15M,
  symbol: "BTCUSDT",
  timeframe: "15m",
  riskPerTrade: 2,
  intradayLiqPdhPdlOnly: true,
  intradayLiqSessionExtreme: false,
  intradayLiqBreakdownDayBias: true,
  intradayLiqDaySituationBias: true,
  intradayLiqMarketStateGate: false,
  intradayLiqRequireKillzone: false,
  /** CHoCH after sweep — 0 trades on 2025 BTC autopsy; keep off until re-tuned. */
  intradayLiqRequireChoch: false,
  intradayLiqChochRequireTrend: false,
  intradayLiqChochMaxBars: 12,
  intradayLiqMinSweepExtensionPct: 0.008,
  intradayLiqMinRr: 1.5,
  intradayLiqUseEntryScore: true,
  intradayLiqMinEntryScore: 52,
  intradayLiqReclaimHoldBars: 1,
  intradayLiqOnePickPerDay: true,
  srIntradayMaxTradesPerDay: 2,
};

/** Shared knobs — classical fade only; trend continuation rejected (PF ~0.09–0.25 on BTC). */
export const LIQ_FREQ_EDGE_CORE = {
  intradayLiqPlaybook: "FREQ_EDGE",
  intradayLiqTrendContinuation: false,
  intradayLiqClassicEnabled: true,
  intradayLiqBreakdownDayBias: true,
  intradayLiqVetoCounterTrend: true,
};

/**
 * LIQ FREQ_EDGE — BNB 15m classical sweep+reclaim.
 * BNB autopsy: breakdown-day fades are profitable (70% WR on breakdown days);
 * do NOT apply breakdown veto on BNB (veto collapses 75→3 trades on full window).
 */
export const INTRADAY_PRO_LIQ_FREQ_EDGE_BNB_15M = {
  ...INTRADAY_PRO_LIQ_15M,
  ...LIQ_FREQ_EDGE_CORE,
  intradayLiqBreakdownDayBias: false,
  symbol: "BNBUSDT",
  timeframe: "15m",
  intradayLiqOnePickPerDay: false,
  srIntradayMaxTradesPerDay: 3,
  intradayLiqPartialTp: true,
  intradayLiqTp1Enabled: true,
  intradayLiqTp2Enabled: true,
  intradayLiqSessionExtreme: false,
};

/**
 * LIQ FREQ_EDGE — ETH 15m classical fade + trail (session levels for breadth).
 * Trail path validated for frequency; gates still block trend-day counter-fades.
 */
export const INTRADAY_PRO_LIQ_FREQ_EDGE_ETH_15M = {
  ...INTRADAY_PRO_LIQ_ETH_15M,
  ...LIQ_FREQ_EDGE_CORE,
  intradayLiqTrendContinuation: false,
  intradayLiqClassicEnabled: true,
};

/** LIQ FREQ_EDGE — BTC 15m (low frequency by design; research-only, not portfolio leg). */
export const INTRADAY_PRO_LIQ_FREQ_EDGE_BTC_15M = {
  ...INTRADAY_PRO_LIQ_BTC_15M,
  ...LIQ_FREQ_EDGE_CORE,
  intradayLiqTrendContinuation: false,
  intradayLiqClassicEnabled: true,
};

/** Multi-coin deploy patch — BNB + ETH; per-symbol tuning via fillLiqSoloPresetDefaults. */
export const INTRADAY_PRO_LIQ_FREQ_EDGE_PORTFOLIO_15M = {
  ...INTRADAY_PRO_LIQ_FREQ_EDGE_BNB_15M,
  riskPerTrade: 2.5,
  futuresLeverage: 12,
  universeCustomSymbols: ["BNBUSDT", "ETHUSDT"],
  universeCoinBase: "CUSTOM",
  universeCoinSelectMode: "MULTIPLE",
  multiBudgetSplitMode: "EQUAL",
  multiCoinCapitalSizingActive: true,
  backtestApplyLiveMultiCoinSplit: true,
};

/** Resolve FREQ_EDGE preset for a symbol (backtest + fillLiqSolo routing). */
export function resolveLiqFreqEdgePreset(symbol) {
  const sym = String(symbol ?? "").toUpperCase();
  if (sym === "ETHUSDT") return INTRADAY_PRO_LIQ_FREQ_EDGE_ETH_15M;
  if (sym === "BTCUSDT") return INTRADAY_PRO_LIQ_FREQ_EDGE_BTC_15M;
  return INTRADAY_PRO_LIQ_FREQ_EDGE_BNB_15M;
}

/**
 * User-tuned ETH LIQ fields — always restored from saved cfg after materialize
 * so backtest/save never clobber panel edits with preset defaults.
 */
export const ETH_LIQ_USER_TUNING_KEYS = Object.freeze([
  "intradayLiqMinRr",
  "intradayLiqMinReclaimBodyRatio",
  "intradayLiqMinReclaimClosePct",
  "intradayLiqMinQuality",
  "intradayLiqMinScore",
  "intradayLiqMinSweepExtensionPct",
  "intradayLiqRequireHtfAlign",
  "intradayLiqMinHtfSep",
  "intradayLiqVetoCounterTrend",
  "intradayLiqEntryMode",
  "intradayLiqPdhPdlOnly",
  "intradayLiqMinAdx",
  "intradayLiqMaxAdx",
  "intradayLiqAllowTrailOnlyExit",
  "intradayLiqRequireSweepDisplacement",
  "intradayLiqSweepDisplacementMinAtrMult",
  "intradayLiqRequirePostReclaimDisplacement",
  "intradayLiqPostReclaimDispAtrMult",
  "intradayLiqSweepMinVolRatio",
  "intradayLiqMinSweepPokeWickRatio",
  "intradayLiqSweepQualityGate",
  "intradayLiqMaxSweepAttempts",
  "intradayLiqMaxAbsorptionProxy",
  "intradayLiqTrailRequireDisplacement",
  "intradayLiqBreakdownDayBias",
  "intradayLiqMinEntryScore",
  "intradayLiqReclaimHoldBars",
  "intradayLiqTrailUseContextScore",
  "backtestTrailMicroTf",
  "intradayLiqMaxTpRr",
  "intradayLiqMaxFadeDayRangePct",
  "intradayLiqPostDisplacementCooldownBars",
  "intradayLiqDisplacementBarAtrMult",
  "intradayLiqSessionExtreme",
  "intradayLiqSessionExtremeMinTouches",
  "intradayLiqSessionExtremeMinExtensionPct",
  "intradayLiqOnePickPerDay",
  "srIntradayMaxTradesPerDay",
  "srIntradaySweepPct",
  "intradayLiqPartialFrac",
  "intradayLiqTp1Rr",
  "intradayLiqTp2Rr",
  "intradayLiqTp2PartialFrac",
  "intradayLiqTp1Enabled",
  "intradayLiqPartialTp",
  "intradayLiqTp2Enabled",
  "intradayLiqMaxHoldBars",
  "intradayLiqBreakevenAfterPartial",
  "trailOnlyAfterTp2Fill",
  "riskPerTrade",
  "riskPerTradeUnit",
]);

/**
 * @deprecated Prefer ETH_LIQ_USER_TUNING_KEYS — legacy name kept for scripts.
 * Only used for fill-when-undefined inside repairStaleEthLiqCfg (not force-overwrite).
 */
export const ETH_LIQ_MATERIALIZE_KEYS = ETH_LIQ_USER_TUNING_KEYS;

/** SMC/SR keys that pollute ETH LIQ solo backtests when left over from a prior engine mode. */
const ETH_LIQ_SOLO_POLLUTION_KEYS = [
  "intradaySmcMinRr",
  "intradaySmcRequireMss",
  "intradaySmcRequireRetrace",
  "intradaySrRequireBos",
  "intradaySrRequireConfirm",
  "intradaySrRequireVolume",
  "intradaySrRequireHtfTrend",
  "intradaySrAPlusMode",
];

function isEthLiqSoloCfg(cfg = {}) {
  const sym = String(cfg.symbol ?? "").toUpperCase();
  if (sym !== "ETHUSDT") return false;
  const gates = resolveIntradayGates(cfg);
  const liqSolo =
    (gates.liquidity || gates.session) &&
    !gates.fib &&
    !gates.vp &&
    !gates.orderFlow &&
    !gates.htfRegime;
  const instSolo =
    (cfg.intradaySrAPlusMode === true || gates.institutionalSr) &&
    (gates.liquidity || gates.session) &&
    !gates.fib &&
    !gates.vp &&
    !gates.orderFlow;
  return liqSolo && !instSolo;
}

/** Copy explicit user tuning from saved cfg (panel / strategy version). */
export function pickEthLiqUserTuning(cfg = {}) {
  if (!isEthLiqSoloCfg(cfg)) return {};
  const out = {};
  for (const key of ETH_LIQ_USER_TUNING_KEYS) {
    if (INSTANCE_PRESET_SKIP.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(cfg, key) || cfg[key] === undefined) continue;
    if (key === "intradayLiqMaxHoldBars" && cfg[key] === 0) continue;
    if (key === "intradayLiqMinReclaimBodyRatio" && cfg[key] === 0) continue;
    if (key === "intradayLiqMinQuality" && cfg[key] === 0) continue;
    if (key === "trailOnlyAfterTp2Fill" && cfg[key] === true) continue;
    out[key] = cfg[key];
  }
  return out;
}

/**
 * Fill missing ETH LIQ defaults and repair legacy corrupt sentinels (hold=0, body=0).
 * Does NOT overwrite explicit user edits saved after applying the preset.
 *
 * @param {object} cfg — cfg after fillLiqSoloPresetDefaults
 * @param {object} [incoming] — original cfg before materialization (for sentinel detection)
 */
export function repairStaleEthLiqCfg(cfg = {}, incoming = cfg) {
  if (!isEthLiqSoloCfg(cfg)) return cfg;
  const out = { ...cfg };
  const preset = INTRADAY_PRO_LIQ_ETH_15M;
  const src = incoming && typeof incoming === "object" ? incoming : cfg;

  for (const key of ETH_LIQ_MATERIALIZE_KEYS) {
    if (INSTANCE_PRESET_SKIP.has(key)) continue;
    if (out[key] !== undefined) continue;
    if (Object.prototype.hasOwnProperty.call(preset, key)) out[key] = preset[key];
    else if (Object.prototype.hasOwnProperty.call(INTRADAY_PRO_LIQ_15M, key)) {
      out[key] = INTRADAY_PRO_LIQ_15M[key];
    }
  }

  if (src.intradayLiqMaxHoldBars === 0) {
    out.intradayLiqMaxHoldBars = preset.intradayLiqMaxHoldBars;
  }
  if (src.intradayLiqMinReclaimBodyRatio === 0) {
    out.intradayLiqMinReclaimBodyRatio = preset.intradayLiqMinReclaimBodyRatio;
  }
  if (src.intradayLiqMinQuality === 0) {
    out.intradayLiqMinQuality = preset.intradayLiqMinQuality;
  }
  if (src.trailOnlyAfterTp2Fill === true) {
    out.trailOnlyAfterTp2Fill = false;
  }

  /** Trail-only LIQ disables minRr and turns edge into SL vs scratch — restore partial ladder. */
  const trailOnlyLiq =
    (src.trailingStopLossAuto === true || out.trailingStopLossAuto === true) &&
    out.intradayLiqPartialTp === false &&
    out.intradayLiqTp1Enabled === false &&
    out.intradayLiqTp2Enabled === false;
  if (trailOnlyLiq && out.intradayLiqAllowTrailOnlyExit === true) {
    out.trailingStopLossAuto = true;
    out.intradayLiqPartialTp = false;
    out.intradayLiqTp1Enabled = false;
    out.intradayLiqTp2Enabled = false;
    out.trailOnlyAfterTp2Fill = false;
  } else if (trailOnlyLiq && out.intradayLiqAllowTrailOnlyExit !== true) {
    out.trailingStopLossAuto = false;
    const ladderPreset = INTRADAY_PRO_LIQ_15M;
    out.intradayLiqPartialTp = ladderPreset.intradayLiqPartialTp ?? true;
    out.intradayLiqTp1Enabled = ladderPreset.intradayLiqTp1Enabled ?? true;
    out.intradayLiqTp2Enabled = ladderPreset.intradayLiqTp2Enabled ?? true;
    out.intradayLiqBreakevenAfterPartial = ladderPreset.intradayLiqBreakevenAfterPartial ?? true;
    out.trailOnlyAfterTp2Fill = false;
  }

  if (out.intradayLiqVetoCounterTrend !== true && src.intradayLiqVetoCounterTrend !== false) {
    out.intradayLiqVetoCounterTrend = true;
  }
  if (
    (out.intradayLiqMinReclaimClosePct == null || out.intradayLiqMinReclaimClosePct === 0) &&
    src.intradayLiqMinReclaimClosePct !== 0
  ) {
    out.intradayLiqMinReclaimClosePct = preset.intradayLiqMinReclaimClosePct;
  }

  if (!isSmcIctEngineActive(out)) {
    for (const key of ETH_LIQ_SOLO_POLLUTION_KEYS) delete out[key];
  }

  return out;
}

/** @deprecated Use repairStaleEthLiqCfg — kept for scripts that imported the old name. */
export function applyEthLiqPresetMaterialization(cfg = {}, incoming = cfg) {
  return repairStaleEthLiqCfg(cfg, incoming);
}

/**
 * Institutional A+ S/R — HTF trend + daily/weekly zones + sweep + BOS + confirmation + volume.
 * BNB 15m; tune via npm run backtest:liq-funnel
 */
export const INTRADAY_PRO_SR_APLUS_15M = {
  ...INTRADAY_PRO_LIQ_15M,
  intradaySrAPlusMode: true,
  intradayGateInstitutionalSr: true,
  intradayGateLiquidity: true,
  intradayGateSession: true,
  intradayGateHtfRegime: true,
  intradayGateFib: false,
  intradayGateVp: false,
  intradayGateOrderFlow: false,
  intradayLearnedRulesEnabled: false,
  intradayLiqMinSweepExtensionPct: 0.004,
  intradayLiqMinRr: 2.0,
  intradaySrMinVolRatio: 1.15,
  intradaySrRequireBos: true,
  intradaySrRequireConfirm: true,
  intradaySrRequireVolume: true,
  intradaySrRequireHtfTrend: false,
  intradaySrMinHtfSep: 0,
  intradaySrZoneWidthPct: 0.002,
  intradaySrBosMaxBarsAfterReclaim: 3,
  intradaySrBosSwingLookback: 12,
  intradaySrMinConfirmWick: 0.28,
  intradaySrUseSwingClusters: false,
  intradayLiqMinScore: 6,
  intradayLiqOnePickPerDay: true,
  srIntradayMaxTradesPerDay: 3,
  srIntradayMinBarGap: 4,
};

/**
 * LIQ daily target — strict classical PDH/PDL (LIQ_15M base) + trend continuation
 * on breakdown/breakout days when PDH/PDL sweep+reclaim does not fire.
 */
export const INTRADAY_PRO_LIQ_DAILY_15M = {
  ...INTRADAY_PRO_LIQ_15M,
  intradayLiqTrendContinuation: true,
  intradayLiqTrendOnlyBreakdownDays: true,
  intradayLiqClassicOnTrendDays: false,
  intradayLiqVetoCounterTrend: true,
  intradayLiqBreakdownDayBias: true,
  intradayLiqTrendFadeEma: 21,
  intradayLiqTrendMinAdx: 18,
  intradayLiqClassicEnabled: false,
  intradayLiqTrendMinRvol: 0.9,
  intradayLiqTrendFadeMinRvol: 0.65,
  intradayLiqTrendMinBarsBeyondLevel: 4,
  intradayLiqTrendMinDispAtr: 0.42,
  intradayLiqTrendDisplacementOnly: true,
  intradayLiqTrendFadeHighAdxMin: 38,
  intradayLiqTrendRsiMinShort: 28,
  intradayLiqTrendRsiMaxShort: 58,
  intradayLiqTrendAtrFallback: true,
  intradayLiqTrendAtrTpMult: 2.0,
  intradayLiqTrendAtrMinRr: 1.25,
  intradayLiqTrendFadeMaxDayRangePct: 0.04,
  intradayLiqTrendKillzone: "ALL",
  intradayLiqTrendSellOnly: true,
  intradayLiqMinScore: 9,
};

/**
 * SMC/ICT solo — BNB 15m Jan–May 2026 tuned default (per_signal, sweep profile):
 * CHoCH off, 24/7 kill-zone, EMA HTF bias — ~69 entries, ~48% WR, ~+32% @ 2.5% risk.
 * Stricter ICT-audit stack (CHoCH + LONDON_NY + parallel HTF): ~56 entries, ~32% WR, ~-25%.
 * Re-tune: node scripts/backtest-smc-legacy-gate-parity.mjs / backtest-smc-ict-tune.mjs
 */
export const INTRADAY_PRO_ICT_15M = {
  ...INTRADAY_PRO_LIQ_15M,
  symbol: "BNBUSDT",
  timeframe: "15m",
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
  intradayLearnedRulesEnabled: false,
  supertrendHtf4hEnabled: false,
  intradayLiqStrictMode: true,
  intradayLiqMinSweepExtensionPct: 0.003,
  intradayLiqMinRr: 1.5,
  intradayLiqSessionExtreme: true,
  intradayLiqPartialTp: true,
  intradayLiqOnePickPerDay: false,
  intradaySmcMinScore: 7,
  intradaySmcIctProfile: "sweep",
  intradaySmcPickMode: "per_signal",
  intradaySmcOneTradePerDay: false,
  intradayLiqOnePickPerDay: false,
  intradaySmcChochStrict: false,
  intradaySmcChochRequireTrend: false,
  intradaySmcRequireMss: false,
  intradaySmcRequireRetrace: false,
  intradaySmcRequireFvgRetrace: false,
  intradaySmcRequireChoch: false,
  intradaySmcRequireBos: false,
  intradaySmcRequireConfirm: false,
  intradaySmcLookbackBars: 36,
  intradaySmcMinRr: 1.5,
  intradaySmcBosMaxBars: 10,
  intradaySmcChochMaxBars: 10,
  intradaySmcEntryZoneMode: "EITHER",
  intradaySmcKillzoneMode: "ALL",
  intradaySmcHtfBiasMode: "ema",
  intradaySmcMinAdx: 12,
  intradaySmcHtfStrictness: "either",
  srIntradayMaxTradesPerDay: 5,
  intradaySmcRequireHtfBias: true,
  intradaySmcSlMode: "structure",
  // Intraday exit horizon — cap TP at a realistic R and force same-day-ish closes
  // so a single runner can't ride for weeks and starve all subsequent setups
  // (without this, one trade held for ~118 days and blocked every other entry).
  intradaySmcMaxTpRr: 5,
  intradaySmcMaxHoldBars: 48,
  intradayLiqTp1Enabled: true,
  intradayLiqBreakevenAfterPartial: true,
  intradayRequireSessionReclaim: false,
  intradayRequireFibOrVp: false,
  intradayMinTechniqueCount: 1,
  srIntradayMinScore: 7,
  srIntradayMaxTradesPerDay: 5,
  srIntradayMinBarGap: 4,
  supertrendFuturesUseFixedSl: true,
  supertrendFuturesUseFixedTp: true,
  supertrendFuturesFixedSlPct: 0,
  supertrendFuturesFixedTpPct: 0,
};

/**
 * Frozen research preset — positive expectancy in-sample (+0.27R/trade, n=11, Jan–May 2026).
 * CHoCH + FVG CE + internal TP2 + minR:R 1.5 + session extreme ON (frequency).
 * NOT production — deploy at minimal size for data collection only; do not tune.
 */
export const INTRADAY_PRO_ICT_RESEARCH_15M = {
  ...INTRADAY_PRO_ICT_15M,
  intradaySmcRequireChoch: true,
  intradaySmcRequireRetrace: true,
  intradaySmcFvgEntryMode: "midpoint",
  intradaySmcEntryZoneMode: "FVG",
  intradaySmcChochStrict: false,
  intradaySmcTp2Mode: "internal",
  intradaySmcMinRr: 1.5,
  intradayLiqSessionExtreme: true,
};

/**
 * Same frozen research stack on 1H — better PDH/PDL geometry vs 15m.
 * Parallel backtest: node scripts/backtest-smc-ict-research-1h.mjs
 */
export const INTRADAY_PRO_ICT_RESEARCH_1H = {
  ...INTRADAY_PRO_ICT_RESEARCH_15M,
  symbol: "BNBUSDT",
  timeframe: "1h",
  intradaySmcLookbackBars: 24,
  intradaySmcMaxHoldBars: 72,
  intradaySmcChochMaxBars: 8,
  intradaySmcBosMaxBars: 8,
};

/**
 * @deprecated PDH/PDL-only path — 5 trades/5mo, negative in-sample. Use RESEARCH_15M.
 */
export const INTRADAY_PRO_ICT_PDH_FVG_MID_15M = {
  ...INTRADAY_PRO_ICT_15M,
  intradayLiqSessionExtreme: false,
  intradaySmcRequireChoch: true,
  intradaySmcRequireRetrace: true,
  intradaySmcFvgEntryMode: "midpoint",
  intradaySmcEntryZoneMode: "FVG",
  intradaySmcChochStrict: false,
  intradaySmcTp2Mode: "internal",
  intradaySmcMinRr: 1.2,
};

/**
 * SMC/ICT full stack — BNB 15m Jan–May 2026 baseline (full profile, daily_sniper):
 * ~4 entries, ~75% WR, ~+3.7% @ 2.5% risk (strict ICT — low frequency by design).
 * Sequence: CHoCH → MSS → retrace, London+NY kill-zone, parallel HTF, premium/discount ON.
 * Re-tune: node scripts/backtest-smc-ict-full-baseline.mjs / backtest-smc-ict-tune.mjs
 */
export const INTRADAY_PRO_ICT_FULL_15M = {
  ...INTRADAY_PRO_ICT_15M,
  intradaySmcIctProfile: "full",
  intradaySmcPickMode: "daily_sniper",
  intradaySmcOneTradePerDay: true,
  intradaySmcChochStrict: true,
  intradaySmcRequireMss: true,
  intradaySmcRequireRetrace: true,
  intradaySmcRequireFvgRetrace: true,
  intradaySmcRequireChoch: true,
  intradaySmcRequireBos: true,
  intradaySmcRequireConfirm: false,
  intradaySmcKillzoneMode: "LONDON_NY",
  intradaySmcHtfBiasMode: "parallel",
  intradaySmcHtfStrictness: "both",
  intradaySmcRequireHtfBias: true,
  intradaySmcRequirePremiumDiscount: true,
  intradaySmcPremiumDiscountOte: false,
  intradaySmcDealingRangeLookback: 48,
  intradaySmcMinAdx: 12,
  intradaySmcMinRr: 1.5,
  intradayLiqMinRr: 1.5,
  intradaySmcMinScore: 8,
  srIntradayMaxTradesPerDay: 3,
  intradayLiqOnePickPerDay: true,
  intradayLiqTp1Enabled: true,
  intradayLiqBreakevenAfterPartial: true,
};

/**
 * BTC research: 1H narrative-aligned raid → 15m displacement FVG/OB retrace.
 * 15m CHoCH off (1H is narrative); displacement leg + retrace on; multi entries/day.
 * Not certified — run research-smc-btc-h1-aligned-ab.mjs before any promote claim.
 */
export const INTRADAY_PRO_ICT_H1_ALIGNED_15M = {
  ...INTRADAY_PRO_ICT_15M,
  symbol: "BTCUSDT",
  timeframe: "15m",
  intradaySmcIctProfile: "h1_aligned",
  intradaySmcNarrativeAlignedRaid: true,
  intradaySmcRequireHtfNarrative: true,
  intradaySmcHtfNarrativeStrictness: "soft",
  intradaySmcHtfPoiMode: "none",
  intradaySmcRequireChoch: false,
  intradaySmcRequireMss: false,
  intradaySmcRequireBos: false,
  intradaySmcRequireDisplacementLeg: true,
  intradaySmcRequireRetrace: true,
  intradaySmcRequireFvgRetrace: true,
  intradaySmcDisplacementPdArray: true,
  intradaySmcEntryZoneMode: "EITHER",
  intradaySmcFvgEntryMode: "zone",
  intradaySmcKillzoneMode: "ALL",
  intradaySmcRequirePremiumDiscount: false,
  intradaySmcPickMode: "per_signal",
  intradaySmcOneTradePerDay: false,
  intradayLiqOnePickPerDay: false,
  srIntradayMaxTradesPerDay: 12,
  intradaySmcLookbackBars: 48,
  intradaySmcMaxBarsAfterReclaim: 20,
  intradaySmcMinRr: 1.5,
  intradaySmcSlMode: "pd_array",
  intradaySmcMaxHoldBars: 16,
  intradaySmcHtfBiasMode: "parallel",
  intradaySmcHtfStrictness: "either",
  intradaySmcRequireHtfBias: true,
  intradaySmcEnforceInvalidation: false,
  intradaySmcRequirePdAfterChoch: false,
  intradayLiqMinSweepExtensionPct: 0.002,
  intradaySmcMinScore: 6,
};

/** Higher-frequency fib + liquidity + session + flow (still capped at 3 trades/day). */
export const INTRADAY_PRO_FIB_INTRADAY_15M = {
  ...INTRADAY_PRO_FIB_15M,
  intradayGateLiquidity: true,
  intradayGateSession: true,
  intradayLiqStrictMode: true,
  intradayGateOrderFlow: true,
  intradayFibAnchorEntry: true,
  intradayRequireSessionReclaim: false,
  intradayMinTechniqueCount: 1,
  intradayRequireFibOrVp: false,
  supertrendHtf4hEnabled: false,
};

export const FIB_PROFILE_PRESETS = {
  sniper: {},
  balanced: {
    intradayFibHtfAlignMode: "soft",
    intradayFibRequireHtfAlign: false,
    intradayFibMinLegAtrMult: 2,
    intradayFibMinRr: 1.35,
    intradayFibTpMode: "partial_leg",
    intradayFibPartialLegFrac: 0.42,
    intradayFibMaxBarsSinceSwing: 26,
    intradayFibMinAdx: 18,
    intradayFibMinRetraceRatio: 0.5,
    intradayFibMaxRetraceRatio: 0.72,
    intradayFibGoldenRetraceMin: 0.5,
    intradayFibGoldenRetraceMax: 0.72,
  },
};

/** Merge liquidity-solo defaults when only the liquidity gate is on (backtest + live parity). */
export function fillLiqSoloPresetDefaults(cfg = {}) {
  const gates = resolveIntradayGates(cfg);
  const liqSolo =
    (gates.liquidity || gates.session) &&
    !gates.fib &&
    !gates.vp &&
    !gates.orderFlow &&
    !gates.htfRegime;
  const instSolo =
    (cfg.intradaySrAPlusMode === true || gates.institutionalSr) &&
    (gates.liquidity || gates.session) &&
    !gates.fib &&
    !gates.vp &&
    !gates.orderFlow;
  if (!liqSolo && !instSolo) return cfg;

  const sym = String(cfg.symbol ?? "").toUpperCase();
  const playbook = String(cfg.intradayLiqPlaybook ?? "").toUpperCase();
  const freqEdge = playbook === "FREQ_EDGE";
  const liqCore = playbook === "LIQ_CORE";
  const liqAccept = playbook === "LIQ_ACCEPT";

  // LIQ_CORE: fill missing keys from CORE preset only — do not inject legacy BNB/BTC/ETH stacks.
  if (liqCore && liqSolo && !instSolo) {
    const out = { ...cfg };
    const skipSlTp = new Set(["supertrendFuturesFixedSlPct", "supertrendFuturesFixedTpPct"]);
    const skipHold = new Set(["intradayLiqMaxHoldBars"]);
    for (const [key, val] of Object.entries(INTRADAY_PRO_LIQ_CORE_15M)) {
      if (skipSlTp.has(key) || skipHold.has(key) || INSTANCE_PRESET_SKIP.has(key)) continue;
      if (out[key] === undefined) out[key] = val;
    }
    out.intradayLiqPlaybook = "LIQ_CORE";
    out.intradayLiqPickMode = out.intradayLiqPickMode ?? "chronological";
    out.intradayLiqOnePickPerDay = false;
    out.supertrendFuturesFixedSlPct = 0;
    out.supertrendFuturesFixedTpPct = 0;
    return out;
  }

  // LIQ_ACCEPT: BNB-first hold-beyond continuation — no legacy fade stacks.
  if (liqAccept && liqSolo && !instSolo) {
    const out = { ...cfg };
    const skipSlTp = new Set(["supertrendFuturesFixedSlPct", "supertrendFuturesFixedTpPct"]);
    const skipHold = new Set(["intradayLiqMaxHoldBars"]);
    for (const [key, val] of Object.entries(INTRADAY_PRO_LIQ_ACCEPT_BNB_15M)) {
      if (skipSlTp.has(key) || skipHold.has(key) || INSTANCE_PRESET_SKIP.has(key)) continue;
      if (out[key] === undefined) out[key] = val;
    }
    out.intradayLiqPlaybook = "LIQ_ACCEPT";
    out.intradayLiqClassicEnabled = false;
    out.intradayLiqAcceptEnabled = out.intradayLiqAcceptEnabled ?? true;
    out.intradayLiqPickMode = out.intradayLiqPickMode ?? "chronological";
    out.intradayLiqOnePickPerDay = false;
    out.supertrendFuturesFixedSlPct = 0;
    out.supertrendFuturesFixedTpPct = 0;
    return out;
  }

  if (sym === "BTCUSDT" && liqSolo && !instSolo) {
    const out = { ...cfg };
    const basePreset = freqEdge ? INTRADAY_PRO_LIQ_FREQ_EDGE_BTC_15M : INTRADAY_PRO_LIQ_BTC_15M;
    const skipSlTp = new Set(["supertrendFuturesFixedSlPct", "supertrendFuturesFixedTpPct"]);
    const skipHold = new Set(["intradayLiqMaxHoldBars"]);
    for (const [key, val] of Object.entries(basePreset)) {
      if (skipSlTp.has(key) || skipHold.has(key) || INSTANCE_PRESET_SKIP.has(key)) continue;
      if (out[key] === undefined) out[key] = val;
    }
    if (cfg.intradayLiqSessionExtreme === false) out.intradayLiqSessionExtreme = false;
    out.supertrendFuturesFixedSlPct = 0;
    out.supertrendFuturesFixedTpPct = 0;
    return out;
  }
  if (sym === "ETHUSDT" && liqSolo && !instSolo) {
    const out = { ...cfg };
    const basePreset = freqEdge ? INTRADAY_PRO_LIQ_FREQ_EDGE_ETH_15M : INTRADAY_PRO_LIQ_ETH_15M;
    const skipSlTp = new Set(["supertrendFuturesFixedSlPct", "supertrendFuturesFixedTpPct"]);
    const skipHold = new Set(["intradayLiqMaxHoldBars"]);
    for (const [key, val] of Object.entries(basePreset)) {
      if (skipSlTp.has(key) || skipHold.has(key) || INSTANCE_PRESET_SKIP.has(key)) continue;
      if (out[key] === undefined) out[key] = val;
    }
    if (cfg.intradayLiqSessionExtreme === false) out.intradayLiqSessionExtreme = false;
    out.supertrendFuturesFixedSlPct = 0;
    out.supertrendFuturesFixedTpPct = 0;
    return out;
  }

  const out = { ...cfg };
  const basePreset = instSolo
    ? INTRADAY_PRO_SR_APLUS_15M
    : freqEdge
      ? INTRADAY_PRO_LIQ_FREQ_EDGE_BNB_15M
      : INTRADAY_PRO_LIQ_15M;
  const skipSlTp = new Set(["supertrendFuturesFixedSlPct", "supertrendFuturesFixedTpPct"]);
  const skipHold = new Set(["intradayLiqMaxHoldBars"]);
  for (const [key, val] of Object.entries(basePreset)) {
    if (skipSlTp.has(key) || skipHold.has(key) || INSTANCE_PRESET_SKIP.has(key)) continue;
    if (out[key] === undefined) out[key] = val;
  }
  if (cfg.intradayLiqSessionExtreme === false) out.intradayLiqSessionExtreme = false;
  out.supertrendFuturesFixedSlPct = 0;
  out.supertrendFuturesFixedTpPct = 0;

  const tf = String(out.timeframe || cfg.timeframe || "15m").toLowerCase();
  const mpb =
    { "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240 }[tf] ?? 15;
  const barScale = mpb / 15;
  if (barScale > 1) {
    const scaleBars = (n, floor = 1) => Math.max(floor, Math.round(Number(n) / barScale));
    if (out.intradayLiqMaxSweepBars != null) {
      out.intradayLiqMaxSweepBars = scaleBars(out.intradayLiqMaxSweepBars, 4);
    }
    if (out.srIntradayMinBarGap != null) {
      out.srIntradayMinBarGap = scaleBars(out.srIntradayMinBarGap, 1);
    }
    if (out.intradayMinBarGap != null) {
      out.intradayMinBarGap = scaleBars(out.intradayMinBarGap, 1);
    }
    if (out.intradayLiqMinSweepExtensionPct != null) {
      out.intradayLiqMinSweepExtensionPct = Number(out.intradayLiqMinSweepExtensionPct) * Math.sqrt(barScale);
    }
  }

  return out;
}

/** Merge SMC/ICT solo defaults when the SMC gate is on (exclusive engine). */
export function fillSmcSoloPresetDefaults(cfg = {}) {
  if (!isSmcIctEngineActive(cfg)) return cfg;
  const skipSlTp = new Set(["supertrendFuturesFixedSlPct", "supertrendFuturesFixedTpPct"]);
  const skipMarket = new Set(["symbol", "timeframe", "strategyMode", "manualStrategy", "marketMode"]);
  const out = applySmcEngineExclusivity({ ...cfg });
  const profile = String(out.intradaySmcIctProfile ?? "sweep").toLowerCase();
  void profile;
  for (const [key, val] of Object.entries(INTRADAY_PRO_ICT_15M)) {
    if (skipSlTp.has(key) || skipMarket.has(key) || INSTANCE_PRESET_SKIP.has(key)) continue;
    // Only fill missing keys — never clobber explicit saved / panel values (backtest snapshot parity).
    if (out[key] === undefined) out[key] = val;
  }
  out.supertrendFuturesFixedSlPct = 0;
  out.supertrendFuturesFixedTpPct = 0;
  return out;
}

export function fillFibSoloPresetDefaults(cfg = {}) {
  const gates = resolveIntradayGates(cfg);
  const fibSolo =
    gates.fib &&
    !gates.liquidity &&
    !gates.session &&
    !gates.vp &&
    !gates.orderFlow &&
    !gates.htfRegime;
  if (!fibSolo) return cfg;
  const out = { ...cfg };
  const profile = String(cfg.intradayFibProfile ?? "sniper").toLowerCase();
  const profilePatch = FIB_PROFILE_PRESETS[profile] ?? {};
  Object.assign(out, profilePatch);
  /** Swing SL/TP from leg — do not inject preset golden scalp % or UI fixed overrides. */
  const skipSlTp = new Set([
    "intradayFibGoldenScalpSlPct",
    "intradayFibGoldenScalpTpPct",
    "intradayFibMidScalpSlPct",
    "intradayFibMidScalpTpPct",
    "intradayFibScalpSlPct",
    "intradayFibScalpTpPct",
    "supertrendFuturesFixedSlPct",
    "supertrendFuturesFixedTpPct",
  ]);
  for (const [key, val] of Object.entries(INTRADAY_PRO_FIB_15M)) {
    if (skipSlTp.has(key) || INSTANCE_PRESET_SKIP.has(key)) continue;
    if (out[key] === undefined) out[key] = val;
  }
  return out;
}

/** Live + backtest parity: solo preset fills then panel materialization. */
export async function materializeIntradayEngineCfg(cfg = {}) {
  let out = fillSmcSoloPresetDefaults(fillLiqSoloPresetDefaults(fillFibSoloPresetDefaults(cfg)));
  try {
    const { materializeIntradayPanelOnCfg } = await import("../intradayPanelKeys.js");
    out = materializeIntradayPanelOnCfg(out);
  } catch {
    /* optional */
  }
  return out;
}

/** Sync variant when panel materializer is already imported. */
export function materializeIntradayEngineCfgSync(cfg = {}, materializeIntradayPanelOnCfg) {
  const incoming = cfg && typeof cfg === "object" ? cfg : {};
  const userTuning = pickEthLiqUserTuning(incoming);
  let out = fillSmcSoloPresetDefaults(fillLiqSoloPresetDefaults(fillFibSoloPresetDefaults(incoming)));
  out = repairStaleEthLiqCfg(out, incoming);
  if (typeof materializeIntradayPanelOnCfg === "function") {
    out = materializeIntradayPanelOnCfg(out);
  }
  out = { ...out, ...userTuning };
  out = repairStaleEthLiqCfg(out, incoming);
  const meta = {};
  for (const key of ["backtestTrailMicroTf", "backtestTrailActivationOn", "backtestTrailPriceSource", "backtestPositionSizing"]) {
    if (incoming[key] !== undefined) meta[key] = incoming[key];
  }
  return { ...out, ...meta };
}
