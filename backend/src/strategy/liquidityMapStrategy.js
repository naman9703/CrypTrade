import { precomputeIntraday } from "./intradayPro.js";
import {
  buildRollingLiquidityPools,
  detectHtfLiquiditySweeps,
  detectRollingLiquiditySweeps,
  liquidityMapDayId,
} from "./techniques/liquidityMap.js";
import { atrPercentileAt } from "./techniques/smcRegime.js";
import { inSmcKillzone } from "./techniques/sessionKillzones.js";
import { attachSmcHtfToPre } from "./techniques/htfBias.js";
import { detectChochInRange, detectMssInRange } from "./techniques/bosChoch.js";
import { findFvgFromDisplacement, priceAtFvgMidpoint, priceInFvgZone } from "./techniques/fairValueGap.js";
import { findObFromDisplacement, priceInObZone } from "./techniques/orderBlock.js";
import { DYNAMIC_TRAIL_V2_DEFAULTS } from "../lib/dynamicTrailing.js";
import {
  applyLiqMapAutoCalibrateCfg,
  buildLiqMapCoinProfile,
  resolveLiqMapDynamicTuning,
} from "./liquidityMapAutoCalibrate.js";

/** Exit models, selectable from the Trading Panel. */
export const LIQ_MAP_EXIT_MODES = Object.freeze(["PARTIAL_RUNNER", "SCALED_FIXED"]);
export const LIQ_MAP_TRAIL_MODES = Object.freeze(["FEE_LADDER", "SUPERTREND", "DYNAMIC_ATR"]);

const DEFAULTS = Object.freeze({
  liqMapLookbackBars: 72,
  liqMapMaxAgeBars: 72,
  liqMapMinTouches: 1,
  liqMapMinWickRatio: 0.25,
  liqMapMinRvol: 1.1,
  liqMapSweepPct: 0.0006,
  liqMapEqualTolPct: 0.0008,
  liqMapNormalizeThresholds: true,
  liqMapSweepAtrFrac: 0.13,
  liqMapEqualTolAtrFrac: 0.18,
  liqMapAutoCalibrate: true,
  liqMapAutoProfileBars: 200,
  liqMapQualityGate: false,
  liqMapQualityGateMode: "HARD",
  liqMapSoftGateScoreBand: 0.25,
  liqMapQualityAuto: true,
  liqMapMinQualityScore: 6.2,
  liqMapRequireUnresolved: true,
  liqMapRequireDirectionalClose: true,
  liqMapEntryModel: "HTF_SWEEP",
  liqMapHtfPoolTfs: "1h,4h",
  liqMapHtfLookbackBars: 72,
  liqMapHtfSwingLeft: 2,
  liqMapHtfSwingRight: 2,
  liqMapHtfEqualMinTouches: 2,
  liqMapUseDailyWeeklyPools: true,
  liqMapUseTrendlinePools: true,
  liqMapEntryTiming: "FVG_OR_OB",
  liqMapRequireMss: true,
  liqMapRequireChoch: false,
  liqMapRequireRetrace: true,
  liqMapRequireReclaimHold: true,
  liqMapConfirmBars: 2,
  liqMapStructureLookbackBars: 24,
  liqMapMssMaxBarsAfterSweep: 10,
  liqMapEntryZoneMode: "FVG",
  liqMapFvgEntryMode: "ZONE",
  liqMapMssRequireDisplacement: true,
  liqMapDisplacementBodyMult: 1.15,
  liqMapDisplacementAtrMult: 0.35,
  liqMapFvgMinGapPct: 0.00005,
  liqMapStrictPdZone: true,
  liqMapObMinDisplacementAtr: 0.6,
  liqMapRr: 1.25,
  // Dynamic, volatility-aware stop: the stop sits beyond the sweep wick, but is
  // also floored at `liqMapAtrSlMult` x ATR so a tight wick in a high-vol regime
  // doesn't get stopped on noise. Set 0 to use the pure wick-structural stop.
  // Because TP1/TP2 are R-multiples of this risk, the whole target framework
  // auto-scales with volatility (bigger ATR → wider stop → bigger absolute targets).
  liqMapSlMode: "ATR_FLOOR",
  liqMapAtrSlMult: 1.0,
  liqMapSlRegimeAdjust: true,
  liqMapSlRegimeLowMult: 0.75,
  liqMapSlRegimeHighMult: 1.15,
  liqMapHtfMode: "against",
  liqMapKillzone: "ALL",
  liqMapMinAtrPctile: 0,
  liqMapMaxAtrPctile: 0,
  liqMapAtrPctileLookback: 2880,
  liqMapMinAdx: 0,
  liqMapMaxAdx: 0,
  liqMapMinAtrPct: 0,
  liqMapMaxAtrPct: 0,
  liqMapMaxHoldBars: 0,
  // Dead-trade invalidation: if the setup has not reached a minimum MFE in R
  // after this many bars, compress risk instead of forcing a time-stop exit.
  // Set bars=0 to disable.
  liqMapDeadTradeExitBars: 0,
  liqMapDeadTradeMinMfeR: 0.5,
  liqMapDeadTradeMaxLossR: 0.55,
  liqMapStructuralTp1Rr: 0.75,
  liqMapMaxSlPct: 0.05,
  liqMapSlBufferPct: 0.0015,
  liqMapSlBufferAtrFrac: 0.2,
  liqMapOnePerDay: true,
  liqMapOnePerSidePerDay: false,
  // Exit model + fixed structural bracket config (see normalizeLiquidityMapRunCfg).
  liqMapExitMode: "SCALED_FIXED",
  // SUPERTREND trails the runner at the Supertrend line, which keeps it in the
  // trade through pullbacks and lets winners ride into the bigger move. FEE_LADDER
  // trails much tighter (round-trip BE ladder) and tends to clip runners early.
  liqMapTrailMode: "SUPERTREND",
  // Supertrend-line params used purely for the runner trail (no entry effect).
  liqMapTrailStPeriod: 10,
  liqMapTrailStMult: 3.0,
  // Dynamic ATR runner trail: Chandelier + MFE-ratchet + optional ST merge.
  liqMapTrailAtrHwmMult: DYNAMIC_TRAIL_V2_DEFAULTS.trailDynamicAdvAtrHwmMult,
  liqMapTrailMfeGiveback: DYNAMIC_TRAIL_V2_DEFAULTS.trailDynamicAdvMfeGivebackFrac,
  liqMapTrailMfeMinR: DYNAMIC_TRAIL_V2_DEFAULTS.trailDynamicAdvMfeMinR,
  liqMapTrailStepAtrMult: 0.6,
  liqMapTrailStepRiskR: 0,
  liqMapTrailMergeSt: DYNAMIC_TRAIL_V2_DEFAULTS.trailDynamicAdvMergeSupertrend,
  liqMapMaxTpRr: 10,
  liqMapMaxOpposingRr: 2,
  liqMapDynamicRunnerMaxTpRr: 15,
  liqMapDynamicRunnerMinTpRr: 3,
  liqMapProjectedTpAtrMult: 4,
  liqMapProjectedTpRangeMult: 0.5,
  liqMapProjectionLookbackBars: 24,
  liqMapDynamicExitPolicy: false,
  liqMapDynExitQualityHi: 6.4,
  liqMapDynExitQualityMid: 5.8,
  liqMapDynExitRrHi: 3.0,
  liqMapDynExitRrMid: 2.0,
  liqMapDynExitPartialHi: 0.35,
  liqMapDynExitPartialMid: 0.5,
  liqMapDynExitPartialBase: 0.75,
  liqMapDynExitTrailAtrHi: 5.5,
  liqMapDynExitTrailAtrMid: 4.5,
  liqMapDynExitTrailAtrBase: 3.0,
  liqMapDynExitWeakTp1Rr: 0.7,
  // Most app-path winners barely exceed 1R, while only a tiny fraction reach 2R.
  // Bank more at TP1 and leave a smaller runner for the rare extension.
  liqMapPartialFrac: 0.75,
  // With time-stop disabled, protect proved trades after TP1 so the runner can
  // seek extension without giving the remaining size back to the original SL.
  liqMapBreakevenAfterPartial: false,
  liqMapUse4hConfirm: false,
  // TP2 / runner target must sit at least this many R beyond entry (past TP1) to
  // count as opposing liquidity; otherwise we use a sane fallback R target rather
  // than the far maxTpRr cap that would never fill.
  liqMapMinTp2Rr: 1.5,
  liqMapFallbackTpRr: 3,
});

export const LIQUIDITY_MAP_BTC_15M_PRESET = {
  strategyMode: "MANUAL",
  manualStrategy: "LIQUIDITY_MAP",
  symbol: "BTCUSDT",
  timeframe: "15m",
  marketMode: "FUTURES",
  supertrendFuturesAuto: false,
  supertrendSpotAuto: false,
  futuresLeverage: 12,
  riskPerTrade: 1,
  riskPerTradeUnit: "PCT",
  backtestPositionSizing: "RISK_AT_SL",
  supertrendFuturesUseFixedSl: true,
  supertrendFuturesUseFixedTp: true,
  supertrendFuturesFixedSlPct: 0,
  supertrendFuturesFixedTpPct: 0,
  trailingStopLossAuto: true,
  futuresTrailingStopMode: "SUPERTREND",
  supertrendFuturesExitOnFlip: false,
  // Supertrend line used for the runner trail (independent of entry logic).
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  supertrendWilderAtr: true,
  intradayLiqEntryAtSignalClose: true,
  intradayLiqTp1Enabled: true,
  intradayLiqTp2Enabled: false,
  intradayLiqPartialTp: true,
  intradayLiqBreakevenAfterPartial: true,
    intradayLiqMaxHoldBars: 0,
  liqMapDynamicRunnerMaxTpRr: 15,
  liqMapDynamicRunnerMinTpRr: 3,
  liqMapProjectedTpAtrMult: 4,
  liqMapProjectedTpRangeMult: 0.5,
  liqMapProjectionLookbackBars: 24,
  liqMapSlRegimeAdjust: true,
  liqMapSlRegimeLowMult: 0.75,
  liqMapSlRegimeHighMult: 1.15,
  liqMapTrailAtrHwmMult: DYNAMIC_TRAIL_V2_DEFAULTS.trailDynamicAdvAtrHwmMult,
  liqMapTrailMfeGiveback: DYNAMIC_TRAIL_V2_DEFAULTS.trailDynamicAdvMfeGivebackFrac,
  liqMapTrailMfeMinR: DYNAMIC_TRAIL_V2_DEFAULTS.trailDynamicAdvMfeMinR,
  liqMapTrailMergeSt: DYNAMIC_TRAIL_V2_DEFAULTS.trailDynamicAdvMergeSupertrend,
  ...DEFAULTS,
};

export const LIQUIDITY_MAP_BTC_5M_PRESET = {
  ...LIQUIDITY_MAP_BTC_15M_PRESET,
  timeframe: "5m",
  // Same wall-clock context as the 15m preset, but entries execute on 5m bars.
  liqMapLookbackBars: 216,
  liqMapMaxAgeBars: 216,
  liqMapStructureLookbackBars: 72,
  liqMapMssMaxBarsAfterSweep: 30,
  liqMapProjectionLookbackBars: 72,
  liqMapAtrPctileLookback: 8640,
};

export const LIQUIDITY_MAP_BTC_1M_PRESET = {
  ...LIQUIDITY_MAP_BTC_15M_PRESET,
  timeframe: "1m",
  // 1m is supported for precision entries, but it is much heavier to backtest.
  liqMapLookbackBars: 1080,
  liqMapMaxAgeBars: 1080,
  liqMapStructureLookbackBars: 360,
  liqMapMssMaxBarsAfterSweep: 150,
  liqMapProjectionLookbackBars: 360,
  liqMapAtrPctileLookback: 43200,
};

/** Higher-frequency internal liquidity sweep preset (5m structural fast entry). */
export const LIQUIDITY_MAP_5M_STRUCTURAL_FAST_PRESET = {
  ...LIQUIDITY_MAP_BTC_5M_PRESET,
  liqMapExitMode: "SCALED_FIXED",
  liqMapTrailMode: "SUPERTREND",
  trailingStopLossAuto: false,
  intradayLiqTp1Enabled: false,
  intradayLiqTp2Enabled: true,
  intradayLiqPartialTp: false,
  intradayLiqBreakevenAfterPartial: false,
  liqMapEntryModel: "STRUCTURAL",
  liqMapHtfMode: "none",
  liqMapUse4hConfirm: false,
  liqMapEntryTiming: "NEXT_OPEN",
  liqMapRequireRetrace: false,
  liqMapRequireReclaimHold: true,
  liqMapEntryZoneMode: "EITHER",
  liqMapMssMaxBarsAfterSweep: 12,
  liqMapLookbackBars: 144,
  liqMapMaxAgeBars: 144,
  liqMapMinTouches: 1,
  liqMapQualityGate: true,
  liqMapQualityGateMode: "SOFT",
  liqMapQualityAuto: true,
  liqMapMinQualityScore: 6.2,
  liqMapMaxOpposingRr: 2,
  liqMapMinTp2Rr: 1.2,
  liqMapFallbackTpRr: 1.6,
  liqMapDynamicExitPolicy: false,
  liqMapBreakevenAfterPartial: false,
  liqMapAutoTrailTune: false,
};

/** 5m structural fast + per-coin dynamic ATR runner (partial @1R + trail). */
export const LIQUIDITY_MAP_5M_STRUCTURAL_RUNNER_PRESET = {
  ...LIQUIDITY_MAP_5M_STRUCTURAL_FAST_PRESET,
  liqMapExitMode: "PARTIAL_RUNNER",
  liqMapTrailMode: "DYNAMIC_ATR",
  trailingStopLossAuto: true,
  intradayLiqTp1Enabled: true,
  intradayLiqTp2Enabled: false,
  intradayLiqPartialTp: true,
  intradayLiqBreakevenAfterPartial: false,
  liqMapPartialFrac: 0.45,
  liqMapBreakevenAfterPartial: false,
  liqMapMaxOpposingRr: 0,
  liqMapMinTp2Rr: 1.5,
  liqMapFallbackTpRr: 2.5,
  liqMapDynamicRunnerMaxTpRr: 15,
  liqMapDynamicRunnerMinTpRr: 2,
  liqMapDynamicExitPolicy: true,
  liqMapAutoTrailTune: true,
  liqMapHybridExit: true,
  liqMapTrailAtrHwmMult: 2.5,
  liqMapTrailMfeGiveback: 0.18,
  liqMapTrailMfeMinR: 1.2,
  liqMapTrailStepAtrMult: 0.6,
  liqMapTrailMergeSt: true,
  trailBufferMode: "ATR",
  trailBufferAtrMult: 0.28,
};

/**
 * BNB 5m — ~1 trade/day, 2-bar reclaim confirm after sweep, wick SL, 50% @1R + 1R-spaced ATR runner.
 * Auto-calibrate thresholds from warmup only (no symbol table) for OOS portability.
 */
export const LIQUIDITY_MAP_BNB_5M_TWO_BAR_RUNNER_PRESET = {
  ...LIQUIDITY_MAP_5M_STRUCTURAL_RUNNER_PRESET,
  symbol: "BNBUSDT",
  timeframe: "5m",
  liqMapEntryModel: "STRUCTURAL",
  liqMapHtfMode: "none",
  liqMapEntryTiming: "TWO_BAR_CONFIRM",
  liqMapConfirmBars: 2,
  liqMapRequireMss: false,
  liqMapRequireChoch: false,
  liqMapRequireRetrace: false,
  liqMapRequireReclaimHold: true,
  liqMapEntryZoneMode: "EITHER",
  liqMapMssMaxBarsAfterSweep: 8,
  liqMapLookbackBars: 144,
  liqMapMaxAgeBars: 144,
  liqMapMinTouches: 1,
  liqMapMinWickRatio: 0.22,
  liqMapMinRvol: 0.9,
  liqMapQualityGate: true,
  liqMapQualityGateMode: "SOFT",
  liqMapQualityAuto: true,
  liqMapMinQualityScore: 5.8,
  liqMapAutoCalibrate: true,
  liqMapAutoProfileBars: 200,
  liqMapAutoTrailTune: true,
  liqMapSlMode: "REVERSAL_WICK",
  liqMapSlBufferPct: 0,
  liqMapSlBufferAtrFrac: 0,
  liqMapAtrSlMult: 0,
  liqMapStructuralTp1Rr: 1,
  liqMapPartialFrac: 0.5,
  liqMapOnePerDay: true,
  liqMapOnePerSidePerDay: false,
  liqMapExitMode: "PARTIAL_RUNNER",
  liqMapTrailMode: "DYNAMIC_ATR",
  liqMapTrailStepRiskR: 1,
  liqMapTrailAtrHwmMult: 2.2,
  liqMapTrailMfeGiveback: 0.22,
  liqMapTrailMfeMinR: 1,
  liqMapDynamicExitPolicy: false,
  liqMapMaxOpposingRr: 0,
  liqMapDynamicRunnerMaxTpRr: 12,
  liqMapDynamicRunnerMinTpRr: 2,
  liqMapBreakevenAfterPartial: false,
  intradayLiqTp1Enabled: true,
  intradayLiqTp2Enabled: false,
  intradayLiqPartialTp: true,
  intradayLiqBreakevenAfterPartial: false,
  trailingStopLossAuto: true,
  trailBufferMode: "PCT",
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function boolFromCfg(value, fallback = false) {
  if (value == null) return fallback;
  return value !== false;
}

export function buildLiquidityMapOptsFromCfg(cfg = {}) {
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (cfg[key] != null) out[key] = cfg[key];
  }
  return out;
}

/**
 * Translate the selected `liqMapExitMode` into the downstream exit flags the
 * runner actually consumes (intradayLiq* legs + trailing). Keeps backtest and
 * live in sync: one enum is authoritative, so a stale saved snapshot can't make
 * the exits diverge from the chosen model.
 *
 * - PARTIAL_RUNNER: TP1 partial @1R, breakeven after partial, runner trails to
 *   the opposing liquidity (no fixed TP2). The 1:10 tail.
 * - SCALED_FIXED:   Full-size TP at the opposing liquidity pool capped at
 *   `liqMapMaxTpRr` x R. No partial, no breakeven move, no trailing.
 */
export function resolveLiquidityMapRunCfg(cfg = {}, candles = []) {
  const calibrated =
    cfg.liqMapAutoCalibrate === true && candles?.length
      ? applyLiqMapAutoCalibrateCfg(cfg, candles)
      : cfg;
  return sanitizeLiquidityMapContamination({
    ...calibrated,
    ...normalizeLiquidityMapRunCfg(calibrated),
  });
}

/**
 * Strip Supertrend fixed-% bracket distances that leak from global bot defaults.
 * LIQUIDITY_MAP uses structural wick/ATR stops and opposing-liquidity TPs — not
 * fixed 0.2%/1.5% brackets (same contamination class as SUPERTREND_ELITE).
 */
export function sanitizeLiquidityMapContamination(cfg = {}) {
  const out = { ...cfg };
  if (out.supertrendFuturesUseFixedSl !== false) {
    out.supertrendFuturesFixedSlPct = 0;
  }
  if (out.supertrendFuturesUseFixedTp !== false) {
    out.supertrendFuturesFixedTpPct = 0;
  }
  return out;
}

export function normalizeLiquidityMapRunCfg(cfg = {}) {
  const mode = String(cfg.liqMapExitMode ?? DEFAULTS.liqMapExitMode).toUpperCase();
  const base = {
    intradayLiqTp1Enabled: true,
    intradayLiqPartialTp: true,
    intradayLiqBreakevenAfterPartial:
      cfg.liqMapBreakevenAfterPartial != null
        ? cfg.liqMapBreakevenAfterPartial === true
        : cfg.intradayLiqBreakevenAfterPartial != null
          ? cfg.intradayLiqBreakevenAfterPartial !== false
          : DEFAULTS.liqMapBreakevenAfterPartial === true,
    supertrendFuturesUseFixedSl: true,
    supertrendFuturesExitOnFlip: false,
    intradayLiqEntryAtSignalClose: cfg.intradayLiqEntryAtSignalClose !== false,
    liqMapDeadTradeExitBars: Number(cfg.liqMapDeadTradeExitBars ?? DEFAULTS.liqMapDeadTradeExitBars),
    liqMapDeadTradeMinMfeR: Number(cfg.liqMapDeadTradeMinMfeR ?? DEFAULTS.liqMapDeadTradeMinMfeR),
    liqMapDeadTradeMaxLossR: Number(cfg.liqMapDeadTradeMaxLossR ?? DEFAULTS.liqMapDeadTradeMaxLossR),
  };
  if (mode === "SCALED_FIXED") {
    return {
      ...base,
      intradayLiqTp1Enabled: false,
      intradayLiqPartialTp: false,
      intradayLiqTp2Enabled: true,
      intradayLiqBreakevenAfterPartial: false,
      supertrendFuturesUseFixedTp: true,
      trailingStopLossAuto: false,
      intradayLiqMaxTpRr: Number(cfg.liqMapMaxTpRr ?? DEFAULTS.liqMapMaxTpRr),
    };
  }
  // PARTIAL_RUNNER (default)
  const trailMode = String(cfg.liqMapTrailMode ?? DEFAULTS.liqMapTrailMode).toUpperCase();
  const out = {
    ...base,
    intradayLiqTp2Enabled: false,
    // Keep the structural TP path ON so the TP1 partial actually books at +1R
    // (the runner has no hard TP2 because intradayLiqTp2Enabled is false — it
    // trails instead). Setting this false would gate off the whole TP path,
    // silently disabling the partial leg.
    supertrendFuturesUseFixedTp: true,
    trailingStopLossAuto: true,
    futuresTrailingStopMode: trailMode === "DYNAMIC_ATR" ? "SUPERTREND" : trailMode,
    // The runner only trails after the 1R partial is booked; until then the
    // structural ATR stop holds, so a trend trail can't clip the counter-trend
    // sweep entry before it reaches +1R.
    trailOnlyAfterPartialFill: true,
  };
  if (trailMode === "SUPERTREND" || trailMode === "DYNAMIC_ATR") {
    // Trail at the Supertrend line so the runner rides the bigger move. Honor any
    // explicit supertrend params on the cfg; otherwise fall back to the liqMap trail knobs.
    out.supertrendPeriod = Number(cfg.supertrendPeriod ?? cfg.liqMapTrailStPeriod ?? DEFAULTS.liqMapTrailStPeriod);
    out.supertrendMultiplier = Number(cfg.supertrendMultiplier ?? cfg.liqMapTrailStMult ?? DEFAULTS.liqMapTrailStMult);
    if (cfg.supertrendWilderAtr == null) out.supertrendWilderAtr = true;
  }
  if (trailMode === "DYNAMIC_ATR") {
    Object.assign(out, {
      trailSizingMode: "DYNAMIC",
      futuresTrailingStAdvanced: true,
      futuresTrailingStFeeBreakeven: false,
      trailDynamicAdvAtrHwmMult: Number(
        cfg.liqMapTrailAtrHwmMult ?? cfg.trailDynamicAdvAtrHwmMult ?? DEFAULTS.liqMapTrailAtrHwmMult,
      ),
      trailDynamicAdvMfeGivebackFrac: Number(
        cfg.liqMapTrailMfeGiveback ?? cfg.trailDynamicAdvMfeGivebackFrac ?? DEFAULTS.liqMapTrailMfeGiveback,
      ),
      trailDynamicAdvMfeMinR: Number(
        cfg.liqMapTrailMfeMinR ?? cfg.trailDynamicAdvMfeMinR ?? DEFAULTS.liqMapTrailMfeMinR,
      ),
      trailDynamicAdvPostT02StepAtrMult: Number(
        cfg.liqMapTrailStepAtrMult ??
          cfg.trailDynamicAdvPostT02StepAtrMult ??
          DEFAULTS.liqMapTrailStepAtrMult,
      ),
      trailDynamicAdvMergeSupertrend: boolFromCfg(
        cfg.liqMapTrailMergeSt ?? cfg.trailDynamicAdvMergeSupertrend,
        DEFAULTS.liqMapTrailMergeSt,
      ),
      trailDynamicAdvAtrSource: "ROLLING",
    });
  }
  return out;
}

function projectedOpposingLevel(candles, idx, side, entry, opts, minDist = 0, atrAtEntry = null) {
  const isLong = side === "BUY";
  const atr = Number(atrAtEntry);
  const atrMult = Math.max(0, Number(opts.liqMapProjectedTpAtrMult ?? 0));
  const atrDist = Number.isFinite(atr) && atr > 0 && atrMult > 0 ? atr * atrMult : 0;
  const lookback = clamp(Math.round(Number(opts.liqMapProjectionLookbackBars ?? 24)), 2, 300);
  const rangeMult = Math.max(0, Number(opts.liqMapProjectedTpRangeMult ?? 0));
  let hi = -Infinity;
  let lo = Infinity;
  const start = Math.max(0, idx - lookback);
  for (let i = start; i <= idx; i++) {
    const h = num(candles?.[i]?.high);
    const l = num(candles?.[i]?.low);
    if (h > 0) hi = Math.max(hi, h);
    if (l > 0) lo = Math.min(lo, l);
  }
  const range = Number.isFinite(hi) && Number.isFinite(lo) && hi > lo ? hi - lo : 0;
  const rangeDist = range > 0 && rangeMult > 0 ? range * rangeMult : 0;
  const dist = Math.max(Number(minDist) || 0, atrDist, rangeDist);
  if (!(dist > 0)) return null;
  return isLong ? entry + dist : entry - dist;
}

/**
 * Opposing liquidity to target for TP2 / the runner. Long → resting highs ABOVE
 * entry; short → resting lows BELOW. Critically, the target must sit BEYOND TP1
 * (`minDist` from entry) so it represents a real "bigger move", not the nearest
 * minor pool that collapses TP2 into the 1R band. Among qualifying levels we take
 * the NEAREST (most reachable), combining rolling pools with prior-day / prior-week
 * session extremes from `precomputeIntraday`. Returns null when none qualify.
 */
function isDynamicAtrRunnerOpts(opts = {}) {
  return (
    String(opts.liqMapExitMode ?? DEFAULTS.liqMapExitMode).toUpperCase() === "PARTIAL_RUNNER" &&
    String(opts.liqMapTrailMode ?? DEFAULTS.liqMapTrailMode).toUpperCase() === "DYNAMIC_ATR"
  );
}

export function resolveOpposingLevel(candles, idx, pre, side, entry, opts, minDist = 0, atrAtEntry = null) {
  const isLong = side === "BUY";
  const effectiveMinDist = Math.max(0, Number(minDist) || 0);
  const beyondTp1 = (lvl) => (isLong ? lvl >= entry + effectiveMinDist : lvl <= entry - effectiveMinDist);
  const candidates = [];
  try {
    for (const pool of buildRollingLiquidityPools(candles, idx, opts) || []) {
      const lvl = num(pool.level);
      if (!(lvl > 0)) continue;
      if (isLong && pool.side === "SELL") candidates.push(lvl);
      else if (!isLong && pool.side === "BUY") candidates.push(lvl);
    }
  } catch {
    /* pools optional */
  }
  const htf = isLong
    ? [num(pre.prevDayHigh?.[idx]), num(pre.prevWeekHigh?.[idx])]
    : [num(pre.prevDayLow?.[idx]), num(pre.prevWeekLow?.[idx])];
  for (const lvl of htf) if (lvl > 0) candidates.push(lvl);
  const projected = projectedOpposingLevel(candles, idx, side, entry, opts, effectiveMinDist, atrAtEntry);
  if (projected != null && projected > 0) candidates.push(projected);

  // Dynamic ATR runners are not fixed-target scalps. Avoid letting the nearest
  // minor pool compress the whole trade into ~1.4R; use the farthest qualifying
  // extension/projection so the runner can trail a larger move.
  const preferExtension = isDynamicAtrRunnerOpts(opts);
  let best = null;
  for (const lvl of candidates) {
    if (!beyondTp1(lvl)) continue;
    if (best == null) best = lvl;
    else if (preferExtension ? (isLong ? lvl > best : lvl < best) : (isLong ? lvl < best : lvl > best)) best = lvl;
  }
  return best;
}

function trendOk(side, pre, idx, mode) {
  const m = String(mode ?? "none").toLowerCase();
  if (m === "none") return true;
  if (m === "with") return side === "BUY" ? pre.htfUp?.[idx] === true : pre.htfDown?.[idx] === true;
  if (m === "against") return side === "BUY" ? pre.htfDown?.[idx] === true : pre.htfUp?.[idx] === true;
  return true;
}

function htfBiasAligned(side, pre, idx) {
  return side === "BUY" ? pre.htfUp?.[idx] === true : pre.htfDown?.[idx] === true;
}

function recentRangePct(candles, idx, lookback = 12) {
  let hi = -Infinity;
  let lo = Infinity;
  const start = Math.max(0, idx - Math.max(2, Number(lookback) || 12));
  for (let i = start; i <= idx; i++) {
    const h = num(candles?.[i]?.high);
    const l = num(candles?.[i]?.low);
    if (h > 0) hi = Math.max(hi, h);
    if (l > 0) lo = Math.min(lo, l);
  }
  const close = num(candles?.[idx]?.close);
  return close > 0 && Number.isFinite(hi) && Number.isFinite(lo) && hi > lo ? (hi - lo) / close : 0;
}

export function scoreLiquidityMapQuality(event, candles, pre, idx, opts, liqBrackets, refAtrPct = 0, atrPctile = null) {
  const side = event?.side;
  const bar = candles?.[idx];
  const entry = num(event?.entry);
  const level = num(event?.level);
  const close = num(bar?.close);
  const atrPct = Number(refAtrPct) > 0 ? Number(refAtrPct) : 0.001;
  const extensionAtr = Math.max(0, Number(event?.extension ?? 0) / atrPct);
  const reclaimPct = entry > 0 && level > 0 ? Math.abs(close - level) / entry : 0;
  const reclaimAtr = reclaimPct / atrPct;
  const rr = Math.max(0, Number(liqBrackets?.rr ?? 0));
  const adx = num(pre?.adxSeries?.[idx]);
  const rangeAtr = recentRangePct(candles, idx, Number(opts.liqMapProjectionLookbackBars ?? 24)) / atrPct;
  const htfAligned = htfBiasAligned(side, pre, idx);
  const fourHBonus =
    opts.liqMapUse4hConfirm === true && (side === "BUY" ? pre?._smcHtf?.h4Up?.[idx] === true : pre?._smcHtf?.h4Down?.[idx] === true)
      ? 0.35
      : 0;

  const components = {
    sweepDepth: Math.min(1.6, Math.max(0, (extensionAtr - 0.1) * 1.6)),
    wickReject: Math.min(1.4, Math.max(0, Number(event?.wickRatio ?? 0) * 2.4)),
    reclaim: Math.min(1.25, Math.max(0, reclaimAtr * 1.4)),
    body: Math.min(1.0, Math.max(0, Number(event?.bodyRatio ?? 0) * 1.8)),
    rvol: Math.min(1.2, Math.max(0, (Number(event?.rvol ?? 1) - 0.9) * 0.9)),
    // Target room helps only a little. Dynamic runner projection can create a
    // far synthetic TP, but that must not make a weak sweep look high-quality.
    targetRoom: Math.min(0.2, Math.max(0, (Math.min(rr, 1.5) - 1.1) * 0.55)),
    htf: htfAligned ? 0.85 : 0,
    fourH: fourHBonus,
    structure: Math.min(0.9, Math.max(0, (Number(event?.touches ?? 1) - 1) * 0.35 + Number(event?.poolScore ?? 0) / 30)),
    mss: event?.mssIdx != null ? 1.1 : 0,
    pdArray: event?.fvg ? 0.9 : event?.ob ? 0.65 : 0,
    retrace: event?.entryZone === "fvg_mid" ? 0.8 : event?.entryZone === "fvg" || event?.entryZone === "ob" ? 0.55 : 0,
  };

  let penalty = 0;
  if (Number.isFinite(adx) && adx > 0 && adx < 14) penalty += 0.8;
  if (rangeAtr > 8 && rr < 2) penalty += 0.5;
  if (atrPctile != null && Number(atrPctile) > 85 && Number(event?.rvol ?? 1) < 1.2) penalty += 0.45;

  const rawScore = Object.values(components).reduce((sum, v) => sum + v, 0) - penalty;
  const score = Math.max(0, Number(rawScore.toFixed(3)));
  return {
    score,
    passed: score >= Number(opts.liqMapMinQualityScore ?? DEFAULTS.liqMapMinQualityScore),
    minScore: Number(opts.liqMapMinQualityScore ?? DEFAULTS.liqMapMinQualityScore),
    components,
    diagnostics: {
      extensionAtr: Number(extensionAtr.toFixed(3)),
      reclaimAtr: Number(reclaimAtr.toFixed(3)),
      rr: Number(rr.toFixed(3)),
      adx: Number.isFinite(adx) ? Number(adx.toFixed(2)) : null,
      rangeAtr: Number(rangeAtr.toFixed(3)),
      atrPctile: atrPctile == null ? null : Number(Number(atrPctile).toFixed(2)),
      penalty: Number(penalty.toFixed(3)),
    },
  };
}

export function resolveLiquidityMapDynamicExitPolicy(opts = {}, quality = null, liqBrackets = null) {
  const q = Number(quality?.score ?? 0);
  const minScore = Number(quality?.minScore ?? opts.liqMapMinQualityScore ?? DEFAULTS.liqMapMinQualityScore);
  const rr = Number(liqBrackets?.rr ?? 0);
  const passed = q >= minScore;
  const model = String(opts.liqMapEntryModel ?? DEFAULTS.liqMapEntryModel).toUpperCase();
  const structuralEntry = model === "STRUCTURAL" || model === "HTF_SWEEP";
  const structuralTp1Rr = clamp(opts.liqMapStructuralTp1Rr ?? DEFAULTS.liqMapStructuralTp1Rr, 0.5, 1);
  if (!passed) {
    return {
      tier: "DEFENSIVE_SCALP",
      partialFrac: clamp(opts.liqMapDynExitPartialBase ?? opts.liqMapPartialFrac ?? DEFAULTS.liqMapDynExitPartialBase, 0.25, 0.75),
      tp1Rr: structuralEntry
        ? Math.min(structuralTp1Rr, clamp(opts.liqMapDynExitWeakTp1Rr ?? DEFAULTS.liqMapDynExitWeakTp1Rr, 0.45, 1))
        : clamp(opts.liqMapDynExitWeakTp1Rr ?? DEFAULTS.liqMapDynExitWeakTp1Rr, 0.45, 1),
      trailOverrides: {
        trailDynamicAdvAtrHwmMult: clamp(opts.liqMapDynExitTrailAtrBase ?? opts.liqMapTrailAtrHwmMult ?? DEFAULTS.liqMapDynExitTrailAtrBase, 0, 6),
        trailDynamicAdvMfeGivebackFrac: structuralEntry ? 0.4 : Math.max(0.45, Number(opts.liqMapTrailMfeGiveback ?? DEFAULTS.liqMapTrailMfeGiveback)),
        trailDynamicAdvMfeMinR: structuralEntry ? 0.8 : 0.8,
        trailDynamicAdvMergeSupertrend: opts.liqMapTrailMergeSt !== false,
        trailDynamicAdvAtrSource: "ROLLING",
        trailDynamicAdvPostT02StepAtrMult: Math.max(0, Number(opts.liqMapTrailStepAtrMult ?? DEFAULTS.liqMapTrailStepAtrMult)),
      },
    };
  }
  const hi = q >= Number(opts.liqMapDynExitQualityHi ?? DEFAULTS.liqMapDynExitQualityHi) && rr >= Number(opts.liqMapDynExitRrHi ?? DEFAULTS.liqMapDynExitRrHi);
  const mid = q >= Number(opts.liqMapDynExitQualityMid ?? DEFAULTS.liqMapDynExitQualityMid) && rr >= Number(opts.liqMapDynExitRrMid ?? DEFAULTS.liqMapDynExitRrMid);
  const tier = hi ? "HIGH_EXTENSION" : mid ? "MID_EXTENSION" : "BASE_BANK";
  const partialFrac = hi
    ? structuralEntry
      ? Math.max(0.5, clamp(opts.liqMapDynExitPartialHi ?? DEFAULTS.liqMapDynExitPartialHi, 0.25, 0.75))
      : clamp(opts.liqMapDynExitPartialHi ?? DEFAULTS.liqMapDynExitPartialHi, 0.25, 0.75)
    : mid
      ? structuralEntry
        ? Math.max(0.6, clamp(opts.liqMapDynExitPartialMid ?? DEFAULTS.liqMapDynExitPartialMid, 0.25, 0.75))
        : clamp(opts.liqMapDynExitPartialMid ?? DEFAULTS.liqMapDynExitPartialMid, 0.25, 0.75)
      : clamp(opts.liqMapDynExitPartialBase ?? opts.liqMapPartialFrac ?? DEFAULTS.liqMapDynExitPartialBase, 0.25, 0.75);
  const trailAtr = hi
    ? clamp(opts.liqMapDynExitTrailAtrHi ?? DEFAULTS.liqMapDynExitTrailAtrHi, 0, 6)
    : mid
      ? clamp(opts.liqMapDynExitTrailAtrMid ?? DEFAULTS.liqMapDynExitTrailAtrMid, 0, 6)
      : clamp(opts.liqMapDynExitTrailAtrBase ?? opts.liqMapTrailAtrHwmMult ?? DEFAULTS.liqMapDynExitTrailAtrBase, 0, 6);
  return {
    tier,
    partialFrac,
    tp1Rr: structuralEntry ? structuralTp1Rr : 1,
    trailOverrides: {
      trailDynamicAdvAtrHwmMult: trailAtr,
      trailDynamicAdvMfeGivebackFrac: structuralEntry
        ? hi
          ? 0.5
          : mid
            ? 0.45
            : 0.4
        : hi
          ? 0.7
          : mid
            ? 0.6
            : Math.max(0.45, Number(opts.liqMapTrailMfeGiveback ?? DEFAULTS.liqMapTrailMfeGiveback)),
      trailDynamicAdvMfeMinR: structuralEntry
        ? hi
          ? 1.5
          : mid
            ? 1.2
            : 1.0
        : hi
          ? 3.0
          : mid
            ? 2.5
            : Math.max(2.0, Number(opts.liqMapTrailMfeMinR ?? DEFAULTS.liqMapTrailMfeMinR)),
      trailDynamicAdvMergeSupertrend: hi ? false : mid ? false : opts.liqMapTrailMergeSt !== false,
      trailDynamicAdvAtrSource: "ROLLING",
      trailDynamicAdvPostT02StepAtrMult: Math.max(0, Number(opts.liqMapTrailStepAtrMult ?? DEFAULTS.liqMapTrailStepAtrMult)),
    },
  };
}

function regimeOk(candles, pre, idx, opts) {
  const adx = num(pre.adxSeries?.[idx]);
  const minAdx = Number(opts.liqMapMinAdx ?? 0);
  const maxAdx = Number(opts.liqMapMaxAdx ?? 0);
  if (minAdx > 0 && (!Number.isFinite(adx) || adx < minAdx)) return false;
  if (maxAdx > 0 && Number.isFinite(adx) && adx > maxAdx) return false;

  const atr = num(pre.atrSeries?.[idx]);
  const close = num(candles[idx]?.close);
  const atrPct = close > 0 && atr > 0 ? atr / close : 0;
  const minAtrPct = Number(opts.liqMapMinAtrPct ?? 0);
  const maxAtrPct = Number(opts.liqMapMaxAtrPct ?? 0);
  if (minAtrPct > 0 && atrPct < minAtrPct) return false;
  if (maxAtrPct > 0 && atrPct > maxAtrPct) return false;

  const pct = atrPercentileAt(candles, pre, idx, Number(opts.liqMapAtrPctileLookback ?? 2880));
  const minPct = Number(opts.liqMapMinAtrPctile ?? 0);
  const maxPct = Number(opts.liqMapMaxAtrPctile ?? 0);
  if (pct != null && minPct > 0 && pct < minPct) return false;
  if (pct != null && maxPct > 0 && pct > maxPct) return false;

  const killzone = String(opts.liqMapKillzone ?? "ALL").toUpperCase();
  if (killzone !== "ALL" && !inSmcKillzone(candles[idx]?.ts, { intradaySmcKillzoneMode: killzone })) {
    return false;
  }
  return true;
}

function usedKeyFor(event, bar, opts) {
  const day = liquidityMapDayId(bar.ts);
  return `${day}:${opts.liqMapOnePerSidePerDay === true ? event.side : "ANY"}`;
}

function markUsed(store, event, bar, opts) {
  if (!store.usedDays) store.usedDays = Object.create(null);
  store.usedDays[usedKeyFor(event, bar, opts)] = true;
}

function wasUsed(store, event, bar, opts) {
  if (opts.liqMapOnePerDay === false) return false;
  return Boolean(store.usedDays?.[usedKeyFor(event, bar, opts)]);
}

/**
 * Dynamic, volatility-aware stop. Structural by default (just beyond the sweep
 * wick), but floored at `liqMapAtrSlMult` x ATR so a razor-thin wick in a noisy
 * regime is not stopped on a single bar of chop. `atrAtEntry` is the absolute ATR
 * (price units) at the signal bar; pass null/0 to fall back to the pure wick stop.
 */
export function dynamicSlPrice(side, wickPrice, entry, atrAtEntry, opts) {
  const slBuf = Number(opts.liqMapSlBufferPct ?? 0.0015);
  const atr = Number(atrAtEntry);
  const atrBufFrac = Math.max(0, Number(opts.liqMapSlBufferAtrFrac ?? DEFAULTS.liqMapSlBufferAtrFrac));
  const pctBuffer = Math.max(0, Number(wickPrice) * Math.max(0, slBuf));
  const atrBuffer = Number.isFinite(atr) && atr > 0 && atrBufFrac > 0 ? atr * atrBufFrac : 0;
  const buffer = Math.max(pctBuffer, atrBuffer);
  const wickStop = side === "BUY" ? wickPrice - buffer : wickPrice + buffer;
  const slMode = String(opts.liqMapSlMode ?? DEFAULTS.liqMapSlMode).toUpperCase();
  if (slMode === "REVERSAL_WICK") return wickStop;
  const wickDist = Math.abs(entry - wickStop);
  const atrMult = effectiveAtrSlMult(opts);
  const atrDist = atrMult > 0 && Number.isFinite(atr) && atr > 0 ? atrMult * atr : 0;
  const dist = Math.max(wickDist, atrDist);
  if (!(dist > 0)) return wickStop;
  return side === "BUY" ? entry - dist : entry + dist;
}

export function effectiveAtrSlMult(opts = {}, atrPctile = null) {
  const base = Math.max(0, Number(opts.liqMapAtrSlMult ?? 0));
  if (!(base > 0) || opts.liqMapSlRegimeAdjust === false) return base;
  if (atrPctile == null) return base;
  const pct = Number(atrPctile);
  if (!Number.isFinite(pct)) return base;
  const lowMult = clamp(opts.liqMapSlRegimeLowMult ?? DEFAULTS.liqMapSlRegimeLowMult, 0.2, 2);
  const highMult = clamp(opts.liqMapSlRegimeHighMult ?? DEFAULTS.liqMapSlRegimeHighMult, 0.2, 3);
  if (pct <= 35) return base * lowMult;
  if (pct >= 65) return base * highMult;
  const t = (pct - 35) / 30;
  return base * (lowMult + (highMult - lowMult) * t);
}

export function dynamicSlPriceWithRegime(side, wickPrice, entry, atrAtEntry, opts, atrPctile = null) {
  return dynamicSlPrice(side, wickPrice, entry, atrAtEntry, { ...opts, liqMapAtrSlMult: effectiveAtrSlMult(opts, atrPctile) });
}

/**
 * Full structural bracket: SL beyond the sweep wick (ATR-floored) and TP at the
 * opposing liquidity pool. Trades can be rejected when that pool is too far in R,
 * because the fixed-TP model should target real liquidity rather than cap the TP
 * to an arbitrary non-liquidity price.
 */
export function buildBrackets(event, cfg, opts, opposingLevel, atrAtEntry = null, atrPctile = null) {
  const side = event.side;
  const entry = num(event.entry);
  const slPrice = dynamicSlPriceWithRegime(side, event.wickPrice, entry, atrAtEntry, opts, atrPctile);
  const risk = Math.abs(entry - slPrice);
  if (!(entry > 0) || !(risk > 0)) return null;
  const slPct = risk / entry;
  const maxSl = Number(opts.liqMapMaxSlPct ?? 0);
  if (maxSl > 0 && slPct > maxSl) return null;

  // TP1 at +1R (partial). The runner re-derives this from realized risk too.
  const tp1Price = side === "BUY" ? entry + risk : entry - risk;

  // TP2 target. Prefer opposing liquidity (must be beyond TP1 to be meaningful);
  // when none qualifies use a sane fallback R target rather than the far maxTpRr
  // cap that would never fill. Always capped at maxTpRr so a single ride can't
  // hold for days and block later entries.
  const isDynamicRunner =
    String(cfg.liqMapExitMode ?? opts.liqMapExitMode ?? DEFAULTS.liqMapExitMode).toUpperCase() === "PARTIAL_RUNNER" &&
    String(cfg.liqMapTrailMode ?? opts.liqMapTrailMode ?? DEFAULTS.liqMapTrailMode).toUpperCase() === "DYNAMIC_ATR";
  const maxTpRr = Math.max(
    0,
    Number(isDynamicRunner ? (opts.liqMapDynamicRunnerMaxTpRr ?? opts.liqMapMaxTpRr) : opts.liqMapMaxTpRr),
  );
  const cap = maxTpRr > 0 ? maxTpRr : Number(opts.liqMapFallbackTpRr ?? 3);
  const fallbackRr = Math.min(cap, Math.max(1.1, Number(opts.liqMapFallbackTpRr ?? 3)));
  const cappedPrice = side === "BUY" ? entry + cap * risk : entry - cap * risk;
  const fallbackPrice = side === "BUY" ? entry + fallbackRr * risk : entry - fallbackRr * risk;
  const opp = num(opposingLevel);
  const oppValid = opp > 0 && (side === "BUY" ? opp > entry : opp < entry);
  const oppRr = oppValid && risk > 0 ? Math.abs(opp - entry) / risk : 0;
  const maxOpposingRr = Number(opts.liqMapMaxOpposingRr ?? 0);
  if (oppValid && maxOpposingRr > 0 && oppRr > maxOpposingRr) return null;
  let tp2Price = oppValid
    ? side === "BUY"
      ? Math.min(opp, cappedPrice)
      : Math.max(opp, cappedPrice)
    : fallbackPrice;
  if (!(side === "BUY" ? tp2Price > entry : tp2Price < entry)) return null;

  const tp1Pct = Math.abs(tp1Price - entry) / entry;
  const tpPct = Math.abs(tp2Price - entry) / entry;
  const rr = slPct > 0 ? tpPct / slPct : 0;
  const partialFrac = Math.min(
    0.75,
    Math.max(0.25, Number(opts.liqMapPartialFrac ?? cfg.intradayLiqPartialFrac ?? 0.5)),
  );
  return {
    slPct,
    tpPct,
    tp1Pct,
    slPrice,
    tpPrice: tp2Price,
    tp1Price,
    tp2Price,
    tpMode: "liquidity_map_structural",
    rr,
    levelType: event.poolType,
    level: event.level,
    entryPrice: entry,
    limitEntryPrice: num(event.limitEntryPrice),
    sweepWick: event.wickPrice,
    opposingLevel: oppValid ? opp : tp2Price,
    liqQuality: event.score,
    partialTp: true,
    tp2Enabled: true,
    partialFrac,
    mapMeta: {
      touches: event.touches,
      extension: event.extension,
      wickRatio: event.wickRatio,
      rvol: event.rvol,
      opposingCapped: oppValid && tp2Price !== opp,
      dynamicRunnerTarget: isDynamicRunner,
    },
  };
}

function htf4hOk(side, candles, pre, idx, opts) {
  if (opts.liqMapUse4hConfirm !== true) return true;
  if (!pre._smcHtf) {
    try {
      attachSmcHtfToPre(candles, pre, opts);
    } catch {
      return true;
    }
  }
  const htf = pre._smcHtf;
  if (!htf) return true;
  return side === "BUY" ? htf.h4Up?.[idx] === true : htf.h4Down?.[idx] === true;
}

function entryModel(opts = {}) {
  return String(opts.liqMapEntryModel ?? DEFAULTS.liqMapEntryModel).toUpperCase();
}

function isStructuralEntryModel(opts = {}) {
  const model = entryModel(opts);
  return model === "STRUCTURAL" || model === "HTF_SWEEP";
}

function isHtfSweepEntryModel(opts = {}) {
  return entryModel(opts) === "HTF_SWEEP";
}

function liquidityMapStructureOpts(opts = {}) {
  return {
    ...opts,
    intradaySmcMssRequireDisplacement: opts.liqMapMssRequireDisplacement !== false,
    intradaySmcDisplacementBodyMult: Number(opts.liqMapDisplacementBodyMult ?? DEFAULTS.liqMapDisplacementBodyMult),
    intradaySmcDisplacementAtrMult: Number(opts.liqMapDisplacementAtrMult ?? DEFAULTS.liqMapDisplacementAtrMult),
    intradaySmcFvgMinGapPct: Number(opts.liqMapFvgMinGapPct ?? DEFAULTS.liqMapFvgMinGapPct),
    intradaySmcStrictPdZone: opts.liqMapStrictPdZone !== false,
    intradaySmcFvgMidTolPct: Number(opts.liqMapFvgMidTolPct ?? 0.0005),
    intradaySmcObMinDisplacementAtr: Number(opts.liqMapObMinDisplacementAtr ?? DEFAULTS.liqMapObMinDisplacementAtr),
    intradaySmcChochRequireTrend: false,
  };
}

function resolveLiquidityMapPdArrays(candles, mssIdx, sweepIdx, side, pre, opts, entryZoneMode) {
  let fvg = null;
  let ob = null;
  if (entryZoneMode === "FVG" || entryZoneMode === "EITHER") {
    fvg = findFvgFromDisplacement(candles, mssIdx, side, opts, sweepIdx);
  }
  if (entryZoneMode === "OB" || (entryZoneMode === "EITHER" && !fvg)) {
    ob = findObFromDisplacement(candles, mssIdx, side, pre, opts, sweepIdx);
  }
  return { fvg, ob };
}

function priceInLiquidityMapEntryZone(candles, idx, side, fvg, ob, opts) {
  const fvgEntryMode = String(opts.liqMapFvgEntryMode ?? DEFAULTS.liqMapFvgEntryMode).toUpperCase();
  if (fvgEntryMode === "MIDPOINT" || fvgEntryMode === "CE") {
    const entryPrice = fvg ? Number(fvg.mid ?? (Number(fvg.top) + Number(fvg.bottom)) / 2) : NaN;
    return {
      inZone: Boolean(fvg && priceAtFvgMidpoint(candles, idx, fvg, side, opts)),
      entryZone: "fvg_mid",
      entryPrice: Number.isFinite(entryPrice) && entryPrice > 0 ? entryPrice : null,
    };
  }
  if (fvg && priceInFvgZone(candles, idx, fvg, side, opts)) {
    return {
      inZone: true,
      entryZone: "fvg",
      // Conservative limit fill: first tradable edge of the zone, not the close.
      entryPrice: side === "BUY" ? Number(fvg.top) : Number(fvg.bottom),
    };
  }
  if (ob && priceInObZone(candles, idx, ob, side, opts)) {
    return {
      inZone: true,
      entryZone: "ob",
      entryPrice: side === "BUY" ? Number(ob.top) : Number(ob.bottom),
    };
  }
  return { inZone: false, entryZone: fvg ? "fvg" : ob ? "ob" : "none", entryPrice: null };
}

function passesReclaimConfirmBars(candles, sweepIdx, idx, side, level, confirmBars) {
  const n = clamp(Math.round(Number(confirmBars)), 1, 5);
  if (idx !== sweepIdx + n) return false;
  const lvl = num(level);
  if (!(lvl > 0)) return false;
  for (let k = 1; k <= n; k++) {
    const close = num(candles[sweepIdx + k]?.close);
    if (side === "BUY" && !(close > lvl)) return false;
    if (side === "SELL" && !(close < lvl)) return false;
  }
  return true;
}

function detectStructuralLiquidityMapSweeps(candles, idx, pre, opts, refAtrPct) {
  const lookback = clamp(Math.round(Number(opts.liqMapStructureLookbackBars ?? DEFAULTS.liqMapStructureLookbackBars)), 3, 200);
  const maxAfterSweep = clamp(Math.round(Number(opts.liqMapMssMaxBarsAfterSweep ?? DEFAULTS.liqMapMssMaxBarsAfterSweep)), 1, 100);
  const requireChoch = opts.liqMapRequireChoch === true;
  const requireMss = opts.liqMapRequireMss !== false;
  const requireRetrace = opts.liqMapRequireRetrace !== false;
  const entryZoneMode = String(opts.liqMapEntryZoneMode ?? DEFAULTS.liqMapEntryZoneMode).toUpperCase();
  const entryTiming = String(opts.liqMapEntryTiming ?? DEFAULTS.liqMapEntryTiming).toUpperCase();
  const twoBarConfirm = entryTiming === "TWO_BAR_CONFIRM";
  const confirmBars = clamp(Math.round(Number(opts.liqMapConfirmBars ?? DEFAULTS.liqMapConfirmBars)), 1, 5);
  const structOpts = liquidityMapStructureOpts(opts);
  const start = Math.max(120, idx - lookback);
  const out = [];

  for (let sweepIdx = idx; sweepIdx >= start; sweepIdx--) {
    if (idx - sweepIdx > maxAfterSweep) break;
    const sweepEvents = detectRollingLiquiditySweeps(candles, sweepIdx, {
      liqMapLookbackBars: opts.liqMapLookbackBars,
      liqMapMaxAgeBars: opts.liqMapMaxAgeBars,
      liqMapMinTouches: opts.liqMapMinTouches,
      liqMapMinWickRatio: opts.liqMapMinWickRatio,
      liqMapMinRvol: opts.liqMapMinRvol,
      liqMapMinBodyRatio: opts.liqMapMinBodyRatio,
      liqMapSweepPct: opts.liqMapSweepPct,
      liqMapEqualTolPct: opts.liqMapEqualTolPct,
      liqMapNormalizeThresholds: opts.liqMapNormalizeThresholds,
      liqMapSweepAtrFrac: opts.liqMapSweepAtrFrac,
      liqMapEqualTolAtrFrac: opts.liqMapEqualTolAtrFrac,
      refAtrPct,
      liqMapRequireUnresolved: opts.liqMapRequireUnresolved,
      liqMapRequireDirectionalClose: opts.liqMapRequireDirectionalClose,
    });

    for (const event of sweepEvents) {
      if (!trendOk(event.side, pre, idx, opts.liqMapHtfMode)) continue;
      if (!htf4hOk(event.side, candles, pre, idx, opts)) continue;

      if (twoBarConfirm) {
        if (!passesReclaimConfirmBars(candles, sweepIdx, idx, event.side, event.level, confirmBars)) continue;
        if (opts.liqMapRequireReclaimHold !== false) {
          const close = num(candles[idx]?.close);
          const level = num(event.level);
          if (event.side === "BUY" && !(close > level)) continue;
          if (event.side === "SELL" && !(close < level)) continue;
        }
        out.push({
          ...event,
          entry: num(candles[idx]?.close),
          limitEntryPrice: null,
          sweepIdx,
          sweepReclaimIdx: sweepIdx,
          entryIdx: idx,
          mssIdx: sweepIdx,
          mssLevel: null,
          mssType: null,
          chochIdx: null,
          chochLevel: null,
          chochType: null,
          fvg: null,
          ob: null,
          entryZone: "two_bar_confirm",
          score: Number(event.score ?? 0) + 6 - Math.max(0, idx - sweepIdx) * 0.1,
        });
        continue;
      }

      let chochIdx = null;
      let chochLevel = null;
      let chochType = null;
      if (requireChoch) {
        const choch = detectChochInRange(candles, sweepIdx, idx, event.side, structOpts);
        if (!choch.ok) continue;
        chochIdx = choch.chochIdx;
        chochLevel = choch.chochLevel;
        chochType = choch.type;
      }

      const structureFrom = chochIdx != null ? chochIdx : sweepIdx + 1;
      let mssIdx = structureFrom;
      let mssLevel = null;
      let mssType = null;
      if (requireMss) {
        const mss = detectMssInRange(candles, structureFrom, idx, event.side, structOpts, pre);
        if (!mss.ok) continue;
        mssIdx = mss.mssIdx;
        mssLevel = mss.mssLevel;
        mssType = mss.type;
      }

      if (chochIdx != null && mssIdx < chochIdx) continue;
      const { fvg, ob } = resolveLiquidityMapPdArrays(candles, mssIdx, sweepIdx, event.side, pre, structOpts, entryZoneMode);
      if (entryZoneMode === "FVG" && !fvg) continue;
      if (entryZoneMode === "OB" && !ob) continue;
      if (entryZoneMode === "EITHER" && !fvg && !ob) continue;

      const zone = priceInLiquidityMapEntryZone(candles, idx, event.side, fvg, ob, structOpts);
      if (requireRetrace) {
        if (!zone.inZone) continue;
        if (idx <= mssIdx) continue;
      } else if (!zone.inZone && idx !== mssIdx) {
        continue;
      }
      if (opts.liqMapRequireReclaimHold !== false) {
        const close = num(candles[idx]?.close);
        const level = num(event.level);
        if (event.side === "BUY" && !(close > level)) continue;
        if (event.side === "SELL" && !(close < level)) continue;
      }

      out.push({
        ...event,
        entry: num(zone.inZone ? zone.entryPrice : candles[idx]?.close),
        limitEntryPrice: zone.inZone ? num(zone.entryPrice) : null,
        sweepIdx,
        sweepReclaimIdx: sweepIdx,
        entryIdx: idx,
        mssIdx,
        mssLevel,
        mssType,
        chochIdx,
        chochLevel,
        chochType,
        fvg,
        ob,
        entryZone: zone.entryZone,
        score: Number(event.score ?? 0) + 8 + (fvg ? 2 : 0) + (ob ? 1 : 0) - Math.max(0, idx - mssIdx) * 0.15,
      });
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

function detectMechanicalHtfLiquiditySweeps(candles, idx, pre, opts, refAtrPct) {
  const lookback = clamp(Math.round(Number(opts.liqMapStructureLookbackBars ?? DEFAULTS.liqMapStructureLookbackBars)), 3, 200);
  const maxAfterSweep = clamp(Math.round(Number(opts.liqMapMssMaxBarsAfterSweep ?? DEFAULTS.liqMapMssMaxBarsAfterSweep)), 1, 100);
  const requireChoch = opts.liqMapRequireChoch === true;
  const requireMss = opts.liqMapRequireMss !== false;
  const requireRetrace = opts.liqMapRequireRetrace !== false;
  const entryZoneMode = String(opts.liqMapEntryZoneMode ?? DEFAULTS.liqMapEntryZoneMode).toUpperCase();
  const entryTiming = String(opts.liqMapEntryTiming ?? DEFAULTS.liqMapEntryTiming).toUpperCase();
  const allowNextCandle = entryTiming === "NEXT_OPEN" || entryTiming === "CONFIRMATION_CLOSE";
  const allowPdArray = entryTiming !== "NEXT_OPEN";
  const structOpts = liquidityMapStructureOpts(opts);
  const start = Math.max(120, idx - lookback);
  const out = [];

  for (let sweepIdx = idx; sweepIdx >= start; sweepIdx--) {
    if (idx - sweepIdx > maxAfterSweep) break;
    const sweepEvents = detectHtfLiquiditySweeps(candles, sweepIdx, pre, {
      ...opts,
      refAtrPct,
    });

    for (const event of sweepEvents) {
      if (!trendOk(event.side, pre, idx, opts.liqMapHtfMode)) continue;
      if (!htf4hOk(event.side, candles, pre, idx, opts)) continue;

      let chochIdx = null;
      let chochLevel = null;
      let chochType = null;
      if (requireChoch) {
        const choch = detectChochInRange(candles, sweepIdx, idx, event.side, structOpts);
        if (!choch.ok) continue;
        chochIdx = choch.chochIdx;
        chochLevel = choch.chochLevel;
        chochType = choch.type;
      }

      const structureFrom = chochIdx != null ? chochIdx : sweepIdx + 1;
      let mssIdx = structureFrom;
      let mssLevel = null;
      let mssType = null;
      if (requireMss) {
        const mss = detectMssInRange(candles, structureFrom, idx, event.side, structOpts, pre);
        if (!mss.ok) continue;
        mssIdx = mss.mssIdx;
        mssLevel = mss.mssLevel;
        mssType = mss.type;
      }
      if (chochIdx != null && mssIdx < chochIdx) continue;

      const { fvg, ob } = resolveLiquidityMapPdArrays(candles, mssIdx, sweepIdx, event.side, pre, structOpts, entryZoneMode);
      const zone = priceInLiquidityMapEntryZone(candles, idx, event.side, fvg, ob, structOpts);
      const isNextEntryBar = allowNextCandle && idx === mssIdx + 1;

      if (allowPdArray) {
        if (entryZoneMode === "FVG" && !fvg) continue;
        if (entryZoneMode === "OB" && !ob) continue;
        if (entryZoneMode === "EITHER" && !fvg && !ob && !isNextEntryBar) continue;
      }

      if (requireRetrace && !isNextEntryBar) {
        if (!allowPdArray || !zone.inZone) continue;
        if (idx <= mssIdx) continue;
      } else if (!requireRetrace && !zone.inZone && !isNextEntryBar && idx !== mssIdx) {
        continue;
      }

      if (opts.liqMapRequireReclaimHold !== false) {
        const close = num(candles[idx]?.close);
        const level = num(event.level);
        if (event.side === "BUY" && !(close > level)) continue;
        if (event.side === "SELL" && !(close < level)) continue;
      }

      out.push({
        ...event,
        entry: num(zone.inZone ? zone.entryPrice : candles[idx]?.close),
        limitEntryPrice: zone.inZone ? num(zone.entryPrice) : null,
        sweepIdx,
        sweepReclaimIdx: sweepIdx,
        entryIdx: idx,
        mssIdx,
        mssLevel,
        mssType,
        chochIdx,
        chochLevel,
        chochType,
        fvg,
        ob,
        entryZone: isNextEntryBar ? "next_candle" : zone.entryZone,
        score: Number(event.score ?? 0) + 10 + (fvg ? 2 : 0) + (ob ? 1 : 0) - Math.max(0, idx - mssIdx) * 0.15,
      });
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

export function evaluateLiquidityMapSetup(candles, idx, pre, cfg = {}, store = {}) {
  if (idx < 120 || !candles?.[idx]) return null;
  let opts = buildLiquidityMapOptsFromCfg(cfg);
  if (cfg.liqMapAutoCalibrate === true && cfg.liqMapQualityAuto !== false) {
    const profileBars = clamp(Math.round(Number(opts.liqMapAutoProfileBars ?? DEFAULTS.liqMapAutoProfileBars)), 40, 200);
    const recent = candles.slice(Math.max(0, idx - profileBars + 1), idx + 1);
    const profile = buildLiqMapCoinProfile(recent, {
      profileBars,
      sweepAtrFrac: opts.liqMapSweepAtrFrac,
      equalTolAtrFrac: opts.liqMapEqualTolAtrFrac,
    });
    const tuning = resolveLiqMapDynamicTuning(profile, {
      sweepAtrFrac: opts.liqMapSweepAtrFrac,
      equalTolAtrFrac: opts.liqMapEqualTolAtrFrac,
      atrSlMult: opts.liqMapAtrSlMult,
      minQualityScore: opts.liqMapMinQualityScore,
    });
    opts = {
      ...opts,
      liqMapNormalizeThresholds: true,
      liqMapSweepAtrFrac: tuning.sweepAtrFrac,
      liqMapEqualTolAtrFrac: tuning.equalTolAtrFrac,
      liqMapAtrSlMult: tuning.atrSlMult,
      liqMapMinQualityScore: tuning.minQualityScore,
      liqMapDynExitQualityMid: tuning.dynamicExitQualityMid,
      liqMapDynExitQualityHi: tuning.dynamicExitQualityHi,
      liqMapDynExitRrMid: tuning.dynamicExitRrMid,
      liqMapDynExitRrHi: tuning.dynamicExitRrHi,
      liqMapRequireDirectionalClose: tuning.requireDirectionalClose === true ? true : opts.liqMapRequireDirectionalClose,
    };
  }
  if (!regimeOk(candles, pre, idx, opts)) return null;
  const close = num(candles[idx]?.close);
  const atr = num(pre.atrSeries?.[idx]);
  const refAtrPct = close > 0 && atr > 0 ? atr / close : 0;
  const events = isHtfSweepEntryModel(opts)
    ? detectMechanicalHtfLiquiditySweeps(candles, idx, pre, opts, refAtrPct)
    : isStructuralEntryModel(opts)
      ? detectStructuralLiquidityMapSweeps(candles, idx, pre, opts, refAtrPct)
    : detectRollingLiquiditySweeps(candles, idx, {
        liqMapLookbackBars: opts.liqMapLookbackBars,
        liqMapMaxAgeBars: opts.liqMapMaxAgeBars,
        liqMapMinTouches: opts.liqMapMinTouches,
        liqMapMinWickRatio: opts.liqMapMinWickRatio,
        liqMapMinRvol: opts.liqMapMinRvol,
        liqMapMinBodyRatio: opts.liqMapMinBodyRatio,
        liqMapSweepPct: opts.liqMapSweepPct,
        liqMapEqualTolPct: opts.liqMapEqualTolPct,
        liqMapNormalizeThresholds: opts.liqMapNormalizeThresholds,
        liqMapSweepAtrFrac: opts.liqMapSweepAtrFrac,
        liqMapEqualTolAtrFrac: opts.liqMapEqualTolAtrFrac,
        refAtrPct,
        liqMapRequireUnresolved: opts.liqMapRequireUnresolved,
        liqMapRequireDirectionalClose: opts.liqMapRequireDirectionalClose,
      })
        .filter((event) => trendOk(event.side, pre, idx, opts.liqMapHtfMode))
        .filter((event) => htf4hOk(event.side, candles, pre, idx, opts));
  for (const event of events) {
    if (wasUsed(store, event, candles[idx], opts)) continue;
    const entryPx = num(event.entry);
    const atrAtEntry = num(pre.atrSeries?.[idx]);
    const atrPctile = atrPercentileAt(candles, pre, idx, Number(opts.liqMapAtrPctileLookback ?? 2880));
    const slPx = dynamicSlPriceWithRegime(event.side, event.wickPrice, entryPx, atrAtEntry, opts, atrPctile);
    const riskPx = Math.abs(entryPx - slPx);
    const isDynRunner = isDynamicAtrRunnerOpts(opts);
    const minTp2Rr = isDynRunner
      ? Math.max(Number(opts.liqMapDynamicRunnerMinTpRr ?? DEFAULTS.liqMapDynamicRunnerMinTpRr), Number(opts.liqMapMinTp2Rr ?? 1.5))
      : Number(opts.liqMapMinTp2Rr ?? 1.5);
    const minTp2Dist = riskPx * minTp2Rr;
    const opposingLevel = resolveOpposingLevel(candles, idx, pre, event.side, entryPx, opts, minTp2Dist, atrAtEntry);
    const liqBrackets = buildBrackets(event, cfg, opts, opposingLevel, atrAtEntry, atrPctile);
    if (!liqBrackets) continue;
    const quality = scoreLiquidityMapQuality(event, candles, pre, idx, opts, liqBrackets, refAtrPct, atrPctile);
    liqBrackets.mapMeta = { ...(liqBrackets.mapMeta || {}), quality };
    liqBrackets.liqQuality = quality.score;
    const gateMode = String(opts.liqMapQualityGateMode ?? DEFAULTS.liqMapQualityGateMode).toUpperCase();
    if (opts.liqMapQualityGate === true && !quality.passed) {
      const softBand = clamp(opts.liqMapSoftGateScoreBand ?? DEFAULTS.liqMapSoftGateScoreBand, 0, 3);
      if (gateMode !== "SOFT" || quality.score < quality.minScore - softBand) continue;
    }
    if (opts.liqMapDynamicExitPolicy === true) {
      const policy = resolveLiquidityMapDynamicExitPolicy(opts, quality, liqBrackets);
      liqBrackets.partialFrac = policy.partialFrac;
      liqBrackets.tp1Rr = policy.tp1Rr;
      liqBrackets.trailOverrides = policy.trailOverrides;
      liqBrackets.mapMeta.dynamicExitPolicy = policy;
    }
    const trailStepRiskR = Number(opts.liqMapTrailStepRiskR ?? DEFAULTS.liqMapTrailStepRiskR);
    if (trailStepRiskR > 0 && riskPx > 0 && entryPx > 0) {
      const spacingFrac = (riskPx * trailStepRiskR) / entryPx;
      liqBrackets.trailOverrides = {
        ...(liqBrackets.trailOverrides || {}),
        trailBufferMode: "PCT",
        trailBufferRate: spacingFrac,
        trailPostT02SpacingFrac: spacingFrac,
        trailDynamicAdvPostT02StepAtrMult: 0,
      };
    }
    markUsed(store, event, candles[idx], opts);
    return {
      action: event.side,
      reason: isStructuralEntryModel(opts)
        ? `liq_map_structural_${event.poolType}_${event.entryZone ?? "retrace"}`
        : `liq_map_${event.poolType}_${String(opts.liqMapHtfMode).toLowerCase()}`,
      liqBrackets,
      techniques: [
        "liquidity_map",
        event.poolType,
        ...(isStructuralEntryModel(opts) ? ["mss", event.fvg ? "fvg" : event.ob ? "ob" : "pd_array", "retrace"] : []),
      ],
      smcMeta: {
        ictProfile: "liquidity_map",
        levelType: event.poolType,
        levelSource: event.poolSource ?? null,
        levelTf: event.poolTf ?? null,
        sweepLevel: event.level,
        sweepExtensionPct: event.extension,
        reclaimBodyRatio: event.bodyRatio,
        killzone: opts.liqMapKillzone,
        plannedRr: liqBrackets.rr,
        entryModel: String(opts.liqMapEntryModel ?? DEFAULTS.liqMapEntryModel).toUpperCase(),
        sweepReclaimIdx: event.sweepReclaimIdx ?? idx,
        sweepReclaimTs: candles[event.sweepReclaimIdx ?? idx]?.ts ?? null,
        mssIdx: event.mssIdx ?? null,
        mssTs: event.mssIdx != null ? candles[event.mssIdx]?.ts ?? null : null,
        mssLevel: event.mssLevel ?? null,
        mssType: event.mssType ?? null,
        chochIdx: event.chochIdx ?? null,
        chochTs: event.chochIdx != null ? candles[event.chochIdx]?.ts ?? null : null,
        chochLevel: event.chochLevel ?? null,
        chochType: event.chochType ?? null,
        entryIdx: idx,
        entryZone: event.entryZone ?? null,
        limitEntryPrice: event.limitEntryPrice ?? null,
        fvgTop: event.fvg?.top ?? null,
        fvgBottom: event.fvg?.bottom ?? null,
        fvgMid: event.fvg?.mid ?? null,
        fvgFormedIdx: event.fvg?.formedIdx ?? null,
        fvgFormedTs: event.fvg?.formedIdx != null ? candles[event.fvg.formedIdx]?.ts ?? null : null,
        obTop: event.ob?.top ?? null,
        obBottom: event.ob?.bottom ?? null,
        obIdx: event.ob?.obIdx ?? null,
        obTs: event.ob?.obIdx != null ? candles[event.ob.obIdx]?.ts ?? null : null,
      },
    };
  }
  return null;
}

export function buildLiquidityMapBacktestAdapter(candles, cfg = {}) {
  const pre = precomputeIntraday(candles);
  const runCfg = resolveLiquidityMapRunCfg(cfg, candles);
  const local = { usedDays: Object.create(null) };
  return function liquidityMapAdapter(_bar, idx, ctx = {}) {
    const store = ctx.persisted || local;
    return evaluateLiquidityMapSetup(candles, idx, pre, runCfg, store);
  };
}

export const LIQUIDITY_MAP = {
  name: "Liquidity Map (rolling swing/equal-level sweeps)",
  signal() {
    return { action: "HOLD", reason: "bar_close_adapter_required" };
  },
};
