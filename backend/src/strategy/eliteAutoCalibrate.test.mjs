import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEliteCoinProfile,
  resolveEliteMinAdx,
  resolveEliteMinVolume,
  resolveEliteBracketPct,
  resolveEliteDynamicTuning,
  resolveEliteSepMode,
  resolveEliteStMultiplier,
  resolveEliteBracketStyle,
  resolveEliteTrailDisasterSlPct,
  resolveEliteLiquidationDistPct,
  applyEliteAutoCalibrateCfg,
  applyEliteBracketStyleToCfg,
  ELITE_TUNING_REFERENCE,
  ELITE_TIGHT_SL_PCT,
} from "./eliteAutoCalibrate.js";
import { normalizeEliteStRunCfg, prepareEliteRunCfg } from "./supertrendElite.js";

function synthCandles(n, { base = 100, drift = 0.001, vol = 2 } = {}) {
  const out = [];
  let p = base;
  for (let i = 0; i < n; i++) {
    const ts = Date.UTC(2025, 0, 1) + i * 3600_000;
    const o = p;
    p = p * (1 + drift + (i % 5 === 0 ? vol / p : 0));
    const h = Math.max(o, p) * 1.002;
    const l = Math.min(o, p) * 0.998;
    out.push({ ts, open: o, high: h, low: l, close: p, volume: 1000 + i * 10 });
  }
  return out;
}

test("buildEliteCoinProfile returns finite medians from synthetic 1H series", () => {
  const candles = synthCandles(200);
  const p = buildEliteCoinProfile(candles, { profileBars: 90 });
  assert.ok(p.medianAtrPct > 0);
  assert.ok(p.medianAdx >= 0);
  assert.ok(p.medianVolRatio > 0);
  assert.equal(p.profileBars, 90);
});

test("resolveEliteMinAdx clamps to floor/ceil", () => {
  const lo = resolveEliteMinAdx({ p40Adx: 5 }, { minAdxFloor: 15, minAdxCeil: 30 });
  assert.equal(lo, 15);
  const hi = resolveEliteMinAdx({ p40Adx: 50 }, { minAdxFloor: 15, minAdxCeil: 30 });
  assert.equal(hi, 30);
});

test("resolveEliteBracketPct scales with median ATR%", () => {
  const low = resolveEliteBracketPct({ medianAtrPct: 0.003 });
  const high = resolveEliteBracketPct({ medianAtrPct: 0.012 });
  assert.ok(high.slPct > low.slPct);
  assert.ok(high.tpPct > low.tpPct);
});

test("applyEliteAutoCalibrateCfg sets dynamic sep/ST and ATR brackets", () => {
  const candles = synthCandles(120);
  const out = applyEliteAutoCalibrateCfg(
    { eliteStAutoCalibrate: true, eliteStAutoFullTune: true, eliteStMinAdx: 20, eliteStAutoBracketMode: "ATR" },
    candles,
  );
  assert.ok(["ADX", "PERCENTILE", "FIXED", "CALIBRATED"].includes(out.eliteStHtf1hSepMode));
  assert.ok(Number(out.supertrendMultiplier) >= 3);
  assert.ok(Number(out._eliteDynamicTuning?.stMultiplier) >= 3);
  assert.ok(Number(out.supertrendFuturesFixedSlPct) > 0);
  assert.ok(Number(out._eliteCoinProfile.medianAtrPct) > 0);
});

test("profile rules match all 14 sweep reference profiles", () => {
  for (const ref of ELITE_TUNING_REFERENCE) {
    const profile = {
      medianAtrPct: ref.atr,
      medianAdx: ref.adx,
      p40Adx: ref.p40Adx,
      medianVolRatio: ref.vol,
      p40H1EmaSep: ref.p40EmaSep,
      medianH1EmaSep: ref.p40EmaSep,
    };
    assert.equal(resolveEliteSepMode(profile), ref.sep, `${ref.symbol} sep`);
    assert.equal(resolveEliteStMultiplier(profile), ref.stM, `${ref.symbol} stM`);
    assert.equal(resolveEliteBracketStyle(profile), ref.bracket, `${ref.symbol} bracket`);
  }
});

test("resolveEliteDynamicTuning uses profile rules for BNB-like warmup", () => {
  const t = resolveEliteDynamicTuning({
    medianAtrPct: 0.00457,
    medianAdx: 27,
    p40Adx: 24.4,
    medianVolRatio: 0.957,
    p40H1EmaSep: 0.00374,
    medianH1EmaSep: 0.004,
  });
  assert.equal(t.sepMode, "FIXED");
  assert.equal(t.stMultiplier, 3);
  assert.equal(t.bracketStyle, "ATR");
  assert.equal(t.tuneSource, "profile_rules");
});

test("resolveEliteDynamicTuning picks TIGHT bracket for AVAX-like profile", () => {
  const t = resolveEliteDynamicTuning({
    medianAtrPct: 0.01076,
    medianAdx: 17.4,
    p40Adx: 15.2,
    medianVolRatio: 0.946,
    p40H1EmaSep: 0.00805,
    medianH1EmaSep: 0.00817,
  });
  assert.equal(t.sepMode, "PERCENTILE");
  assert.equal(t.stMultiplier, 3);
  assert.equal(t.bracketStyle, "TIGHT");
});

test("applyEliteAutoCalibrateCfg sets TIGHT brackets when tuning says TIGHT", () => {
  const candles = synthCandles(120);
  const out = applyEliteAutoCalibrateCfg(
    { eliteStAutoCalibrate: true, eliteStAutoFullTune: true },
    candles,
  );
  if (out._eliteDynamicTuning?.bracketStyle === "TIGHT") {
    assert.equal(Number(out.supertrendFuturesFixedSlPct), ELITE_TIGHT_SL_PCT);
    assert.equal(out.eliteStAutoBracketMode, "FIXED");
  }
});

test("resolveEliteDynamicTuning generalizes to unseen high-ATR low-ADX coin", () => {
  const t = resolveEliteDynamicTuning({
    medianAtrPct: 0.011,
    medianAdx: 18,
    p40Adx: 16,
    medianVolRatio: 0.9,
    p40H1EmaSep: 0.006,
    medianH1EmaSep: 0.006,
  });
  assert.equal(t.sepMode, "PERCENTILE");
  assert.equal(t.stMultiplier, 3.5);
  assert.equal(t.tuneSource, "profile_rules");
});

test("prepareEliteRunCfg skips BTC FIXED override when auto-calibrate on", () => {
  const candles = synthCandles(120);
  const out = prepareEliteRunCfg(
    { symbol: "BTCUSDT", eliteStAutoCalibrate: true, eliteStAutoFullTune: true, eliteStHtf1hMinSep: 0.0003 },
    "BTCUSDT",
    candles,
  );
  assert.ok(out._eliteDynamicTuning);
  assert.ok(!out.eliteStHtf1hMinSep || Number(out.eliteStHtf1hMinSep) <= 0.0008);
});

test("normalizeEliteStRunCfg still applies BTC override when auto off and FIXED sep", () => {
  const out = normalizeEliteStRunCfg({ symbol: "BTCUSDT", eliteStHtf1hMinSep: 0.0003 });
  assert.equal(out.eliteStHtf1hMinSep, 0.0008);
});

test("resolveEliteTrailDisasterSlPct caps inside liquidation distance at high leverage", () => {
  const profile = { medianAtrPct: 0.012 };
  const at10x = resolveEliteTrailDisasterSlPct(profile, { cfg: { futuresLeverage: 10 } });
  const at50x = resolveEliteTrailDisasterSlPct(profile, { cfg: { futuresLeverage: 50 } });
  const liq50 = resolveEliteLiquidationDistPct(50) * 0.85;
  assert.ok(at10x > 0.004);
  assert.ok(at50x <= liq50 + 1e-9);
  assert.ok(at50x < at10x);
});

test("applyEliteBracketStyleToCfg TRAIL sets disaster SL and no fixed TP", () => {
  const profile = { medianAtrPct: 0.00855 };
  const out = applyEliteBracketStyleToCfg(
    { futuresLeverage: 10 },
    profile,
    "TRAIL",
  );
  assert.equal(out.eliteStAutoBracketMode, "OFF");
  assert.equal(out.supertrendFuturesUseFixedSl, true);
  assert.ok(Number(out.supertrendFuturesFixedSlPct) > 0);
  assert.equal(out.supertrendFuturesUseFixedTp, false);
  assert.equal(out.supertrendFuturesFixedTpPct, 0);
});

test("prepareEliteRunCfg TRAIL profile gets disaster SL not naked trail", () => {
  const candles = synthCandles(120);
  const out = prepareEliteRunCfg(
    {
      symbol: "ETHUSDT",
      eliteStAutoCalibrate: true,
      eliteStAutoFullTune: true,
      futuresLeverage: 10,
    },
    "ETHUSDT",
    candles,
  );
  if (out._eliteDynamicTuning?.bracketStyle === "TRAIL") {
    assert.equal(out.eliteStAutoBracketMode, "OFF");
    assert.equal(out.supertrendFuturesUseFixedSl, true);
    assert.ok(Number(out.supertrendFuturesFixedSlPct) > 0);
    assert.equal(out.supertrendFuturesUseFixedTp, false);
  }
});
