import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLiquidityMapRunCfg,
  sanitizeLiquidityMapContamination,
  buildLiquidityMapOptsFromCfg,
  buildBrackets,
  dynamicSlPrice,
  dynamicSlPriceWithRegime,
  effectiveAtrSlMult,
  evaluateLiquidityMapSetup,
  resolveOpposingLevel,
  resolveLiquidityMapDynamicExitPolicy,
  scoreLiquidityMapQuality,
} from "./liquidityMapStrategy.js";
import { precomputeIntraday } from "./intradayPro.js";
import { resolveLiquidityMapThresholds } from "./techniques/liquidityMap.js";
import {
  applyLiqMapAutoCalibrateCfg,
  buildLiqMapCoinProfile,
  resolveLiqMapDynamicTuning,
} from "./liquidityMapAutoCalibrate.js";

test("sanitizeLiquidityMapContamination zeros leaked fixed bracket pcts", () => {
  const c = sanitizeLiquidityMapContamination({
    supertrendFuturesUseFixedSl: true,
    supertrendFuturesUseFixedTp: true,
    supertrendFuturesFixedSlPct: 0.00005,
    supertrendFuturesFixedTpPct: 0.00005,
  });
  assert.equal(c.supertrendFuturesFixedSlPct, 0);
  assert.equal(c.supertrendFuturesFixedTpPct, 0);
});

test("normalizeLiquidityMapRunCfg PARTIAL_RUNNER books TP1 partial then trails runner", () => {
  const c = normalizeLiquidityMapRunCfg({ liqMapExitMode: "PARTIAL_RUNNER", liqMapTrailMode: "SUPERTREND" });
  assert.equal(c.intradayLiqTp1Enabled, true);
  assert.equal(c.intradayLiqPartialTp, true);
  assert.equal(c.intradayLiqTp2Enabled, false);
  assert.equal(c.intradayLiqBreakevenAfterPartial, false);
  // TP path stays ON so the TP1 partial actually fires; TP2 is off so the runner trails.
  assert.equal(c.supertrendFuturesUseFixedTp, true);
  assert.equal(c.trailingStopLossAuto, true);
  assert.equal(c.trailOnlyAfterPartialFill, true);
  assert.equal(c.futuresTrailingStopMode, "SUPERTREND");
});

test("normalizeLiquidityMapRunCfg SCALED_FIXED uses full-size opposing-pool TP, no trailing", () => {
  const c = normalizeLiquidityMapRunCfg({ liqMapExitMode: "SCALED_FIXED", liqMapMaxTpRr: 8 });
  assert.equal(c.intradayLiqTp1Enabled, false);
  assert.equal(c.intradayLiqPartialTp, false);
  assert.equal(c.intradayLiqTp2Enabled, true);
  assert.equal(c.intradayLiqBreakevenAfterPartial, false);
  assert.equal(c.supertrendFuturesUseFixedTp, true);
  assert.equal(c.trailingStopLossAuto, false);
  assert.equal(c.intradayLiqMaxTpRr, 8);
});

test("normalizeLiquidityMapRunCfg defaults to fixed structural SL/TP", () => {
  const c = normalizeLiquidityMapRunCfg({});
  assert.equal(c.intradayLiqTp1Enabled, false);
  assert.equal(c.intradayLiqPartialTp, false);
  assert.equal(c.intradayLiqTp2Enabled, true);
  assert.equal(c.trailingStopLossAuto, false);
  assert.equal(c.supertrendFuturesUseFixedTp, true);
  assert.equal(c.intradayLiqBreakevenAfterPartial, false);
  assert.equal(c.liqMapDeadTradeExitBars, 0);
  assert.equal(c.liqMapDeadTradeMinMfeR, 0.5);
  assert.equal(c.liqMapDeadTradeMaxLossR, 0.55);
});

test("normalizeLiquidityMapRunCfg honors explicit trail ST knobs", () => {
  const c = normalizeLiquidityMapRunCfg({
    liqMapExitMode: "PARTIAL_RUNNER",
    liqMapTrailStPeriod: 14,
    liqMapTrailStMult: 2.5,
  });
  assert.equal(c.supertrendPeriod, 14);
  assert.equal(c.supertrendMultiplier, 2.5);
});

test("normalizeLiquidityMapRunCfg DYNAMIC_ATR routes to dynamic Chandelier/MFE runner", () => {
  const c = normalizeLiquidityMapRunCfg({
    liqMapExitMode: "PARTIAL_RUNNER",
    liqMapTrailMode: "DYNAMIC_ATR",
    liqMapTrailAtrHwmMult: 2.2,
    liqMapTrailMfeGiveback: 0.25,
    liqMapTrailMfeMinR: 1.2,
    liqMapTrailMergeSt: false,
  });
  assert.equal(c.intradayLiqTp1Enabled, true);
  assert.equal(c.intradayLiqTp2Enabled, false);
  assert.equal(c.trailingStopLossAuto, true);
  assert.equal(c.trailOnlyAfterPartialFill, true);
  assert.equal(c.futuresTrailingStopMode, "SUPERTREND");
  assert.equal(c.trailSizingMode, "DYNAMIC");
  assert.equal(c.futuresTrailingStAdvanced, true);
  assert.equal(c.futuresTrailingStFeeBreakeven, false);
  assert.equal(c.trailDynamicAdvAtrHwmMult, 2.2);
  assert.equal(c.trailDynamicAdvMfeGivebackFrac, 0.25);
  assert.equal(c.trailDynamicAdvMfeMinR, 1.2);
  assert.equal(c.trailDynamicAdvMergeSupertrend, false);
  assert.equal(c.trailDynamicAdvAtrSource, "ROLLING");
});

test("resolveLiquidityMapThresholds preserves fixed percent fallback", () => {
  const fixed = resolveLiquidityMapThresholds({
    liqMapNormalizeThresholds: false,
    refAtrPct: 0.012,
    liqMapSweepPct: 0.0006,
    liqMapEqualTolPct: 0.0008,
    liqMapSweepAtrFrac: 0.13,
    liqMapEqualTolAtrFrac: 0.18,
  });
  assert.equal(fixed.normalized, false);
  assert.equal(fixed.sweepPct, 0.0006);
  assert.equal(fixed.equalTolPct, 0.0008);

  const missingAtr = resolveLiquidityMapThresholds({ refAtrPct: 0 });
  assert.equal(missingAtr.normalized, false);
  assert.equal(missingAtr.sweepPct, 0.0006);
  assert.equal(missingAtr.equalTolPct, 0.0008);
});

test("resolveLiquidityMapThresholds scales BTC-calibrated thresholds by ATR", () => {
  const btcLike = resolveLiquidityMapThresholds({
    refAtrPct: 0.0046,
    liqMapSweepPct: 0.0006,
    liqMapEqualTolPct: 0.0008,
    liqMapSweepAtrFrac: 0.13,
    liqMapEqualTolAtrFrac: 0.18,
  });
  assert.equal(btcLike.normalized, true);
  assert.ok(Math.abs(btcLike.sweepPct - 0.0006) < 1e-12, "BTC keeps old sweep floor");
  assert.ok(Math.abs(btcLike.equalTolPct - 0.000828) < 1e-12, "BTC equal tolerance stays near old value");

  const solLike = resolveLiquidityMapThresholds({
    refAtrPct: 0.011,
    liqMapSweepPct: 0.0006,
    liqMapEqualTolPct: 0.0008,
    liqMapSweepAtrFrac: 0.13,
    liqMapEqualTolAtrFrac: 0.18,
  });
  assert.ok(solLike.sweepPct > btcLike.sweepPct, "higher-vol coin requires bigger pierce");
  assert.ok(solLike.equalTolPct > btcLike.equalTolPct, "higher-vol coin clusters levels with wider tolerance");
});

test("LIQUIDITY_MAP auto-calibration derives bounded profile rules from warmup bars", () => {
  const candles = Array.from({ length: 120 }, (_, i) => {
    const close = 100 + i * 0.1;
    return {
      ts: i * 60_000,
      open: close - 0.3,
      high: close + 1.2,
      low: close - 1.2,
      close,
      volume: 1000 + (i % 7) * 50,
    };
  });
  const profile = buildLiqMapCoinProfile(candles, { profileBars: 90 });
  assert.equal(profile.profileBars, 90);
  assert.ok(profile.medianAtrPct > 0, "profile has ATR percent");

  const tuning = resolveLiqMapDynamicTuning(profile, {
    sweepAtrFrac: 0.13,
    equalTolAtrFrac: 0.18,
    atrSlMult: 1,
    minQualityScore: 6.2,
  });
  assert.ok(tuning.sweepAtrFrac >= 0.1 && tuning.sweepAtrFrac <= 0.32);
  assert.ok(tuning.equalTolAtrFrac >= 0.12 && tuning.equalTolAtrFrac <= 0.36);
  assert.ok(tuning.atrSlMult >= 0.75 && tuning.atrSlMult <= 1.4);
  assert.ok(tuning.minQualityScore >= 5.6 && tuning.minQualityScore <= 7.8);
  assert.ok(tuning.dynamicExitQualityHi >= tuning.dynamicExitQualityMid);
  assert.ok(tuning.dynamicExitRrHi >= tuning.dynamicExitRrMid);

  const cfg = applyLiqMapAutoCalibrateCfg({ liqMapAutoCalibrate: true }, candles);
  assert.equal(cfg.liqMapNormalizeThresholds, true);
  assert.ok(cfg._liqMapCoinProfile);
  assert.ok(cfg._liqMapDynamicTuning);
});

test("LIQUIDITY_MAP auto-calibration tightens quality for noisy/choppy coin profiles", () => {
  const clean = resolveLiqMapDynamicTuning(
    {
      medianAtrPct: 0.0046,
      p90AtrPct: 0.005,
      atrSpread: 1.08,
      medianAdx: 31,
      medianVolRatio: 1.12,
      medianRangeAtr: 1.4,
      medianBodyRange: 0.45,
    },
    { minQualityScore: 6.2 },
  );
  const noisy = resolveLiqMapDynamicTuning(
    {
      medianAtrPct: 0.011,
      p90AtrPct: 0.018,
      atrSpread: 1.64,
      medianAdx: 15,
      medianVolRatio: 0.9,
      medianRangeAtr: 2.6,
      medianBodyRange: 0.22,
    },
    { minQualityScore: 6.2 },
  );

  assert.ok(noisy.minQualityScore > clean.minQualityScore, "noisy/choppy coins require stronger sweeps");
  assert.ok(noisy.sweepAtrFrac > clean.sweepAtrFrac, "noisy coins require deeper ATR-normalized pierces");
  assert.ok(noisy.dynamicExitQualityHi > clean.dynamicExitQualityHi, "runner extension tier follows coin quality profile");
});

test("scoreLiquidityMapQuality rewards clean sweep/reclaim with target room", () => {
  const candles = [
    { open: 100, high: 101, low: 99, close: 100, volume: 1000 },
    { open: 100, high: 101.5, low: 98.8, close: 100.8, volume: 1800 },
  ];
  const pre = { adxSeries: [20, 24], htfUp: [true, true], htfDown: [false, false] };
  const opts = buildLiquidityMapOptsFromCfg({ liqMapQualityGate: true, liqMapMinQualityScore: 6 });
  const event = {
    side: "BUY",
    level: 99.2,
    entry: 100.8,
    wickPrice: 98.8,
    extension: 0.004,
    wickRatio: 0.6,
    bodyRatio: 0.3,
    rvol: 1.8,
    touches: 2,
    poolScore: 12,
  };
  const quality = scoreLiquidityMapQuality(event, candles, pre, 1, opts, { rr: 3 }, 0.004, 45);
  assert.equal(quality.passed, true);
  assert.ok(quality.score >= 6);
  assert.ok(quality.components.targetRoom > 0);
});

test("scoreLiquidityMapQuality rejects shallow noisy sweep", () => {
  const candles = [
    { open: 100, high: 100.4, low: 99.7, close: 100, volume: 1000 },
    { open: 100, high: 100.2, low: 99.6, close: 99.95, volume: 900 },
  ];
  const pre = { adxSeries: [12, 12], htfUp: [false, false], htfDown: [false, false] };
  const opts = buildLiquidityMapOptsFromCfg({ liqMapQualityGate: true, liqMapMinQualityScore: 6 });
  const event = {
    side: "BUY",
    level: 99.7,
    entry: 99.95,
    wickPrice: 99.6,
    extension: 0.0005,
    wickRatio: 0.18,
    bodyRatio: 0.08,
    rvol: 0.9,
    touches: 1,
    poolScore: 3,
  };
  const quality = scoreLiquidityMapQuality(event, candles, pre, 1, opts, { rr: 1.2 }, 0.008, 90);
  assert.equal(quality.passed, false);
  assert.ok(quality.score < 6);
  assert.ok(quality.diagnostics.penalty > 0);
});

test("resolveLiquidityMapDynamicExitPolicy widens runners only for high-quality target-room trades", () => {
  const opts = buildLiquidityMapOptsFromCfg({
    liqMapDynExitQualityHi: 6.4,
    liqMapDynExitQualityMid: 5.8,
    liqMapDynExitPartialHi: 0.35,
    liqMapDynExitPartialMid: 0.5,
    liqMapDynExitPartialBase: 0.75,
    liqMapDynExitTrailAtrHi: 5.5,
    liqMapDynExitTrailAtrMid: 4.5,
    liqMapDynExitTrailAtrBase: 3.0,
  });

  const high = resolveLiquidityMapDynamicExitPolicy(opts, { score: 7.1 }, { rr: 4.2 });
  assert.equal(high.tier, "HIGH_EXTENSION");
  assert.equal(high.partialFrac, 0.5);
  assert.equal(high.tp1Rr, 0.75);
  assert.equal(high.trailOverrides.trailDynamicAdvAtrHwmMult, 5.5);
  assert.equal(high.trailOverrides.trailDynamicAdvMfeGivebackFrac, 0.5);
  assert.equal(high.trailOverrides.trailDynamicAdvMfeMinR, 1.5);
  assert.equal(high.trailOverrides.trailDynamicAdvPostT02StepAtrMult, 0.6);
  assert.equal(high.trailOverrides.trailDynamicAdvMergeSupertrend, false);

  const mid = resolveLiquidityMapDynamicExitPolicy(opts, { score: 6.0, minScore: 5.8 }, { rr: 2.3 });
  assert.equal(mid.tier, "MID_EXTENSION");
  assert.equal(mid.partialFrac, 0.6);
  assert.equal(mid.trailOverrides.trailDynamicAdvAtrHwmMult, 4.5);
  assert.equal(mid.trailOverrides.trailDynamicAdvMfeMinR, 1.2);

  const base = resolveLiquidityMapDynamicExitPolicy(opts, { score: 5.9, minScore: 5.8 }, { rr: 1.6 });
  assert.equal(base.tier, "BASE_BANK");
  assert.equal(base.partialFrac, 0.75);
  assert.equal(base.trailOverrides.trailDynamicAdvAtrHwmMult, 3.0);
  assert.equal(base.trailOverrides.trailDynamicAdvMfeGivebackFrac, 0.4);
});

test("resolveLiquidityMapDynamicExitPolicy routes failed-quality sweeps to defensive TP1", () => {
  const opts = buildLiquidityMapOptsFromCfg({
    liqMapMinQualityScore: 6.8,
    liqMapDynExitWeakTp1Rr: 0.7,
    liqMapDynExitPartialBase: 0.75,
    liqMapDynExitTrailAtrBase: 2.2,
  });
  const policy = resolveLiquidityMapDynamicExitPolicy(opts, { score: 5.9, minScore: 6.8 }, { rr: 1.4 });
  assert.equal(policy.tier, "DEFENSIVE_SCALP");
  assert.equal(policy.partialFrac, 0.75);
  assert.equal(policy.tp1Rr, 0.7);
  assert.equal(policy.trailOverrides.trailDynamicAdvAtrSource, "ROLLING");
});

test("evaluateLiquidityMapSetup structural entry waits for MSS and FVG retrace", () => {
  const candles = Array.from({ length: 130 }, (_, i) => ({
    ts: Date.UTC(2026, 0, 1, 0, i * 15),
    open: 99.6,
    high: 99.9,
    low: 99.2,
    close: 99.6,
    volume: 1000,
  }));
  Object.assign(candles[122], { open: 99.3, high: 99.7, low: 98.0, close: 99.2, volume: 1100 });
  Object.assign(candles[124], { open: 99.4, high: 100.2, low: 99.1, close: 99.8, volume: 1100 });
  Object.assign(candles[126], { open: 98.4, high: 98.8, low: 97.7, close: 98.3, volume: 1800 });
  Object.assign(candles[127], { open: 98.3, high: 99.0, low: 98.2, close: 98.8, volume: 1200 });
  Object.assign(candles[128], { open: 100.7, high: 102.2, low: 100.6, close: 102.0, volume: 2200 });
  Object.assign(candles[129], { open: 101.0, high: 101.4, low: 99.4, close: 100.0, volume: 1500 });

  const pre = precomputeIntraday(candles);
  const baseCfg = {
    liqMapEntryModel: "STRUCTURAL",
    liqMapRequireMss: true,
    liqMapRequireRetrace: true,
    liqMapHtfMode: "none",
    liqMapQualityGate: false,
    liqMapOnePerDay: false,
    liqMapMinRvol: 1.05,
    liqMapMinWickRatio: 0.2,
    liqMapMssRequireDisplacement: true,
    liqMapDisplacementBodyMult: 1.0,
    liqMapDisplacementAtrMult: 0.1,
    liqMapEntryZoneMode: "FVG",
    liqMapFvgEntryMode: "ZONE",
    liqMapStrictPdZone: true,
    liqMapMaxSlPct: 0.1,
    liqMapRequireDirectionalClose: false,
    liqMapMaxOpposingRr: 0,
  };

  assert.equal(evaluateLiquidityMapSetup(candles, 126, pre, baseCfg, {}), null, "does not enter on sweep close");
  assert.equal(evaluateLiquidityMapSetup(candles, 128, pre, baseCfg, {}), null, "does not enter on MSS candle");
  const signal = evaluateLiquidityMapSetup(candles, 129, pre, baseCfg, {});
  assert.ok(signal, "enters only on the post-MSS FVG retrace");
  assert.equal(signal.action, "BUY");
  assert.ok(signal.techniques.includes("mss"));
  assert.ok(signal.techniques.includes("fvg"));
  assert.equal(signal.smcMeta.entryZone, "fvg");
  assert.equal(signal.smcMeta.sweepReclaimIdx, 126);
  assert.equal(signal.smcMeta.mssIdx, 128);
});

test("dynamicSlPrice falls back to wick stop when ATR is off/zero", () => {
  const opts = buildLiquidityMapOptsFromCfg({ liqMapAtrSlMult: 0, liqMapSlBufferPct: 0.01, liqMapSlBufferAtrFrac: 0 });
  const longSl = dynamicSlPrice("BUY", 99, 100, 50, opts);
  assert.ok(Math.abs(longSl - 99 * (1 - 0.01)) < 1e-6, "pure wick stop for long");
  const shortSl = dynamicSlPrice("SELL", 101, 100, 50, opts);
  assert.ok(Math.abs(shortSl - 101 * (1 + 0.01)) < 1e-6, "pure wick stop for short");
});

test("dynamicSlPrice widens to ATR floor when wick stop is too tight", () => {
  // Wick stop is ~0.2% away, ATR floor (1×ATR=2.0 → 2%) should dominate.
  const opts = buildLiquidityMapOptsFromCfg({
    liqMapAtrSlMult: 1.0,
    liqMapSlBufferPct: 0.001,
    liqMapSlRegimeAdjust: false,
    liqMapMaxOpposingRr: 0,
  });
  const longSl = dynamicSlPrice("BUY", 99.9, 100, 2.0, opts);
  assert.ok(Math.abs(longSl - 98.0) < 1e-6, "long stop floored at entry-1*ATR");
  const shortSl = dynamicSlPrice("SELL", 100.1, 100, 2.0, opts);
  assert.ok(Math.abs(shortSl - 102.0) < 1e-6, "short stop floored at entry+1*ATR");
});

test("dynamicSlPrice buffers sweep wick by ATR fraction instead of large fixed percent", () => {
  const opts = buildLiquidityMapOptsFromCfg({
    liqMapAtrSlMult: 0,
    liqMapSlBufferPct: 0.001,
    liqMapSlBufferAtrFrac: 0.25,
  });
  const longSl = dynamicSlPrice("BUY", 99, 100, 2, opts);
  assert.ok(Math.abs(longSl - 98.5) < 1e-6, "long stop uses 0.25 ATR buffer beyond wick");
  const shortSl = dynamicSlPrice("SELL", 101, 100, 2, opts);
  assert.ok(Math.abs(shortSl - 101.5) < 1e-6, "short stop uses 0.25 ATR buffer beyond wick");
});

test("dynamicSlPrice REVERSAL_WICK keeps stop at sweep candle wick despite ATR", () => {
  const opts = buildLiquidityMapOptsFromCfg({
    liqMapSlMode: "REVERSAL_WICK",
    liqMapAtrSlMult: 2.0,
    liqMapSlBufferPct: 0.001,
    liqMapSlBufferAtrFrac: 0,
  });
  const longSl = dynamicSlPrice("BUY", 99.9, 100, 2.0, opts);
  assert.ok(Math.abs(longSl - 99.9 * (1 - 0.001)) < 1e-6, "long stop stays below wick");
  const shortSl = dynamicSlPrice("SELL", 100.1, 100, 2.0, opts);
  assert.ok(Math.abs(shortSl - 100.1 * (1 + 0.001)) < 1e-6, "short stop stays above wick");
});

test("buildBrackets with REVERSAL_WICK makes TP1 easier than ATR floor", () => {
  const event = { side: "BUY", entry: 100, wickPrice: 99.9, poolType: "swing_low", level: 99.95, score: 6 };
  const atrOpts = buildLiquidityMapOptsFromCfg({
    liqMapAtrSlMult: 1.0,
    liqMapSlBufferPct: 0.001,
    liqMapSlBufferAtrFrac: 0,
    liqMapSlRegimeAdjust: false,
    liqMapMaxOpposingRr: 0,
  });
  const wickOpts = buildLiquidityMapOptsFromCfg({
    liqMapSlMode: "REVERSAL_WICK",
    liqMapAtrSlMult: 0,
    liqMapSlBufferPct: 0.001,
    liqMapSlBufferAtrFrac: 0,
    liqMapMaxOpposingRr: 0,
  });
  const atrBr = buildBrackets(event, {}, atrOpts, 130, 2.0);
  const wickBr = buildBrackets(event, {}, wickOpts, 130, 2.0);
  assert.ok(wickBr.slPct < atrBr.slPct, "wick stop has smaller risk");
  assert.ok(wickBr.tp1Pct < atrBr.tp1Pct, "smaller risk makes TP1 closer");
});

test("dynamicSlPriceWithRegime tightens calm-vol ATR floor and widens high-vol floor", () => {
  const opts = buildLiquidityMapOptsFromCfg({
    liqMapAtrSlMult: 1,
    liqMapSlBufferPct: 0,
    liqMapMaxSlPct: 0.1,
    liqMapSlRegimeLowMult: 0.5,
    liqMapSlRegimeHighMult: 1.5,
  });
  assert.equal(effectiveAtrSlMult(opts, 20), 0.5);
  assert.equal(effectiveAtrSlMult(opts, 80), 1.5);
  const calmLongSl = dynamicSlPriceWithRegime("BUY", 99.9, 100, 2, opts, 20);
  const highVolLongSl = dynamicSlPriceWithRegime("BUY", 99.9, 100, 2, opts, 80);
  assert.ok(Math.abs(calmLongSl - 99) < 1e-6, "calm regime uses 0.5 ATR floor");
  assert.ok(Math.abs(highVolLongSl - 97) < 1e-6, "high-vol regime uses 1.5 ATR floor");
});

test("dynamicSlPrice keeps structural wick stop when wick is already beyond ATR floor", () => {
  // Wick is 3% away, ATR floor only 1% → keep the wider structural stop.
  const opts = buildLiquidityMapOptsFromCfg({ liqMapAtrSlMult: 1.0, liqMapSlBufferPct: 0, liqMapSlBufferAtrFrac: 0 });
  const longSl = dynamicSlPrice("BUY", 97, 100, 1.0, opts);
  assert.ok(Math.abs(longSl - 97) < 1e-6, "structural wick stop preserved");
});

test("buildBrackets uses ATR-floored stop, scaling R-targets with volatility", () => {
  const opts = buildLiquidityMapOptsFromCfg({
    liqMapAtrSlMult: 1.0,
    liqMapSlBufferPct: 0.001,
    liqMapSlRegimeAdjust: false,
    liqMapMaxOpposingRr: 0,
  });
  const event = { side: "BUY", entry: 100, wickPrice: 99.9, poolType: "swing_low", level: 99.95, score: 6 };
  const br = buildBrackets(event, {}, opts, 130, 2.0);
  const risk = 100 - br.slPrice;
  assert.ok(Math.abs(risk - 2.0) < 1e-6, "risk floored to 1*ATR");
  assert.ok(Math.abs(br.tp1Price - 102.0) < 1e-6, "tp1 = entry + 1R (ATR-scaled)");
});

test("buildBrackets long: TP1 at +1R, TP2 = opposing pool when within cap", () => {
  const opts = buildLiquidityMapOptsFromCfg({});
  const event = {
    side: "BUY",
    entry: 100,
    wickPrice: 99,
    poolType: "equal_low",
    level: 99.5,
    score: 8,
    touches: 2,
    extension: 0.001,
    wickRatio: 0.5,
    rvol: 1.5,
  };
  const br = buildBrackets(event, {}, opts, 102);
  assert.ok(br, "bracket built");
  const risk = 100 - br.slPrice;
  assert.ok(Math.abs(br.tp1Price - (100 + risk)) < 1e-6, "tp1 at +1R");
  assert.ok(Math.abs(br.tp2Price - 102) < 1e-6, "tp2 at opposing pool");
  assert.equal(br.partialTp, true);
  assert.equal(br.tp2Enabled, true);
});

test("buildBrackets long: TP2 capped at maxTpRr when opposing pool is far", () => {
  const opts = buildLiquidityMapOptsFromCfg({ liqMapMaxTpRr: 5, liqMapMaxOpposingRr: 0 });
  const event = { side: "BUY", entry: 100, wickPrice: 99, poolType: "swing_low", level: 99.5, score: 6 };
  const br = buildBrackets(event, {}, opts, 1000);
  const risk = 100 - br.slPrice;
  assert.ok(Math.abs(br.tp2Price - (100 + 5 * risk)) < 1e-6, "tp2 capped at 5R");
  assert.equal(br.mapMeta.opposingCapped, true);
});

test("buildBrackets fixed TP rejects opposing pool beyond max opposing RR", () => {
  const opts = buildLiquidityMapOptsFromCfg({ liqMapMaxOpposingRr: 2 });
  const event = { side: "BUY", entry: 100, wickPrice: 99, poolType: "swing_low", level: 99.5, score: 6 };
  const br = buildBrackets(event, { liqMapExitMode: "SCALED_FIXED" }, opts, 110);
  assert.equal(br, null);
});

test("buildBrackets DYNAMIC_ATR uses relaxed runner target cap", () => {
  const opts = buildLiquidityMapOptsFromCfg({ liqMapMaxTpRr: 5, liqMapDynamicRunnerMaxTpRr: 12, liqMapMaxOpposingRr: 0 });
  const cfg = { liqMapExitMode: "PARTIAL_RUNNER", liqMapTrailMode: "DYNAMIC_ATR" };
  const event = { side: "BUY", entry: 100, wickPrice: 99, poolType: "swing_low", level: 99.5, score: 6 };
  const br = buildBrackets(event, cfg, opts, 1000);
  const risk = 100 - br.slPrice;
  assert.ok(Math.abs(br.tp2Price - (100 + 12 * risk)) < 1e-6, "dynamic runner target capped at relaxed cap");
  assert.equal(br.mapMeta.dynamicRunnerTarget, true);
});

test("resolveOpposingLevel DYNAMIC_ATR prefers extension target beyond nearby minor pools", () => {
  const opts = buildLiquidityMapOptsFromCfg({
    liqMapExitMode: "PARTIAL_RUNNER",
    liqMapTrailMode: "DYNAMIC_ATR",
    liqMapProjectedTpAtrMult: 4,
    liqMapProjectedTpRangeMult: 0,
  });
  const candles = Array.from({ length: 30 }, (_, i) => ({
    high: i === 29 ? 102 : 101,
    low: 99,
    close: 100,
  }));
  const pre = { prevDayHigh: [], prevWeekHigh: [], prevDayLow: [], prevWeekLow: [] };
  pre.prevDayHigh[29] = 103;
  const level = resolveOpposingLevel(candles, 29, pre, "BUY", 100, opts, 3, 1);
  assert.equal(level, 104);
});

test("buildBrackets short mirrors long", () => {
  const opts = buildLiquidityMapOptsFromCfg({});
  const event = { side: "SELL", entry: 100, wickPrice: 101, poolType: "equal_high", level: 100.5, score: 8 };
  const br = buildBrackets(event, {}, opts, 98);
  const risk = br.slPrice - 100;
  assert.ok(br.slPrice > 100, "stop above entry for short");
  assert.ok(Math.abs(br.tp1Price - (100 - risk)) < 1e-6, "tp1 at +1R below entry");
  assert.ok(Math.abs(br.tp2Price - 98) < 1e-6, "tp2 at opposing pool below entry");
});

test("buildBrackets rejects setups exceeding liqMapMaxSlPct", () => {
  const opts = buildLiquidityMapOptsFromCfg({ liqMapMaxSlPct: 0.005 });
  const event = { side: "BUY", entry: 100, wickPrice: 95, poolType: "swing_low", level: 97, score: 6 };
  const br = buildBrackets(event, {}, opts, 120);
  assert.equal(br, null);
});
