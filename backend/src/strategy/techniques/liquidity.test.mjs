import test from "node:test";
import assert from "node:assert/strict";
import {
  scanSessionLiquidityCycles,
  computeLiquidityBrackets,
  evaluateSessionLiquiditySweep,
  resolveLiquidityEntryBrackets,
  mapLiquidityEntryLegs,
  listSessionLiquiditySetups,
  bestSessionLiquidityForDaySide,
  passesLiqRegimeFilters,
  passesLiqEntryMode,
  passesLiqAdxEntry,
  intradayDayRangePct,
  resolveLiqRunnerTpHits,
  reclaimHeldThrough,
  maxSweepCycleImpulseAtr,
  passesLiqSweepDisplacement,
  passesPostReclaimDisplacement,
  passesSweepPokeRejection,
  passesEntryLevelHold,
  passesSweepAttemptCap,
  computeLiqEntryContextScore,
  isLiqTrailOnlyExit,
  resolveLiqEntryScoreMode,
  resolveLiqDisplacementGateOpts,
} from "./liquidity.js";
import { evaluateTrendContinuationSetup } from "./liquidityTrendContinuation.js";

function bar(ts, o, h, l, c) {
  return { ts, open: o, high: h, low: l, close: c, volume: 1 };
}

test("scanSessionLiquidityCycles — failed breakdown allows later cycle", () => {
  const day = Date.parse("2026-05-21T00:00:00Z");
  const candles = [
    bar(day, 652, 655.9, 651, 651.6),
    bar(day + 3_600_000, 651, 652, 650, 651),
    bar(day + 7_200_000, 651, 660, 659, 659.91),
    bar(day + 10_800_000, 660, 660, 656, 651.5),
  ];
  const cycles = scanSessionLiquidityCycles(
    candles,
    3,
    "SELL",
    652.24,
    637.85,
    "pdh",
    0.001,
    0,
    { intradayLiqMinSweepExtensionPct: 0.003 },
  );
  assert.equal(cycles.length, 2);
  assert.ok(cycles[1].wick >= 660);
  assert.equal(cycles[1].reclaimIdx, 3);
});

test("computeLiquidityBrackets — partial TP1 at 1R", () => {
  const br = computeLiquidityBrackets("SELL", 662.35, 673.51, 650, {
    slBufferPct: 0.0015,
    intradayLiqPartialTp: true,
    intradayLiqPartialFrac: 0.5,
  });
  assert.ok(br.partialTp);
  assert.equal(br.tp2Price, 650);
  assert.ok(br.tp1Price < 662.35);
  assert.ok(br.slPrice > 673.51);
  assert.equal(br.tp1Rr, 1);
});

test("computeLiquidityBrackets — intradayLiqTp2Rr + tp2 partial frac", () => {
  const br = computeLiquidityBrackets("SELL", 662.35, 673.51, 650, {
    slBufferPct: 0.0015,
    intradayLiqPartialTp: true,
    intradayLiqPartialFrac: 0.25,
    intradayLiqTp2PartialFrac: 0.25,
    intradayLiqTp2Rr: 2,
    intradayLiqMinRr: 2,
  });
  assert.equal(br.tp1Rr, 1);
  assert.equal(br.tp2Rr, 2);
  assert.equal(br.partialFrac, 0.25);
  assert.equal(br.tp2PartialFrac, 0.25);
  assert.ok(br.tp2Price < 662.35);
  const risk = 673.51 * 1.0015 - 662.35;
  const expectedTp2 = 662.35 - 2 * risk;
  assert.ok(Math.abs(br.tp2Price - expectedTp2) < 0.05);
});

test("computeLiquidityBrackets — intradayLiqTp1Rr shifts partial leg", () => {
  const br = computeLiquidityBrackets("SELL", 662.35, 673.51, 650, {
    slBufferPct: 0.0015,
    intradayLiqPartialTp: true,
    intradayLiqTp1Rr: 2,
    intradayLiqMaxTpRr: 3,
  });
  const br1 = computeLiquidityBrackets("SELL", 662.35, 673.51, 650, {
    slBufferPct: 0.0015,
    intradayLiqPartialTp: true,
    intradayLiqTp1Rr: 1,
    intradayLiqMaxTpRr: 3,
  });
  assert.equal(br.tp1Rr, 2);
  assert.ok(Math.abs(br.tp1Price - br1.tp1Price) > 1);
});

test("computeLiquidityBrackets — TP2 off keeps TP1 only", () => {
  const br = computeLiquidityBrackets("SELL", 662.35, 673.51, 650, {
    slBufferPct: 0.0015,
    intradayLiqTp1Enabled: true,
    intradayLiqTp2Enabled: false,
  });
  assert.ok(br.partialTp);
  assert.equal(br.tp2Price, 0);
  assert.ok(br.tp1Price > 0);
});

test("computeLiquidityBrackets — min R:R blocks low TP2 setups", () => {
  const br = computeLiquidityBrackets("SELL", 662.35, 673.51, 661, {
    slBufferPct: 0.0015,
    intradayLiqMinRr: 2,
  });
  assert.equal(br, null);
});

test("computeLiquidityBrackets — min R:R blocks SL-only when opposing pool is too close", () => {
  const br = computeLiquidityBrackets("SELL", 662.35, 673.51, 661, {
    slBufferPct: 0.0015,
    intradayLiqTp1Enabled: false,
    intradayLiqTp2Enabled: false,
    intradayLiqMinRr: 2,
  });
  assert.equal(br, null);
});

test("computeLiquidityBrackets — SL-only passes when structural R:R meets minRr", () => {
  const br = computeLiquidityBrackets("SELL", 662.35, 673.51, 650, {
    slBufferPct: 0.0015,
    intradayLiqTp1Enabled: false,
    intradayLiqTp2Enabled: false,
    intradayLiqMinRr: 1,
  });
  assert.ok(br?.slOnly);
  assert.ok((br?.rr ?? 0) >= 1);
});

test("computeLiquidityBrackets — SL-only when TP1/TP2 off", () => {
  const br = computeLiquidityBrackets("SELL", 662.35, 673.51, 650, {
    slBufferPct: 0.0015,
    intradayLiqTp1Enabled: false,
    intradayLiqTp2Enabled: false,
  });
  assert.ok(br.slOnly);
  assert.equal(br.partialTp, false);
  assert.equal(br.tp2Price, 0);
  assert.ok(br.slPrice > 662.35);
});

test("mapLiquidityEntryLegs — TP1 off uses full size at TP2", () => {
  const baked = computeLiquidityBrackets("SELL", 662.35, 673.51, 650, { slBufferPct: 0.0015 });
  const resolved = resolveLiquidityEntryBrackets(
    { intradayLiqTp1Enabled: false, intradayLiqTp2Enabled: true },
    { liqBrackets: baked, action: "SELL" },
    662.35,
    "SELL",
  );
  const legs = mapLiquidityEntryLegs(resolved, { intradayLiqTp1Enabled: false });
  assert.equal(legs.partialTp, false);
  assert.ok(legs.tp > 0 && legs.tp < 662.35);
  assert.equal(legs.tp1, 0);
});

test("mapLiquidityEntryLegs — TP1 off + BE on arms 1R trigger without partial", () => {
  const baked = computeLiquidityBrackets("SELL", 662.35, 673.51, 650, {
    slBufferPct: 0.0015,
    intradayLiqTp1Enabled: false,
    intradayLiqTp2Enabled: true,
    intradayLiqBreakevenAfterPartial: true,
  });
  const resolved = resolveLiquidityEntryBrackets(
    {
      intradayLiqTp1Enabled: false,
      intradayLiqTp2Enabled: true,
      intradayLiqBreakevenAfterPartial: true,
    },
    { liqBrackets: baked, action: "SELL" },
    662.35,
    "SELL",
  );
  const legs = mapLiquidityEntryLegs(resolved, {
    intradayLiqTp1Enabled: false,
    intradayLiqTp2Enabled: true,
    intradayLiqBreakevenAfterPartial: true,
  });
  assert.equal(legs.partialTp, false);
  assert.equal(legs.beAt1R, true);
  assert.ok(legs.beTriggerPx > 0 && legs.beTriggerPx < 662.35);
  assert.ok(legs.tp > 0);
});

test("resolveLiqRunnerTpHits — TP1 off allows full TP2 when tp2PartialFrac is set", () => {
  const pos = {
    partialTp: false,
    partialTaken: false,
    tp2PartialTaken: false,
    tp2PartialFrac: 0.25,
    tp1: 0,
    tp: 640,
    liqExitStages: { tp1On: false, tp2On: true },
  };
  const bar = { high: 670, low: 635 };
  const hits = resolveLiqRunnerTpHits(pos, bar, false);
  assert.equal(hits.hitTp1, false);
  assert.equal(hits.hitTp2, false);
  assert.equal(hits.hitTP, true);
  assert.equal(hits.tp2PartialLadder, false);
});

test("resolveLiqRunnerTpHits — TP1 on + tp2PartialFrac uses ladder not full TP2", () => {
  const pos = {
    partialTp: true,
    partialTaken: false,
    tp2PartialTaken: false,
    tp2PartialFrac: 0.25,
    tp1: 655,
    tp: 640,
    liqExitStages: { tp1On: true, tp2On: true },
  };
  const bar = { high: 670, low: 635 };
  const hits = resolveLiqRunnerTpHits(pos, bar, false);
  assert.equal(hits.hitTP, false);
  assert.equal(hits.hitTp1, true);
});

test("evaluateSessionLiquiditySweep — picks best cycle at bar", () => {
  const day = Date.parse("2026-05-25T00:00:00Z");
  const candles = [];
  for (let i = 0; i < 48; i++) {
    candles.push(bar(day + i * 900_000, 660, 661, 659, 660));
  }
  const n = candles.length;
  candles.push(bar(day + n * 900_000, 663, 673.51, 662, 671.55));
  candles.push(bar(day + (n + 1) * 900_000, 671, 672, 661, 662.35));
  const pre = {
    prevDayHigh: new Array(candles.length).fill(663.26),
    prevDayLow: new Array(candles.length).fill(650),
  };
  const sig = evaluateSessionLiquiditySweep(candles, candles.length - 1, "SELL", pre, {
    sweepPct: 0.001,
    intradayLiqMinSweepExtensionPct: 0.003,
  });
  assert.ok(sig);
  assert.equal(sig.wick, 673.51);
  assert.ok(sig.tp1Price);
});

test("session low cluster — May 24 style 650 reclaim", () => {
  const day = Date.parse("2026-05-24T00:00:00Z");
  const candles = [];
  for (let i = 0; i < 80; i++) {
    candles.push(bar(day + i * 900_000, 655, 656, 654.3, 655));
  }
  const i = candles.length;
  candles.push(bar(day + i * 900_000, 651, 652, 650, 655));
  const pre = {
    prevDayHigh: new Array(candles.length).fill(664.4),
    prevDayLow: new Array(candles.length).fill(635),
  };
  const setups = listSessionLiquiditySetups(candles, candles.length - 1, "BUY", pre, {
    sweepPct: 0.001,
    intradayLiqSessionExtreme: true,
    intradayLiqSessionExtremeMinTouches: 2,
    intradayLiqMinSweepExtensionPct: 0.001,
  });
  const sessionLow = setups.find((s) => s.levelType === "session_low");
  assert.ok(sessionLow, "expected session_low long");
  assert.ok(sessionLow.tp1Price);
});

test("listSessionLiquiditySetups — first cycle only removes later reclaims", () => {
  const day = Date.parse("2026-05-21T00:00:00Z");
  const candles = [
    bar(day, 652, 655.9, 651, 651.6),
    bar(day + 3_600_000, 651, 652, 650, 651),
    bar(day + 7_200_000, 651, 660, 659, 659.91),
    bar(day + 10_800_000, 660, 660, 656, 651.5),
  ];
  const pre = {
    prevDayHigh: new Array(candles.length).fill(652.24),
    prevDayLow: new Array(candles.length).fill(637.85),
  };
  const keepAll = listSessionLiquiditySetups(candles, 3, "SELL", pre, {
    sweepPct: 0.001,
    intradayLiqMinSweepExtensionPct: 0.003,
  });
  const firstOnly = listSessionLiquiditySetups(candles, 3, "SELL", pre, {
    sweepPct: 0.001,
    intradayLiqMinSweepExtensionPct: 0.003,
    intradayLiqFirstCycleOnly: true,
  });
  assert.equal(keepAll.length, 1);
  assert.equal(firstOnly.length, 0);
});

test("session cluster — bare touch no longer counts as a sweep (needs pierce)", () => {
  const day = Date.parse("2026-05-26T00:00:00Z");
  const candles = [];
  for (let i = 0; i < 60; i++) candles.push(bar(day + i * 900_000, 655, 656, 654.0, 655));
  const i = candles.length;
  // Touches the 654.0 cluster exactly (low === level) then closes back up.
  candles.push(bar(day + i * 900_000, 654.2, 655.5, 654.0, 655.2));
  const pre = {
    prevDayHigh: new Array(candles.length).fill(664),
    prevDayLow: new Array(candles.length).fill(640),
  };
  const opts = {
    sweepPct: 0.001,
    intradayLiqSessionExtreme: true,
    intradayLiqSessionExtremeMinTouches: 2,
    intradayLiqMinSweepExtensionPct: 0.0005,
  };
  const touchOnly = listSessionLiquiditySetups(candles, candles.length - 1, "BUY", pre, opts);
  assert.equal(touchOnly.filter((s) => s.levelType === "session_low").length, 0, "bare touch must not sweep");
});

test("sweep volume gate — low-volume poke is rejected when ratio set", () => {
  const day = Date.parse("2026-05-27T00:00:00Z");
  const mk = (ts, o, h, l, c, v) => ({ ts, open: o, high: h, low: l, close: c, volume: v });
  const candles = [];
  for (let i = 0; i < 6; i++) candles.push(mk(day + i * 900_000, 100, 100.4, 99.7, 100, 100));
  // SELL: pokes pdh 101 with a tiny-volume wick, reclaims below.
  candles.push(mk(day + 6 * 900_000, 100.5, 101.5, 100.4, 100.2, 5));
  const pre = {
    prevDayHigh: new Array(candles.length).fill(101),
    prevDayLow: new Array(candles.length).fill(98),
  };
  const noGate = scanSessionLiquidityCycles(candles, candles.length - 1, "SELL", 101, 98, "pdh", 0.001, 0, {
    intradayLiqMinSweepExtensionPct: 0.001,
  });
  const gated = scanSessionLiquidityCycles(candles, candles.length - 1, "SELL", 101, 98, "pdh", 0.001, 0, {
    intradayLiqMinSweepExtensionPct: 0.001,
    intradayLiqSweepMinVolRatio: 1.5,
    intradayLiqSweepVolLookback: 5,
  });
  assert.equal(noGate.length, 1);
  assert.equal(gated.length, 0, "low-volume sweep should be filtered when vol gate on");
});

test("timeframe max-sweep-minutes overrides the bar-count window", () => {
  const day = Date.parse("2026-05-28T00:00:00Z");
  const candles = [
    bar(day, 100, 100.5, 99.8, 100),
    bar(day + 900_000, 100, 101.5, 99.9, 101.2), // poke pdh 101
  ];
  for (let i = 2; i < 7; i++) candles.push(bar(day + i * 900_000, 101, 101.2, 100.9, 101.1));
  candles.push(bar(day + 7 * 900_000, 101, 101.1, 100.2, 100.5)); // reclaim 6 bars after poke
  const pre = { prevDayHigh: new Array(candles.length).fill(101), prevDayLow: new Array(candles.length).fill(98) };
  const within = scanSessionLiquidityCycles(candles, candles.length - 1, "SELL", 101, 98, "pdh", 0.001, 0, {
    intradayLiqMinSweepExtensionPct: 0.001,
    intradayLiqMaxSweepMinutes: 180, // 12 × 15m bars allowed
  });
  const tooTight = scanSessionLiquidityCycles(candles, candles.length - 1, "SELL", 101, 98, "pdh", 0.001, 0, {
    intradayLiqMinSweepExtensionPct: 0.001,
    intradayLiqMaxSweepMinutes: 30, // 2 × 15m bars — reclaim is too late
  });
  assert.equal(within.length, 1);
  assert.equal(tooTight.length, 0);
});

test("listSessionLiquiditySetups — reclaim body filter blocks weak close", () => {
  const day = Date.parse("2026-05-22T00:00:00Z");
  const candles = [
    bar(day, 100, 100.5, 99.8, 100),
    bar(day + 900_000, 100, 101.4, 99.8, 100.02),
  ];
  const pre = {
    prevDayHigh: new Array(candles.length).fill(101),
    prevDayLow: new Array(candles.length).fill(99),
  };
  const weak = listSessionLiquiditySetups(candles, 1, "SELL", pre, {
    sweepPct: 0.001,
    intradayLiqMinSweepExtensionPct: 0.001,
  });
  const strongRequired = listSessionLiquiditySetups(candles, 1, "SELL", pre, {
    sweepPct: 0.001,
    intradayLiqMinSweepExtensionPct: 0.001,
    intradayLiqMinReclaimBodyRatio: 0.4,
    intradayLiqMinReclaimClosePct: 0.0004,
  });
  assert.equal(weak.length, 1);
  assert.equal(strongRequired.length, 0);
});

test("bestSessionLiquidityForDaySide — comparable cycles prefer later reclaim", () => {
  const day = Date.parse("2026-05-29T00:00:00Z");
  const candles = [
    bar(day, 100, 100.5, 99.8, 100),
    bar(day + 900_000, 100.5, 101.5, 100.1, 100.7),
    bar(day + 1_800_000, 100.7, 100.8, 99.8, 100.5),
    bar(day + 2_700_000, 100.6, 101.55, 100.4, 100.8),
    bar(day + 3_600_000, 100.8, 100.9, 100.0, 100.6),
  ];
  const pre = {
    prevDayHigh: new Array(candles.length).fill(101),
    prevDayLow: new Array(candles.length).fill(98),
  };
  const best = bestSessionLiquidityForDaySide(candles, candles.length - 1, "SELL", pre, {
    sweepPct: 0.001,
    intradayLiqMinSweepExtensionPct: 0.001,
  });
  assert.ok(best);
  assert.equal(best.reclaimIdx, 3);
});

test("evaluateTrendContinuationSetup — extension is positive for SELL breakdown continuation", () => {
  const day = Date.parse("2026-05-30T00:00:00Z");
  const candles = [];
  for (let i = 0; i < 60; i++) candles.push(bar(day + i * 900_000, 100, 100.3, 99.5, 99.8));
  candles.push(bar(day + 60 * 900_000, 98.8, 99.0, 97.5, 97.8));
  candles.push(bar(day + 61 * 900_000, 97.8, 98.2, 97.2, 97.6));
  candles.push(bar(day + 62 * 900_000, 98.8, 99.2, 97.4, 97.7));
  const idx = candles.length - 1;
  const pre = {
    prevDayHigh: new Array(candles.length).fill(104),
    prevDayLow: new Array(candles.length).fill(99),
    htfDown: new Array(candles.length).fill(true),
    htfUp: new Array(candles.length).fill(false),
    adxSeries: new Array(candles.length).fill(30),
    ema9: new Array(candles.length).fill(98.5),
    rsiSeries: new Array(candles.length).fill(45),
    atrSeries: new Array(candles.length).fill(1),
    volumes: new Array(candles.length).fill(100),
  };
  const setup = evaluateTrendContinuationSetup(candles, idx, "SELL", pre, {
    intradayLiqTrendContinuation: true,
    intradayLiqTrendMinBarsBeyondLevel: 2,
    intradayLiqTrendMinAdx: 18,
    intradayLiqTrendRequireHtf: true,
    intradayLiqTrendOnlyBreakdownDays: false,
    intradayLiqBreakdownDayBias: true,
    intradayLiqTrendFadeMinRvol: 0,
    intradayLiqTrendMinBodyRatio: 0,
    intradayLiqTrendDayHighBuffer: 0.5,
    intradayLiqTrendMinDispAtr: 0.1,
    intradayLiqTrendRsiMinShort: 0,
    intradayLiqTrendRsiMaxShort: 100,
    intradayLiqMinRr: 0,
  });
  assert.ok(setup);
  assert.ok(setup.extension > 0);
});

test("passesLiqEntryMode — trend_pullback blocks counter-trend BUY", () => {
  const pre = { htfUp: [false], htfDown: [true] };
  assert.equal(passesLiqEntryMode("BUY", 0, pre, { intradayLiqEntryMode: "trend_pullback" }, "pdl"), false);
  assert.equal(passesLiqEntryMode("SELL", 0, pre, { intradayLiqEntryMode: "trend_pullback" }, "pdh"), true);
  pre.htfUp[0] = true;
  pre.htfDown[0] = false;
  assert.equal(passesLiqEntryMode("BUY", 0, pre, { intradayLiqEntryMode: "trend_pullback" }, "pdl"), true);
});

test("passesLiqAdxEntry — ADX band", () => {
  const pre = { adxSeries: [15] };
  assert.equal(passesLiqAdxEntry(0, pre, { intradayLiqMinAdx: 18 }), false);
  pre.adxSeries[0] = 25;
  assert.equal(passesLiqAdxEntry(0, pre, { intradayLiqMinAdx: 18, intradayLiqMaxAdx: 48 }), true);
  pre.adxSeries[0] = 55;
  assert.equal(passesLiqAdxEntry(0, pre, { intradayLiqMaxAdx: 48 }), false);
});

test("passesLiqRegimeFilters — blocks wide day range and post-displacement cooldown", () => {
  const day = Date.parse("2026-02-23T00:00:00Z");
  const candles = [
    bar(day, 1950, 1955, 1945, 1952),
    bar(day + 3_600_000, 1952, 1960, 1940, 1942),
    bar(day + 7_200_000, 1942, 1948, 1860, 1885),
    bar(day + 10_800_000, 1885, 1890, 1850, 1860),
  ];
  const pre = { atr: [10, 10, 50, 20] };
  const dayStart = 0;
  assert.ok(intradayDayRangePct(candles, 3, dayStart) > 0.03);
  assert.equal(
    passesLiqRegimeFilters(candles, 3, dayStart, pre, { intradayLiqMaxFadeDayRangePct: 0.03 }),
    false,
  );
  assert.equal(
    passesLiqRegimeFilters(candles, 3, dayStart, pre, {
      intradayLiqPostDisplacementCooldownBars: 4,
      intradayLiqDisplacementBarAtrMult: 2,
    }),
    false,
  );
  assert.equal(
    passesLiqRegimeFilters(candles, 3, dayStart, pre, {
      intradayLiqMaxFadeDayRangePct: 0.06,
      intradayLiqPostDisplacementCooldownBars: 0,
    }),
    true,
  );
});

test("reclaim hold — delays entry until level holds on next bar", () => {
  const day = Date.parse("2026-03-01T00:00:00Z");
  const level = 100;
  const candles = [
    bar(day, 101, 102, 100.5, 101),
    bar(day + 900_000, 101, 101.5, 99.5, 100.2),
    bar(day + 1_800_000, 100.2, 101.2, 99.8, 100.6),
    bar(day + 2_700_000, 100.6, 101.5, 100.1, 101),
  ];
  assert.equal(reclaimHeldThrough(candles, 2, 3, "BUY", level), true);
  assert.equal(reclaimHeldThrough(candles, 2, 2, "BUY", 101), false);
});

test("passesLiqSweepDisplacement — requires impulse between sweep and reclaim", () => {
  const day = Date.parse("2026-04-01T00:00:00Z");
  const candles = [
    bar(day, 100, 100.5, 99.8, 100),
    bar(day + 900_000, 100, 100.2, 98.5, 99), // sweep poke
    bar(day + 1_800_000, 99, 99.3, 98.9, 99.1), // weak drift
    bar(day + 2_700_000, 99.1, 101.5, 99, 101), // reclaim
  ];
  const pre = { atrSeries: [1, 1, 1, 1] };
  const cycle = { sweepStartIdx: 1, reclaimIdx: 3, level: 99.5 };
  assert.equal(maxSweepCycleImpulseAtr(candles, 1, 3, pre), 2.5);
  assert.equal(
    passesLiqSweepDisplacement(cycle, candles, pre, { intradayLiqRequireSweepDisplacement: true, intradayLiqSweepDisplacementMinAtrMult: 2 }),
    true,
  );
  assert.equal(
    passesLiqSweepDisplacement(cycle, candles, pre, { intradayLiqRequireSweepDisplacement: true, intradayLiqSweepDisplacementMinAtrMult: 3 }),
    false,
  );
});

test("computeLiqEntryContextScore — rewards displacement and PDL long HTF", () => {
  const day = Date.parse("2026-04-01T00:00:00Z");
  const candles = [
    bar(day, 100, 100.5, 99.8, 100),
    bar(day + 900_000, 100, 100.2, 98.5, 99),
    bar(day + 1_800_000, 99, 99.3, 98.9, 99.1),
    bar(day + 2_700_000, 99.1, 101.5, 99, 101),
    bar(day + 3_600_000, 101, 102, 100.5, 101.5),
  ];
  const pre = {
    atrSeries: [1, 1, 1, 1, 1],
    htfUp: [true, true, true, true, true],
    htfDown: [false, false, false, false, false],
    htfSep: [0.001, 0.001, 0.001, 0.001, 0.001],
  };
  const cycle = {
    sweepStartIdx: 1,
    reclaimIdx: 3,
    level: 99.5,
    levelType: "pdl",
    extension: 0.01,
    opposing: 102,
    wick: 98.5,
  };
  const held = computeLiqEntryContextScore(candles, cycle, "BUY", pre, {}, 4, candles[3]);
  const noHtf = computeLiqEntryContextScore(
    candles,
    cycle,
    "BUY",
    { ...pre, htfUp: [false, false, false, false, false] },
    {},
    4,
    candles[3],
  );
  assert.ok(held.score > noHtf.score);
  assert.ok(held.score >= 45);
});

test("isLiqTrailOnlyExit — detects trail-only ETH stack", () => {
  assert.equal(
    isLiqTrailOnlyExit({
      intradayLiqAllowTrailOnlyExit: true,
      trailingStopLossAuto: true,
      intradayLiqPartialTp: false,
      intradayLiqTp1Enabled: false,
      intradayLiqTp2Enabled: false,
    }),
    true,
  );
  assert.equal(
    isLiqTrailOnlyExit({
      intradayLiqAllowTrailOnlyExit: true,
      trailingStopLossAuto: true,
      intradayLiqPartialTp: true,
    }),
    false,
  );
});

test("resolveLiqEntryScoreMode — trail-only defaults to context score", () => {
  const trail = {
    intradayLiqAllowTrailOnlyExit: true,
    trailingStopLossAuto: true,
    intradayLiqPartialTp: false,
    intradayLiqTp1Enabled: false,
    intradayLiqTp2Enabled: false,
  };
  assert.equal(resolveLiqEntryScoreMode(trail), true);
  assert.equal(resolveLiqEntryScoreMode({ ...trail, intradayLiqTrailUseContextScore: false }), false);
  assert.equal(resolveLiqEntryScoreMode({ intradayLiqUseEntryScore: true }), true);
  assert.equal(resolveLiqEntryScoreMode({}), false);
});

test("resolveLiqDisplacementGateOpts — trail-only defaults displacement on", () => {
  const trail = {
    intradayLiqAllowTrailOnlyExit: true,
    trailingStopLossAuto: true,
    intradayLiqPartialTp: false,
    intradayLiqTp1Enabled: false,
    intradayLiqTp2Enabled: false,
  };
  const gate = resolveLiqDisplacementGateOpts(trail);
  assert.equal(gate.required, true);
  assert.equal(gate.opts.intradayLiqSweepDisplacementMinAtrMult, 1.2);
  assert.equal(
    resolveLiqDisplacementGateOpts({ ...trail, intradayLiqRequireSweepDisplacement: false }).required,
    false,
  );
});

test("passesPostReclaimDisplacement — requires aligned impulse bar after reclaim", () => {
  const day = Date.parse("2026-05-21T00:00:00Z");
  const candles = [
    bar(day, 100, 101, 99, 100.5),
    bar(day + 900_000, 100.5, 101.2, 100.2, 101.0),
    bar(day + 1_800_000, 101, 102.5, 100.8, 102.2),
  ];
  const pre = {
    atrSeries: { 1: 1, 2: 1 },
  };
  const cycle = { reclaimIdx: 1, sweepStartIdx: 0 };
  assert.equal(
    passesPostReclaimDisplacement(candles, cycle, "BUY", pre, {
      intradayLiqRequirePostReclaimDisplacement: true,
      intradayLiqPostReclaimDispAtrMult: 1.0,
    }, 2),
    true,
  );
  assert.equal(
    passesPostReclaimDisplacement(candles, cycle, "BUY", pre, {
      intradayLiqRequirePostReclaimDisplacement: true,
      intradayLiqPostReclaimDispAtrMult: 1.0,
    }, 1),
    false,
  );
});

test("passesSweepPokeRejection — requires rejection wick on sweep poke bar", () => {
  const day = Date.parse("2026-05-22T00:00:00Z");
  const poke = bar(day, 100.5, 101.2, 100.4, 100.9);
  const reclaim = bar(day + 900_000, 100.9, 101.0, 100.2, 100.6);
  const cycle = { sweepStartIdx: 0, reclaimIdx: 1, level: 101 };
  assert.equal(passesSweepPokeRejection([poke, reclaim], cycle, "SELL", {}), true);
  assert.equal(
    passesSweepPokeRejection([poke, reclaim], cycle, "SELL", { intradayLiqMinSweepPokeWickRatio: 0.5 }),
    false,
  );
});

test("passesEntryLevelHold — entry close must clear swept level", () => {
  const barBuy = { open: 100.2, high: 100.5, low: 99.8, close: 100.4 };
  const barSell = { open: 100.2, high: 100.3, low: 99.5, close: 99.8 };
  const cycle = { level: 100 };
  assert.equal(passesEntryLevelHold(barBuy, cycle, "BUY", {}), true);
  assert.equal(passesEntryLevelHold(barSell, cycle, "SELL", {}), true);
  assert.equal(passesEntryLevelHold({ ...barBuy, close: 99.9 }, cycle, "BUY", {}), false);
  assert.equal(
    passesEntryLevelHold({ ...barBuy, close: 100.05 }, cycle, "BUY", { intradayLiqMinReclaimClosePct: 0.001 }),
    false,
  );
});

test("passesSweepAttemptCap — blocks repeated pool sweeps when gate off", () => {
  assert.equal(passesSweepAttemptCap({ attemptCount: 2 }, { intradayLiqMaxSweepAttempts: 3 }), true);
  assert.equal(passesSweepAttemptCap({ attemptCount: 4 }, { intradayLiqMaxSweepAttempts: 3 }), false);
  assert.equal(
    passesSweepAttemptCap({ attemptCount: 5 }, { intradayLiqSweepQualityGate: true, intradayLiqMaxSweepAttempts: 3 }),
    true,
  );
});
