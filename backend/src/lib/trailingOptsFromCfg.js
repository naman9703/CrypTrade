/**
 * Map strategy / backtest cfg + cost model → `trailingOpts` for `applyTrailingStopBinanceMemory`.
 */

import { resolveCostModel } from "../backtest/engine/costModel.js";
import {
  clampFeeRate,
  computeEffectiveTrailBuffer,
  maxTrailStepsForConfig,
} from "./trailingStopLoss.js";

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function trailCfgAliases(c) {
  const cfg = c && typeof c === "object" ? c : {};
  return {
    feeBeMult: cfg.trailFeeBeMultiplier ?? cfg.feeBeMultiplier,
    actSlip: cfg.trailActivationSlippageFrac ?? cfg.activationSlippageFrac,
    postT02Buf: cfg.trailPostT02ActivationBufferRate ?? cfg.postT02ActivationBufferRate,
    minDist: cfg.trailMinSlDistFrac ?? cfg.minSlDistanceFrac,
    minGap: cfg.trailMinGapFromMarkFrac ?? cfg.minTrailGapFromMarkFrac,
  };
}

function resolveSupertrendTrailToggles(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const useFeeBeTrail =
    c.futuresTrailingStFeeBreakeven != null
      ? c.futuresTrailingStFeeBreakeven !== false
      : c.supertrendUseFeeBreakeven !== false;
  const useAdvTrail =
    c.futuresTrailingStAdvanced != null
      ? c.futuresTrailingStAdvanced !== false
      : c.supertrendUseAdvancedTrail !== false;
  return { useFeeBeTrail, useAdvTrail };
}

/** @returns {boolean} */
export function isTrailingEnabledInCfg(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const isFutures = String(c.marketMode || c.market || "").toUpperCase() === "FUTURES";
  const mode = String(c.futuresTrailingStopMode ?? "SUPERTREND").toUpperCase();
  return c.trailingStopLossAuto === true && isFutures && mode !== "OFF";
}

/**
 * Gate trailing until the TP2 partial leg fills (liquidity 3-stage ladder).
 * Explicit `trailOnlyAfterTp2Fill: false` disables; when unset, auto-enables when
 * TP1 + fixed TP2 partial RR + trailing are all configured.
 * @param {Record<string, unknown>} cfg
 * @returns {boolean}
 */
export function resolveTrailOnlyAfterTp2Fill(cfg = {}) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  if (c.trailOnlyAfterTp2Fill === true || c.intradayLiqTrailAfterTp2 === true) return true;
  if (c.trailOnlyAfterTp2Fill === false) return false;
  if (c.trailOnlyAfterPartialFill === true) return false;
  if (!isTrailingEnabledInCfg(c)) return false;

  const tp1On = c.intradayLiqTp1Enabled !== false && c.intradayLiqPartialTp !== false;
  const tp2PartialFrac = Number(c.intradayLiqTp2PartialFrac ?? 0);
  const tp2Rr = Number(c.intradayLiqTp2Rr ?? 0);
  return tp1On && tp2PartialFrac > 0 && tp2Rr > 0;
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {import('../backtest/engine/costModel.js').ResolvedCostModel | Record<string, unknown>} [cm]
 * @param {{ atrPct?: number|null, supertrendPx?: number|null, supertrendBySymbol?: Record<string, number> }} [opts]
 * @returns {object|null}
 */
export function buildTrailingOptsFromCfg(cfg, cm, { atrPct = null, supertrendPx = null, supertrendBySymbol = null } = {}) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  if (!isTrailingEnabledInCfg(c)) return null;

  const cost = cm?.takerOpenFeeRate != null ? cm : resolveCostModel(c, cm && typeof cm === "object" ? cm : {});
  const alias = trailCfgAliases(c);
  const openR = clampFeeRate(
    c.trailOpenFeeRate != null ? Number(c.trailOpenFeeRate) : cost.takerOpenFeeRate,
  );
  const closeR = clampFeeRate(
    c.trailCloseFeeRate != null ? Number(c.trailCloseFeeRate) : cost.takerCloseFeeRate,
  );
  const trailMode = String(c.futuresTrailingStopMode ?? "SUPERTREND").toUpperCase();
  const trailBuf = computeEffectiveTrailBuffer({
    bufferRate: clamp(Number(c.trailBufferRate ?? 0.0005), 0, 0.05),
    trailBufferMode: c.trailBufferMode,
    trailBufferAtrMult: Number(c.trailBufferAtrMult ?? 0),
    atrPct,
  });
  const trailSlip = clamp(Number(alias.actSlip ?? 0), 0, 0.01);
  const trailT01LockSlip = clamp(Number(c.trailT01LockSlippageFrac ?? 0), 0, 0.01);
  const feeBeMultiplier =
    alias.feeBeMult != null && Number.isFinite(Number(alias.feeBeMult)) ? Number(alias.feeBeMult) : undefined;
  const extraTrailPcts = Array.isArray(c.trailingStopExtraScalpingPcts)
    ? c.trailingStopExtraScalpingPcts
    : Array.isArray(c.extraScalpingPcts)
      ? c.extraScalpingPcts
      : [];
  const postT02MaxExtraTiers = Math.max(
    10,
    Math.min(500, Math.floor(Number(c.trailPostT02MaxExtraTiers ?? 150))),
  );
  const { useFeeBeTrail, useAdvTrail } = resolveSupertrendTrailToggles(c);

  const trailSizingMode =
    String(c.trailSizingMode ?? "FIXED_PCT").toUpperCase() === "DYNAMIC" ? "DYNAMIC" : "FIXED_PCT";

  return {
    enabled: true,
    mode: trailMode === "FEE_LADDER" ? "FEE_LADDER" : "SUPERTREND",
    trailSizingMode,
    trailDynamicBeAtrMult: Number(c.trailDynamicBeAtrMult ?? 0.5),
    trailDynamicBeT01LockAtrMult: Number(c.trailDynamicBeT01LockAtrMult ?? 0),
    trailDynamicBeRegimeAdjust: c.trailDynamicBeRegimeAdjust === true,
    trailDynamicBeRegimeLowMult: Number(c.trailDynamicBeRegimeLowMult ?? 0.85),
    trailDynamicBeRegimeHighMult: Number(c.trailDynamicBeRegimeHighMult ?? 1.15),
    trailDynamicAdvAtrHwmMult: Number(c.trailDynamicAdvAtrHwmMult ?? 1.0),
    trailDynamicAdvMfeGivebackFrac: Number(c.trailDynamicAdvMfeGivebackFrac ?? 0.25),
    trailDynamicAdvMfeMinR: Number(c.trailDynamicAdvMfeMinR ?? 1.0),
    trailDynamicAdvMergeSupertrend: c.trailDynamicAdvMergeSupertrend !== false,
    trailDynamicAdvAtrSource:
      String(c.trailDynamicAdvAtrSource ?? "ENTRY").toUpperCase() === "ROLLING" ? "ROLLING" : "ENTRY",
    trailDynamicAdvPostT02StepAtrMult: Number(c.trailDynamicAdvPostT02StepAtrMult ?? 0.5),
    feeRate: closeR,
    openFeeRate: openR,
    closeFeeRate: closeR,
    feeBeMultiplier,
    extraScalpingPcts: extraTrailPcts,
    maxTrailSteps: maxTrailStepsForConfig(extraTrailPcts, postT02MaxExtraTiers),
    trailPostT02SpacingFrac:
      c.trailPostT02SpacingFrac != null && Number.isFinite(Number(c.trailPostT02SpacingFrac))
        ? clamp(Number(c.trailPostT02SpacingFrac), 0.00001, 0.05)
        : null,
    trailPostT02MaxExtraTiers: postT02MaxExtraTiers,
    supertrendPx: supertrendPx != null && Number.isFinite(Number(supertrendPx)) ? Number(supertrendPx) : null,
    supertrendBySymbol:
      supertrendBySymbol && typeof supertrendBySymbol === "object" ? supertrendBySymbol : undefined,
    bufferRate: trailBuf,
    activationSlippageFrac: trailSlip,
    trailT01LockSlippageFrac: trailT01LockSlip,
    atrPct: atrPct != null && Number.isFinite(Number(atrPct)) ? Number(atrPct) : undefined,
    trailBufferAtrMult: Number(c.trailBufferAtrMult ?? 0),
    trailBufferMode: c.trailBufferMode,
    postT02ActivationBufferRate:
      alias.postT02Buf != null && Number.isFinite(Number(alias.postT02Buf))
        ? clamp(Number(alias.postT02Buf), 0, 0.05)
        : null,
    maintenanceMarginRate:
      c.trailMaintMarginRate != null && Number.isFinite(Number(c.trailMaintMarginRate))
        ? Number(c.trailMaintMarginRate)
        : 0.005,
    minSlDistanceFrac:
      alias.minDist != null && Number.isFinite(Number(alias.minDist)) ? Number(alias.minDist) : 0.002,
    minTrailGapFromMarkFrac:
      alias.minGap != null && Number.isFinite(Number(alias.minGap)) ? Number(alias.minGap) : 0,
    supertrendUseFeeBreakeven: useFeeBeTrail,
    supertrendUseAdvancedTrail: useAdvTrail,
  };
}
