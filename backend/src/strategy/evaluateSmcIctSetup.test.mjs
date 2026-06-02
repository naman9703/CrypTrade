import test from "node:test";
import assert from "node:assert/strict";
import {
  isSmcIctMode,
  isFullSmcIctProfile,
  isBalancedSmcIctProfile,
  resolveRequireRetrace,
  resolveRequireChoch,
  evaluateSmcIctSetup,
} from "./evaluateSmcIctSetup.js";
import { precomputeIntraday, selectIntradayPicks } from "./intradayPro.js";
import { INTRADAY_PRO_ICT_15M, fillSmcSoloPresetDefaults } from "./presets/srIntradayOptimized.js";

test("isSmcIctMode — gate or mode flag", () => {
  assert.equal(isSmcIctMode({ intradayGateSmcIct: true }), true);
  assert.equal(isSmcIctMode({ intradaySmcIctMode: true }), true);
  assert.equal(isSmcIctMode({}), false);
});

test("isFullSmcIctProfile — full vs sweep profile", () => {
  assert.equal(isFullSmcIctProfile({ intradaySmcIctProfile: "full" }), true);
  assert.equal(isFullSmcIctProfile({ intradaySmcIctProfile: "ict2022" }), true);
  assert.equal(isFullSmcIctProfile({ intradaySmcIctProfile: "sweep" }), false);
});

test("resolveRequireRetrace — FvgRetrace flag when sweep profile", () => {
  assert.equal(resolveRequireRetrace({ intradaySmcIctProfile: "sweep" }), false);
  assert.equal(
    resolveRequireRetrace({ intradaySmcIctProfile: "sweep", intradaySmcRequireFvgRetrace: true }),
    true,
  );
  assert.equal(resolveRequireRetrace({ intradaySmcIctProfile: "balanced" }), true);
  assert.equal(
    resolveRequireRetrace({ intradaySmcIctProfile: "balanced", intradaySmcRequireRetrace: false }),
    false,
  );
});

test("resolveRequireChoch — explicit checkbox only on sweep/balanced; full always on", () => {
  assert.equal(resolveRequireChoch({ intradaySmcIctProfile: "full" }), true);
  assert.equal(resolveRequireChoch({ intradaySmcIctProfile: "sweep" }), false);
  assert.equal(
    resolveRequireChoch({ intradaySmcIctProfile: "sweep", intradaySmcRequireChoch: true }),
    true,
  );
  assert.equal(
    resolveRequireChoch({ intradaySmcIctProfile: "sweep", intradaySmcRequireChoch: false }),
    false,
  );
  assert.equal(resolveRequireChoch({ intradaySmcIctProfile: "balanced" }), false);
  assert.equal(
    resolveRequireChoch({ intradaySmcIctProfile: "balanced", intradaySmcRequireChoch: true }),
    true,
  );
});

test("isBalancedSmcIctProfile", () => {
  assert.equal(isBalancedSmcIctProfile({ intradaySmcIctProfile: "balanced" }), true);
  assert.equal(isBalancedSmcIctProfile({ intradaySmcIctProfile: "sweep" }), false);
});

test("setup object — entryIdx is entry bar, reclaimIdx is sweep reclaim", () => {
  const candles = [];
  const baseTs = Date.UTC(2026, 0, 15, 12, 0, 0);
  for (let i = 0; i < 120; i++) {
    const w = Math.sin(i / 8) * 3;
    const c = 600 + w;
    candles.push(bar(baseTs + i * 15 * 60 * 1000, c, c + 2, c - 2, c));
  }
  const opts = {
    intradaySmcIctProfile: "sweep",
    intradaySmcKillzoneMode: "ALL",
    intradaySmcRequireHtfBias: false,
    intradaySmcVolFilterEnabled: false,
    intradaySmcMinAdx: 0,
    intradaySmcRequireMss: false,
    intradaySmcRequireRetrace: false,
    intradaySmcLookbackBars: 40,
    sweepPct: 0.001,
    intradayLiqMinSweepExtensionPct: 0.0001,
  };
  const pre = precomputeIntraday(candles);
  for (let i = 60; i < 100; i++) {
    for (const side of ["BUY", "SELL"]) {
      const s = evaluateSmcIctSetup(candles, i, side, pre, opts);
      if (!s) continue;
      assert.equal(s.entryIdx, i);
      assert.ok(s.reclaimIdx <= i);
      assert.ok(s.sweepReclaimIdx === s.reclaimIdx);
    }
  }
});

function bar(ts, o, h, l, c) {
  return { ts, open: o, high: h, low: l, close: c, volume: 1000 };
}

test("evaluateSmcIctSetup — no lookahead at idx (truncated vs full series)", () => {
  const candles = [];
  const dayMs = 86400000;
  const baseTs = Date.UTC(2026, 0, 15, 12, 0, 0);
  for (let i = 0; i < 120; i++) {
    const w = Math.sin(i / 8) * 3;
    const c = 600 + w;
    candles.push(bar(baseTs + i * 15 * 60 * 1000, c, c + 2, c - 2, c));
  }
  const opts = {
    intradayGateSmcIct: true,
    intradaySmcKillzoneMode: "ALL",
    intradaySmcRequireHtfBias: false,
    intradaySmcVolFilterEnabled: false,
    intradaySmcMinAdx: 0,
    intradaySmcRequireMss: false,
    intradaySmcRequireRetrace: false,
    intradaySmcLookbackBars: 40,
    sweepPct: 0.001,
    intradayLiqMinSweepExtensionPct: 0.0001,
  };
  const idx = 80;
  const preFull = precomputeIntraday(candles);
  const prePartial = precomputeIntraday(candles.slice(0, idx + 1));
  for (const side of ["BUY", "SELL"]) {
    const full = evaluateSmcIctSetup(candles, idx, side, preFull, opts);
    const partial = evaluateSmcIctSetup(candles.slice(0, idx + 1), idx, side, prePartial, opts);
    const fullAction = full?.action ?? null;
    const partialAction = partial?.action ?? null;
    assert.equal(partialAction, fullAction, `side=${side} action mismatch`);
    if (full && partial) {
      assert.equal(partial.reclaimIdx, full.reclaimIdx);
      assert.equal(partial.mssIdx ?? partial.bosIdx, full.mssIdx ?? full.bosIdx);
    }
  }
});

test("ICT preset — selectIntradayPicks emits valid action series", () => {
  const candles = [];
  const baseTs = Date.UTC(2026, 1, 10, 8, 0, 0);
  for (let i = 0; i < 200; i++) {
    const c = 580 + Math.sin(i / 10) * 8 + (i > 100 ? (i - 100) * 0.02 : 0);
    candles.push(bar(baseTs + i * 15 * 60 * 1000, c - 0.5, c + 2, c - 2, c));
  }
  const cfg = fillSmcSoloPresetDefaults({
    ...INTRADAY_PRO_ICT_15M,
    symbol: "BNBUSDT",
    timeframe: "15m",
    intradaySmcVolFilterEnabled: false,
    intradaySmcMinAdx: 0,
  });
  const { series } = selectIntradayPicks(candles, cfg);
  const picks = series.filter((s) => s?.action);
  for (const p of picks) {
    assert.ok(p.ts >= candles[0].ts);
    assert.ok(typeof p.action === "string");
  }
  assert.ok(Array.isArray(picks));
});
