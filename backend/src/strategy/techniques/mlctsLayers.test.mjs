import assert from "node:assert/strict";
import {
  evaluateMlctsLayers,
  buildMlctsSeries,
  MLCTS_WARMUP,
  MLCTS_DEFAULTS,
  MLCTS_MAX_LEVEL_STRENGTH,
  effectiveLevelStrength,
  strengthToLayerScore,
  proximityLinearForLevel,
  structuralStrengthForLevel,
  primaryTypeStrengthForLevel,
  confluenceCountForLevel,
  sweepPoked,
  sweepReclaimedClose,
  reclaimCloseBackPct,
  reclaimScoreGraded,
  confirmScoreFromLevel,
} from "./mlctsLayers.js";
import { precomputeIntraday } from "../intradayPro.js";

function makeCandles(n, start = 100) {
  const out = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 7) * 0.4 + (i > n * 0.6 ? 0.15 : 0);
    const open = px;
    px = px + drift;
    const high = Math.max(open, px) + 0.5;
    const low = Math.min(open, px) - 0.5;
    out.push({
      ts: 1_700_000_000_000 + i * 900_000,
      open,
      high,
      low,
      close: px,
      volume: 100 + (i % 5) * 20,
      taker_buy_volume: 50 + (i % 3) * 10,
    });
  }
  return out;
}

// Causality: evaluation at idx must not change when future bars are appended
{
  const base = makeCandles(200);
  const idx = MLCTS_WARMUP + 10;
  const a = evaluateMlctsLayers(base.slice(0, idx + 1), idx, MLCTS_DEFAULTS, {});
  const b = evaluateMlctsLayers(base, idx, MLCTS_DEFAULTS, {});
  assert.equal(a.score, b.score, "score stable when future bars appended");
  assert.equal(a.layers.trend?.score, b.layers.trend?.score, "trend score causal");
}

// Score bounds
{
  const candles = makeCandles(180);
  const idx = candles.length - 1;
  const ev = evaluateMlctsLayers(candles, idx, MLCTS_DEFAULTS, {});
  assert.ok(ev.score >= 0 && ev.score <= 100, "composite score bounded");
  for (const k of Object.keys(ev.layers)) {
    const s = ev.layers[k]?.score ?? 0;
    assert.ok(s >= 0 && s <= 100, `layer ${k} score bounded`);
  }
}

// Volatility gate is marked as gate
{
  const candles = makeCandles(160);
  const idx = candles.length - 1;
  const ev = evaluateMlctsLayers(candles, idx, MLCTS_DEFAULTS, {});
  assert.equal(typeof ev.layers.volatility?.detail?.gate, "boolean");
  assert.equal(ev.layers.volatility?.detail?.gate, true);
}

// Series builder runs without throw
{
  const candles = makeCandles(200);
  const { series } = buildMlctsSeries(candles, MLCTS_DEFAULTS, {});
  assert.equal(series.length, candles.length);
  const hits = series.filter(Boolean).length;
  assert.ok(hits >= 0, "series produces zero or more hits");
}

// L2: one strength pipeline — layer score = strengthToLayerScore(effectiveStrength)
{
  const candles = makeCandles(200);
  const idx = candles.length - 1;
  const pre = precomputeIntraday(candles);
  const ev = evaluateMlctsLayers(candles, idx, MLCTS_DEFAULTS, { pre });
  const liq = ev.layers.liquidity;
  assert.ok(liq.score >= 0 && liq.score <= 100, "L2 layer score bounded 0–100");
  assert.equal(liq.score, strengthToLayerScore(liq.detail?.targetStrength ?? 0), "L2 score derived from targetStrength");
  assert.ok((liq.detail?.levelBreakdown?.swing ?? 0) === 0, "swings not in L2 liquidity map");
  assert.ok(
    (liq.detail?.levelCount ?? 0) >= 10,
    "L2 map includes psych round levels (expect >7 total)",
  );
  assert.ok(
    liq.detail?.structuralStrength == null || (liq.detail.structuralStrength >= 0 && liq.detail.structuralStrength <= 100),
    "structural strength bounded 0–100",
  );
}

// L2 strength: tradeable = base × linear ATR proximity (no floor); structural ignores distance
{
  const close = 100_000;
  const atrVal = 500;
  const lv = { price: close - 250, strength: 15, type: "vwap" };
  const prox = proximityLinearForLevel(close, lv.price, atrVal);
  const eff = effectiveLevelStrength(lv, close, atrVal);
  assert.ok(prox > 0.8 && prox < 0.9, "prox linear without floor");
  assert.equal(eff, Math.round(Math.min(MLCTS_MAX_LEVEL_STRENGTH, 15 * prox)), "tradeable = base × proximity");
  const structural = structuralStrengthForLevel(lv);
  assert.ok(structural > eff, "structural >= tradeable when proximity < 1");
  assert.equal(strengthToLayerScore(eff), Math.round((eff / MLCTS_MAX_LEVEL_STRENGTH) * 100), "score scales tradeable strength");
}

// Equal-high touches lift structural strength; touch norm uses /5 (original spec)
{
  const eq4 = { price: 100_000, strength: 30, type: "equal_high", touches: 4, mergedTypes: ["equal_high"] };
  const eq5 = { price: 100_000, strength: 30, type: "equal_high", touches: 5, mergedTypes: ["equal_high"] };
  const flat = { price: 100_000, strength: 10, type: "round", touches: null, mergedTypes: ["round"] };
  assert.ok(structuralStrengthForLevel(eq5) > structuralStrengthForLevel(eq4), "5 touches scores higher than 4 (/5 norm)");
  assert.ok(structuralStrengthForLevel(eq5) > structuralStrengthForLevel(flat), "equal cluster scores higher structurally");
}

// Confluence is a separate signal — equal-high zone vs lone equal-high differ in count, not structural type term
{
  const zone = {
    price: 64_000,
    type: "equal_high",
    strength: 30,
    touches: 3,
    mergedTypes: ["equal_high", "round", "vwap"],
  };
  const solo = { price: 64_000, type: "equal_high", strength: 30, touches: 3, mergedTypes: ["equal_high"] };
  assert.equal(structuralStrengthForLevel(zone), structuralStrengthForLevel(solo), "structural type term unchanged");
  assert.equal(primaryTypeStrengthForLevel(zone), primaryTypeStrengthForLevel(solo), "primary type base unchanged");
  assert.ok(confluenceCountForLevel(zone) > confluenceCountForLevel(solo), "confluence count distinguishes zone");
  assert.equal(confluenceCountForLevel(zone), 3);
  assert.equal(confluenceCountForLevel(solo), 1);
}

// VWAP + round merge raises confluence without changing primary type base
{
  const merged = { price: 64_000, type: "vwap", strength: 15, mergedTypes: ["vwap", "round"] };
  const solo = { price: 64_000, type: "vwap", strength: 15, mergedTypes: ["vwap"] };
  assert.equal(primaryTypeStrengthForLevel(merged), primaryTypeStrengthForLevel(solo));
  assert.equal(confluenceCountForLevel(merged), 2);
  assert.equal(confluenceCountForLevel(solo), 1);
}

// L3: poke and reclaim are independent checks (same logic as liquidity.sweepReclaim)
{
  const level = 100;
  const pct = 0.0006;
  const pokeOnly = { low: 99.93, high: 100.2, open: 100, close: 99.95 };
  assert.equal(sweepPoked(pokeOnly, level, "BUY", pct), true);
  assert.equal(sweepReclaimedClose(pokeOnly, level, "BUY"), false);
  const full = { low: 99.93, high: 100.2, open: 100, close: 100.05 };
  assert.equal(sweepPoked(full, level, "BUY", pct), true);
  assert.equal(sweepReclaimedClose(full, level, "BUY"), true);
}

// L3 graded reclaim + confirm (live panel arithmetic regression)
{
  const level = 63_904.92;
  const atr = 174.37;
  const bar = { low: 63_800, high: 63_956.15, open: 63_920, close: 63_876 };
  const depth = (63_956.15 - level) / atr;
  const depthScore = Math.round(Math.min(1, depth / 0.5) * 60);
  assert.ok(Math.abs(depth - 0.294) < 0.01, "depth × ATR");
  assert.equal(depthScore, 35);
  const reclaimScore = reclaimScoreGraded(bar, level, "SELL", atr, 25);
  assert.ok(reclaimScore > 7 && reclaimScore < 10, "weak reclaim scores below flat 25");
  const confirmScore = confirmScoreFromLevel(15, 72, 15);
  assert.ok(confirmScore > 5 && confirmScore < 12, "vwap-level confirm below flat 15");
  const total = Math.round(depthScore + reclaimScore + confirmScore);
  assert.ok(total >= 48 && total <= 56, "graded total near prior flat-75 weak-reclaim case");
}

console.log("mlctsLayers.test.mjs OK");
