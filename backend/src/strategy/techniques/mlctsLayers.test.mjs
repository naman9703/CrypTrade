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
  resolveTrendBias,
  orderFlowBookScore,
  orderFlowCoreScore,
  computeMlctsCompositeScore,
  fixedDenominatorWeightedScore,
  MLCTS_L5_BLEND_DENOM,
  MLCTS_L5_CORE_DENOM,
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

// L1: structure/EMA conflict → RANGE; bear invalidated above swing high → EMA bias
{
  const conflict = resolveTrendBias({
    structureBias: "BEAR",
    emaBias: "BULL",
    close: 64_000,
    swingHigh: 64_200,
    swingLow: 63_500,
  });
  assert.equal(conflict.bias, "RANGE");
  assert.equal(conflict.biasReason, "structure_ema_conflict");

  const invalidated = resolveTrendBias({
    structureBias: "BEAR",
    emaBias: "BULL",
    close: 64_495.99,
    swingHigh: 64_132.42,
    swingLow: 63_598,
  });
  assert.equal(invalidated.bias, "BULL");
  assert.equal(invalidated.structureInvalidated, "bear_break_above_swing_high");

  const aligned = resolveTrendBias({
    structureBias: "BULL",
    emaBias: "BULL",
    close: 64_000,
    swingHigh: 64_200,
    swingLow: 63_500,
  });
  assert.equal(aligned.bias, "BULL");
  assert.equal(aligned.biasReason, "aligned");

  const invalidatedMixed = resolveTrendBias({
    structureBias: "BEAR",
    emaBias: "RANGE",
    close: 64_495.99,
    swingHigh: 64_132.42,
    swingLow: 63_598,
  });
  assert.equal(invalidatedMixed.bias, "RANGE");
  assert.equal(invalidatedMixed.biasReason, "structure_invalidated_ema_mixed");
}

// L5 book score — continuous (no cliffs at imb=0.67 or imb=1.0)
{
  const s55 = orderFlowBookScore(0.55, "SELL");
  const s67 = orderFlowBookScore(0.67, "SELL");
  const s671 = orderFlowBookScore(0.671, "SELL");
  const b99 = orderFlowBookScore(0.99, "BUY");
  const b100 = orderFlowBookScore(1.0, "BUY");
  const b101 = orderFlowBookScore(1.01, "BUY");

  assert.ok(s55 > 75 && s55 < 90, `SELL 0.55 ~83 got ${s55}`);
  assert.ok(Math.abs(s67 - s671) < 3, "no cliff at 0.67 SELL");
  assert.ok(Math.abs(b99 - b101) < 5, "no cliff at 1.0 BUY");
  assert.equal(b100, 50, "balanced book → neutral 50");
  assert.equal(orderFlowBookScore(3, "BUY"), 94);
  assert.equal(orderFlowBookScore(3, "SELL"), 6);
  assert.ok(orderFlowBookScore(0.55, "BUY") < 25, "BUY 0.55 unfavorable");
}

// Book absence: imb<=0 → null slot scored 0 with fixed L5 denominator (not excluded / renormalized)
{
  assert.equal(orderFlowBookScore(0, "BUY"), null, "imb=0 → absent sentinel");
  assert.equal(orderFlowBookScore(-1, "SELL"), null, "negative imb → absent");
  const tinyImbScore = orderFlowBookScore(1e-12, "BUY");
  assert.ok(tinyImbScore != null, "tiny positive imb → present path, not misclassified absent");
  const favorableImbScore = orderFlowBookScore(3, "BUY");
  assert.ok(favorableImbScore > 50, "real book data participates with non-neutral score");
  const absentBook = fixedDenominatorWeightedScore(
    [
      { w: 0.3, s: 70 },
      { w: 0.3, s: 0 },
      { w: 0.2, s: 0 },
      { w: 0.2, s: orderFlowBookScore(0, "BUY") },
    ],
    MLCTS_L5_BLEND_DENOM,
  );
  const presentBook = fixedDenominatorWeightedScore(
    [
      { w: 0.3, s: 70 },
      { w: 0.3, s: 0 },
      { w: 0.2, s: 0 },
      { w: 0.2, s: favorableImbScore },
    ],
    MLCTS_L5_BLEND_DENOM,
  );
  assert.ok(Math.abs(absentBook - 21) < 0.001, "imb=0 → book slot 0, delta not inflated");
  assert.ok(presentBook > absentBook + 10, "non-degenerate imb raises L5 blend vs absent/null book");
}

// Composite is a 0–100 weighted average (raw weights sum to 95, result divides by wSum)
{
  const perfect = {
    trend: { score: 100 },
    liquidity: { score: 100 },
    sweep: { score: 100 },
    structure: { score: 100 },
    orderflow: { score: 100, detail: { deltaScore: 100, divScore: 100, absScore: 100, bookScore: 100 } },
    positioning: { score: 100, detail: { oiScore: 100, fundScore: 100 } },
  };
  const comp = computeMlctsCompositeScore(perfect, MLCTS_DEFAULTS);
  assert.equal(comp.score, 100, "perfect bar → composite 100, not 95");
  assert.equal(comp.weightSum, 95, "configured weights sum to 95");
  assert.equal(comp.scoreScale, "0-100_weighted_average");
}

// Shared bug class: absent/zero co-components must not expand another slot's effective weight
{
  const assertNoWeightExpansion = (label, scoreFn, baselineParts, spikePart, denom) => {
    const baseline = fixedDenominatorWeightedScore(baselineParts, denom);
    const withSpike = fixedDenominatorWeightedScore(
      baselineParts.map((p) => (p.key === spikePart.key ? spikePart : p)),
      denom,
    );
    const expectedDelta = (spikePart.w * spikePart.s) / denom;
    assert.ok(
      Math.abs(withSpike - baseline - expectedDelta) < 0.001,
      `${label}: spike delta matches fixed weight, no expansion`,
    );
  };

  // L5: book absent (null) + delta present — old renorm would inflate delta to /0.8
  const l5AbsentBook = fixedDenominatorWeightedScore(
    [
      { w: 0.3, s: 70 },
      { w: 0.3, s: 0 },
      { w: 0.2, s: 0 },
      { w: 0.2, s: null },
    ],
    MLCTS_L5_BLEND_DENOM,
  );
  assert.ok(Math.abs(l5AbsentBook - 21) < 0.001, "L5 absent book → delta 70 contributes 21, not 26.25");

  // L5: all zero except book — book stays at 20% of L5, not 100%
  const l5BookOnly = fixedDenominatorWeightedScore(
    [
      { w: 0.3, s: 0 },
      { w: 0.3, s: 0 },
      { w: 0.2, s: 0 },
      { w: 0.2, s: 100 },
    ],
    MLCTS_L5_BLEND_DENOM,
  );
  assert.equal(l5BookOnly, 20, "L5 zero delta/div/abs + book 100 → 20, not 100");

  // L5 core: zero siblings do not expand delta
  assertNoWeightExpansion(
    "L5 core",
    orderFlowCoreScore,
    [
      { key: "delta", w: 0.3, s: 0 },
      { key: "div", w: 0.3, s: 0 },
      { key: "abs", w: 0.2, s: 0 },
    ],
    { key: "delta", w: 0.3, s: 70 },
    MLCTS_L5_CORE_DENOM,
  );

  // OI/funding fixed blend: funding held at 50 while OI moves — no cross-weight expansion
  const oiFundBlend = (oi, fund) => (0.65 * oi + 0.35 * fund) / 1.0;
  const baseBlend = oiFundBlend(50, 50);
  const oiSpike = oiFundBlend(80, 50);
  assert.ok(Math.abs(oiSpike - baseBlend - 0.65 * 30) < 0.001, "OI/funding blend uses fixed 1.0 denominator");
}

// Composite weight table: L3+L4 share weightTrigger (15%), not 15% each
{
  const opts = { ...MLCTS_DEFAULTS };
  const wSum =
    opts.weightTrend +
    opts.weightLiquidity +
    opts.weightTrigger +
    opts.weightOrderFlow +
    opts.weightBook +
    opts.weightOi +
    opts.weightFunding;
  assert.equal(wSum, 95, "weights sum to 95 (L7 is gate-only, not in composite)");

  const layers = {
    trend: { score: 0 },
    liquidity: { score: 0 },
    sweep: { score: 100 },
    structure: { score: 0 },
    orderflow: { score: 0, detail: { deltaScore: 0, divScore: 0, absScore: 0, bookScore: 50 } },
    positioning: { score: 50, detail: { oiScore: 50, fundScore: 50 } },
  };
  const onlySweep = computeMlctsCompositeScore(layers, opts);
  const onlyStruct = computeMlctsCompositeScore(
    { ...layers, sweep: { score: 0 }, structure: { score: 100 } },
    opts,
  );
  const avgBoth = computeMlctsCompositeScore(
    { ...layers, sweep: { score: 100 }, structure: { score: 100 } },
    opts,
  );
  assert.ok(Math.abs(onlySweep.score - onlyStruct.score) < 0.01, "L3 and L4 symmetric at 15% trigger slot");
  assert.ok(avgBoth.score > onlySweep.score, "both L3+L4 high raises single trigger term vs one alone");
  assert.ok(
    Math.abs(avgBoth.triggerAvg - 100) < 0.01 && Math.abs(onlySweep.triggerAvg - 50) < 0.01,
    "trigger uses (L3+L4)/2",
  );
}

// OI and funding are distinct composite inputs — not positioning.score twice
{
  const base = {
    trend: { score: 50 },
    liquidity: { score: 50 },
    sweep: { score: 50 },
    structure: { score: 50 },
    orderflow: { score: 50, detail: { deltaScore: 50, divScore: 0, absScore: 0, bookScore: 50 } },
    positioning: { score: 72, detail: { oiScore: 80, fundScore: 60 } },
  };
  const blended = computeMlctsCompositeScore(base, MLCTS_DEFAULTS).score;
  const oiOnly = computeMlctsCompositeScore(
    { ...base, positioning: { score: 72, detail: { oiScore: 90, fundScore: 60 } } },
    MLCTS_DEFAULTS,
  ).score;
  const fundOnly = computeMlctsCompositeScore(
    { ...base, positioning: { score: 72, detail: { oiScore: 80, fundScore: 40 } } },
    MLCTS_DEFAULTS,
  ).score;
  const doublePosBug =
    ((MLCTS_DEFAULTS.weightOi + MLCTS_DEFAULTS.weightFunding) * base.positioning.score) /
    (MLCTS_DEFAULTS.weightTrend +
      MLCTS_DEFAULTS.weightLiquidity +
      MLCTS_DEFAULTS.weightTrigger +
      MLCTS_DEFAULTS.weightOrderFlow +
      MLCTS_DEFAULTS.weightBook +
      MLCTS_DEFAULTS.weightOi +
      MLCTS_DEFAULTS.weightFunding);
  assert.ok(Math.abs(blended - doublePosBug) > 0.05, "composite does not double-count blended positioning.score");
  assert.ok(oiOnly !== fundOnly, "oiScore and fundScore move composite independently");
}

// Book composite path: indirect (via L5) + direct was ~13/95, not ~26/95
{
  const l5BookOnly = fixedDenominatorWeightedScore(
    [
      { w: 0.3, s: 0 },
      { w: 0.3, s: 0 },
      { w: 0.2, s: 0 },
      { w: 0.2, s: 100 },
    ],
    MLCTS_L5_BLEND_DENOM,
  );
  assert.equal(l5BookOnly, 20);
  const oldBookComposite = (MLCTS_DEFAULTS.weightOrderFlow * l5BookOnly + MLCTS_DEFAULTS.weightBook * 100) / 95;
  const newBookComposite = (MLCTS_DEFAULTS.weightBook * 100) / 95;
  assert.ok(Math.abs(oldBookComposite - 13.684) < 0.01, "old double-path book contrib ~13.7 on 0–100 scale");
  assert.ok(Math.abs(newBookComposite - 10.526) < 0.01, "fixed book contrib ~10.5 on 0–100 scale");
  assert.ok(oldBookComposite - newBookComposite < 4, "book fix is ~3.2 composite points at book=100, not ~26");
}

// L2 liquidity and L3 sweep do not double-count the same composite slot
{
  const base = {
    trend: { score: 50 },
    liquidity: { score: 0 },
    sweep: { score: 80 },
    structure: { score: 50 },
    orderflow: { score: 50, detail: { deltaScore: 50, divScore: 0, absScore: 0, bookScore: 50 } },
    positioning: { score: 50, detail: { oiScore: 50, fundScore: 50 } },
  };
  const lowL2 = computeMlctsCompositeScore(base, MLCTS_DEFAULTS).score;
  const highL2 = computeMlctsCompositeScore({ ...base, liquidity: { score: 100 } }, MLCTS_DEFAULTS).score;
  const liqDelta = highL2 - lowL2;
  const expectedLiqDelta = (MLCTS_DEFAULTS.weightLiquidity * 100) / 95;
  assert.ok(Math.abs(liqDelta - expectedLiqDelta) < 0.02, "liquidity term appears once in composite");
  const trigOnly = computeMlctsCompositeScore(
    { ...base, sweep: { score: 0 }, structure: { score: 0 } },
    MLCTS_DEFAULTS,
  ).score;
  assert.ok(lowL2 > trigOnly, "L3 sweep adds trigger weight, separate from L2 liquidity weight");
}

// De-gated entry: L2 fail + high composite + L7 pass can still signal
{
  const candles = makeCandles(200);
  const idx = candles.length - 1;
  const ev = evaluateMlctsLayers(candles, idx, { ...MLCTS_DEFAULTS, scoreThreshold: 0 }, {});
  if (ev.direction && ev.layers.volatility?.pass) {
    assert.equal(ev.signalOk, true, "scoreThreshold 0 + direction + L7 → signal when brackets valid");
    assert.ok(!ev.layers.liquidity?.pass || !ev.layersAllPass, "signal can fire without all layer passes");
  }
}

console.log("mlctsLayers.test.mjs OK");
