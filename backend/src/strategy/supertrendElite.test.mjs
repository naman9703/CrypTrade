import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEliteStRunCfg,
  buildEliteStOptsFromCfg,
  resolveHtf1hMinSep,
  ELITE_ST_TRAIL_PATCH,
  ELITE_PANEL_DEFAULT_SL_PCT,
  ELITE_PANEL_DEFAULT_TP_PCT,
  resolveEliteBracketCfg,
} from "./supertrendElite.js";

test("sanitizeEliteStContamination preserves saved trailing-stop panel knobs", () => {
  const saved = {
    trailingStopLossAuto: true,
    futuresTrailingStopMode: "SUPERTREND",
    futuresTrailingStAdvanced: true,
    futuresTrailingStFeeBreakeven: true,
    trailBufferMode: "ATR",
    trailBufferRate: 0.0015,
    trailBufferAtrMult: 0.5,
    trailPostT02ActivationBufferRate: 0.0025,
    trailPostT02SpacingFrac: 0.002,
    trailActivationSlippageFrac: 0.0002,
    trailT01LockSlippageFrac: 0.0001,
    trailMinSlDistFrac: 0.003,
    trailMinGapFromMarkFrac: 0.005,
    trailMaintMarginRate: 0.006,
    trailPostT02MaxExtraTiers: 120,
    trailSizingMode: "DYNAMIC",
    trailDynamicBeAtrMult: 0.6,
    trailDynamicAdvAtrHwmMult: 1.1,
  };
  const out = normalizeEliteStRunCfg(saved);
  assert.equal(out.trailBufferMode, "ATR");
  assert.equal(out.trailSizingMode, "DYNAMIC");
  assert.equal(out.trailDynamicBeAtrMult, 0.6);
  assert.equal(out.trailDynamicAdvAtrHwmMult, 1.1);
  assert.equal(out.trailBufferRate, 0.0015);
  assert.equal(out.trailBufferAtrMult, 0.5);
  assert.equal(out.trailPostT02ActivationBufferRate, 0.0025);
  assert.equal(out.trailPostT02SpacingFrac, 0.002);
  assert.equal(out.trailActivationSlippageFrac, 0.0002);
  assert.equal(out.trailT01LockSlippageFrac, 0.0001);
  assert.equal(out.trailMinSlDistFrac, 0.003);
  assert.equal(out.trailMinGapFromMarkFrac, 0.005);
  assert.equal(out.trailMaintMarginRate, 0.006);
  assert.equal(out.trailPostT02MaxExtraTiers, 120);
});

test("sanitizeEliteStContamination preserves saved 1H EMA min sep per symbol", () => {
  const btc = normalizeEliteStRunCfg({ symbol: "BTCUSDT", eliteStHtf1hMinSep: 0.0003 });
  assert.equal(btc.eliteStHtf1hMinSep, 0.0003);
  const bnb = normalizeEliteStRunCfg({ symbol: "BNBUSDT", eliteStHtf1hMinSep: 0.0008 });
  assert.equal(bnb.eliteStHtf1hMinSep, 0.0008);
});

test("sanitizeEliteStContamination does not inject default TP when saved off", () => {
  const out = normalizeEliteStRunCfg({
    trailingStopLossAuto: true,
    supertrendFuturesUseFixedTp: false,
    supertrendFuturesFixedTpPct: 0.015,
    supertrendFuturesUseFixedSl: true,
    supertrendFuturesFixedSlPct: 0.002,
  });
  assert.equal(out.supertrendFuturesUseFixedTp, false);
  assert.equal(out.supertrendFuturesFixedTpPct, 0.015);
  assert.equal(out.supertrendFuturesUseFixedSl, true);
  assert.equal(out.supertrendFuturesFixedSlPct, 0.002);
});

test("resolveEliteBracketCfg ships panel default SL/TP when brackets enabled", () => {
  const out = resolveEliteBracketCfg({ trailingStopLossAuto: true, supertrendFuturesUseFixedSl: true }, { trailingOn: true });
  assert.equal(out.supertrendFuturesUseFixedSl, true);
  assert.equal(out.supertrendFuturesFixedSlPct, ELITE_PANEL_DEFAULT_SL_PCT);
  assert.equal(out.supertrendFuturesUseFixedTp, true);
  assert.equal(out.supertrendFuturesFixedTpPct, ELITE_PANEL_DEFAULT_TP_PCT);
});

test("resolveEliteBracketCfg preserves custom SL/TP pct when brackets enabled", () => {
  const out = resolveEliteBracketCfg({
    trailingStopLossAuto: true,
    supertrendFuturesUseFixedSl: true,
    supertrendFuturesFixedSlPct: 0.008,
    supertrendFuturesUseFixedTp: true,
    supertrendFuturesFixedTpPct: 0.024,
  }, { trailingOn: true });
  assert.equal(out.supertrendFuturesFixedSlPct, 0.008);
  assert.equal(out.supertrendFuturesFixedTpPct, 0.024);
});

test("resolveEliteBracketCfg disables SL when panel bracket is off", () => {
  const out = resolveEliteBracketCfg({
    supertrendFuturesUseFixedSl: false,
    supertrendFuturesFixedSlPct: 0.015,
  }, { trailingOn: true });
  assert.equal(out.supertrendFuturesUseFixedSl, false);
  assert.equal(out.supertrendFuturesFixedSlPct, 0);
});

test("resolveEliteBracketCfg disables TP when panel bracket is off", () => {
  const out = resolveEliteBracketCfg({
    supertrendFuturesUseFixedTp: false,
    supertrendFuturesFixedTpPct: 0.03,
  }, { trailingOn: true });
  assert.equal(out.supertrendFuturesUseFixedTp, false);
  assert.equal(out.supertrendFuturesFixedTpPct, 0);
});

test("normalizeEliteStRunCfg preserves custom SL/TP pct when brackets enabled", () => {
  const out = normalizeEliteStRunCfg({
    trailingStopLossAuto: true,
    supertrendFuturesUseFixedSl: true,
    supertrendFuturesFixedSlPct: 0.008,
    supertrendFuturesUseFixedTp: true,
    supertrendFuturesFixedTpPct: 0.024,
  });
  assert.equal(out.supertrendFuturesFixedSlPct, 0.008);
  assert.equal(out.supertrendFuturesFixedTpPct, 0.024);
});

test("normalizeEliteStRunCfg disables SL when panel bracket is off", () => {
  const out = normalizeEliteStRunCfg({
    supertrendFuturesUseFixedSl: false,
    supertrendFuturesFixedSlPct: 0.015,
  });
  assert.equal(out.supertrendFuturesUseFixedSl, false);
  assert.equal(out.supertrendFuturesFixedSlPct, 0.015);
});

test("normalizeEliteStRunCfg disables TP when panel bracket is off", () => {
  const out = normalizeEliteStRunCfg({
    supertrendFuturesUseFixedTp: false,
    supertrendFuturesFixedTpPct: 0.03,
  });
  assert.equal(out.supertrendFuturesUseFixedTp, false);
  assert.equal(out.supertrendFuturesFixedTpPct, 0.03);
});

test("sanitizeEliteStContamination respects saved trailingStopLossAuto false", () => {
  const out = normalizeEliteStRunCfg({
    trailingStopLossAuto: false,
    intradaySmcMaxHoldBars: 48,
    supertrendFuturesUseFixedSl: false,
    supertrendFuturesFixedSlPct: 0.002,
    supertrendFuturesUseFixedTp: false,
    supertrendFuturesFixedTpPct: 0.015,
  });
  assert.equal(out.trailingStopLossAuto, false);
  assert.equal(out.intradaySmcMaxHoldBars, 0);
  assert.equal(out.supertrendFuturesUseFixedSl, false);
  assert.equal(out.supertrendFuturesFixedSlPct, 0.002);
  assert.equal(out.supertrendFuturesUseFixedTp, false);
  assert.equal(out.supertrendFuturesFixedTpPct, 0.015);
});

test("buildEliteStOptsFromCfg respects saved gate toggles (panel parity)", () => {
  const opts = buildEliteStOptsFromCfg({
    eliteStRequireHtf4hAlign: false,
    eliteStRequireHtf1hEmaAlign: false,
    eliteStMinAdx: 0,
    eliteStRequireAdxRising: false,
    eliteStMinVolumeVsAvg: 0,
    eliteStRequireAtrExpansion: false,
  });
  assert.equal(opts.requireHtf4hAlign, false);
  assert.equal(opts.requireHtf1hEmaAlign, false);
  assert.equal(opts.minAdx, 0);
  assert.equal(opts.requireAdxRising, false);
  assert.equal(opts.minVolumeVsAvg, 0);
  assert.equal(opts.requireAtrExpansion, false);
});

test("resolveEliteBracketCfg skips TP when trailing is off", () => {
  const out = resolveEliteBracketCfg({}, { trailingOn: false });
  assert.equal(out.supertrendFuturesUseFixedTp, false);
  assert.equal(out.supertrendFuturesFixedTpPct, 0);
  assert.equal(out.supertrendFuturesUseFixedSl, true);
});

test("resolveEliteBracketCfg TRAIL with profile sets ATR disaster SL", () => {
  const out = resolveEliteBracketCfg(
    {
      eliteStAutoBracketMode: "OFF",
      futuresLeverage: 10,
      _eliteCoinProfile: { medianAtrPct: 0.00855 },
    },
    { trailingOn: true },
  );
  assert.equal(out.supertrendFuturesUseFixedSl, true);
  assert.ok(Number(out.supertrendFuturesFixedSlPct) > 0.004);
  assert.equal(out.supertrendFuturesUseFixedTp, false);
  assert.equal(out.supertrendFuturesFixedTpPct, 0);
});

test("normalizeEliteStRunCfg preserves ADX sep when sep mode is ADX", () => {
  const btc = normalizeEliteStRunCfg({
    symbol: "BTCUSDT",
    eliteStHtf1hSepMode: "ADX",
    eliteStHtf1hMinSep: 0.0003,
  });
  assert.equal(btc.eliteStHtf1hMinSep, 0.0003);
  const bnb = normalizeEliteStRunCfg({
    symbol: "BNBUSDT",
    eliteStHtf1hSepMode: "ADX",
    eliteStHtf1hMinSep: 0.0008,
  });
  assert.equal(bnb.eliteStHtf1hMinSep, 0.0008);
});

test("buildEliteStOptsFromCfg maps dynamic sep fields", () => {
  const opts = buildEliteStOptsFromCfg({
    eliteStHtf1hSepMode: "PERCENTILE",
    eliteStHtf1hMinSepAtrMult: 0.3,
    eliteStHtf1hMinSepFloor: 0.00025,
    eliteStHtf1hMinSepCeil: 0.001,
    eliteStHtf1hSepPercentileLookback: 80,
    eliteStHtf1hSepPercentileMult: 1.1,
    eliteStHtf1hSepAdxBase: 0.00035,
    eliteStHtf1hSepAdxAlpha: 1.2,
    eliteStHtf1hSepAdxRef: 22,
    eliteStHtf1hSepCalibratePct: 45,
    eliteStHtf1hSepCalibrateBars: 100,
  });
  assert.equal(opts.htf1hSepMode, "PERCENTILE");
  assert.equal(opts.htf1hMinSepAtrMult, 0.3);
  assert.equal(opts.htf1hMinSepFloor, 0.00025);
  assert.equal(opts.htf1hMinSepCeil, 0.001);
  assert.equal(opts.htf1hSepPercentileLookback, 80);
  assert.equal(opts.htf1hSepPercentileMult, 1.1);
  assert.equal(opts.htf1hSepAdxBase, 0.00035);
  assert.equal(opts.htf1hSepAdxAlpha, 1.2);
  assert.equal(opts.htf1hSepAdxRef, 22);
  assert.equal(opts.htf1hSepCalibratePct, 45);
  assert.equal(opts.htf1hSepCalibrateBars, 100);
});

test("resolveHtf1hMinSep ATR mode scales with 1H ATR / price", () => {
  const ctx = { h1Ema50: [100], h1Atr: [2], h1SepSeries: [], h1Adx: [] };
  const sep = resolveHtf1hMinSep(
    { htf1hSepMode: "ATR", htf1hMinSepAtrMult: 0.25, htf1hMinSepFloor: 0.0002, htf1hMinSepCeil: 0.01 },
    0,
    ctx,
  );
  assert.equal(sep, 0.005);
});

test("resolveHtf1hMinSep ADX mode tightens sep when ADX is below ref", () => {
  const ctx = { h1Ema50: [100], h1Atr: [], h1SepSeries: [], h1Adx: [10] };
  const sep = resolveHtf1hMinSep(
    {
      htf1hSepMode: "ADX",
      htf1hSepAdxBase: 0.0003,
      htf1hSepAdxAlpha: 1.5,
      htf1hSepAdxRef: 25,
      htf1hMinSepFloor: 0,
      htf1hMinSepCeil: 0.01,
    },
    0,
    ctx,
  );
  const expected = 0.0003 * (1 + 1.5 * ((25 - 10) / 25));
  assert.ok(Math.abs(sep - expected) < 1e-9);
});

test("resolveHtf1hMinSep FIXED mode returns constant", () => {
  const sep = resolveHtf1hMinSep(
    { htf1hSepMode: "FIXED", htf1hMinSep: 0.0005 },
    0,
    { h1Ema50: [100], h1Atr: [2], h1SepSeries: [], h1Adx: [30] },
  );
  assert.equal(sep, 0.0005);
});
