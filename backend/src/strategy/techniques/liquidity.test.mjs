import test from "node:test";
import assert from "node:assert/strict";
import {
  scanSessionLiquidityCycles,
  computeLiquidityBrackets,
  evaluateSessionLiquiditySweep,
  resolveLiquidityEntryBrackets,
  mapLiquidityEntryLegs,
  listSessionLiquiditySetups,
} from "./liquidity.js";

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
