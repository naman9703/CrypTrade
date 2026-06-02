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
  vpLookbackBars: 672,
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
  intradayLiqMinReclaimBodyRatio: 0,
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
  intradayRequireSessionReclaim: false,
  intradayRequireFibOrVp: false,
  intradayMinTechniqueCount: 1,
  srIntradayMinScore: 5,
  srIntradayMaxTradesPerDay: 3,
  srIntradayMinBarGap: 4,
  supertrendFuturesFixedTpPct: 0,
  supertrendFuturesFixedSlPct: 0,
  backtestBreakevenAtMfePct: 0,
  intradayLiqBreakevenAfterPartial: true,
};

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
  intradaySmcMaxTpRr: 3,
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
  const out = { ...cfg };
  const basePreset = instSolo ? INTRADAY_PRO_SR_APLUS_15M : INTRADAY_PRO_LIQ_15M;
  const skipSlTp = new Set(["supertrendFuturesFixedSlPct", "supertrendFuturesFixedTpPct"]);
  for (const [key, val] of Object.entries(basePreset)) {
    if (skipSlTp.has(key) || INSTANCE_PRESET_SKIP.has(key)) continue;
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
  let out = fillSmcSoloPresetDefaults(fillLiqSoloPresetDefaults(fillFibSoloPresetDefaults(cfg)));
  if (typeof materializeIntradayPanelOnCfg === "function") {
    out = materializeIntradayPanelOnCfg(out);
  }
  return out;
}
