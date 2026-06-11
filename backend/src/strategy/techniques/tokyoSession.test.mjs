import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSweepFadeBrackets,
  buildTokyoBrackets,
  buildTokyoSessionSeries,
  inTokyoSession,
  resolveAdaptiveSlPrice,
  resolveDynamicTpLegs,
  resolveTokyoDirection,
  TOKYO_SESSION_DEFAULTS,
} from "./tokyoSession.js";
import { resolveLiquidityEntryBrackets } from "./liquidity.js";

function bar(ts, o, h, l, c) {
  return { ts, open: o, high: h, low: l, close: c, volume: 1 };
}

describe("tokyoSession", () => {
  it("inTokyoSession matches 00:00–04:00 UTC", () => {
    const d = Date.UTC(2026, 0, 15, 0, 15, 0);
    assert.equal(inTokyoSession(d), true);
    assert.equal(inTokyoSession(Date.UTC(2026, 0, 15, 4, 0, 0)), false);
    assert.equal(inTokyoSession(Date.UTC(2026, 0, 15, 23, 45, 0)), false);
  });

  it("resolveTokyoDirection BOTH_BODY requires same color", () => {
    const c1 = bar(0, 100, 101, 99, 100.5);
    const c2 = bar(0, 100.5, 102, 100, 101.5);
    assert.equal(resolveTokyoDirection(c1, c2, { dirMode: "BOTH_BODY" }), "BUY");
    const b1 = bar(0, 101, 101, 99, 99.5);
    const b2 = bar(0, 99.5, 100, 98, 98.5);
    assert.equal(resolveTokyoDirection(b1, b2, { dirMode: "BOTH_BODY" }), "SELL");
    const m1 = bar(0, 100, 101, 99, 100.5);
    const m2 = bar(0, 100.5, 101, 99, 99.8);
    assert.equal(resolveTokyoDirection(m1, m2, { dirMode: "BOTH_BODY", skipMixedBodies: true }), null);
  });

  it("DYNAMIC TP1/TP2 legs — TP1 below 1R, TP2 structure extension", () => {
    const c1 = bar(0, 100, 101, 99.5, 100.5);
    const c2 = bar(0, 100.5, 102, 100, 101);
    const pre = { hi: 102.5, lo: 98.5, mid: 100.5, width: 4 };
    const brackets = buildTokyoBrackets(
      101,
      c1,
      c2,
      "BUY",
      { slMode: "DYNAMIC", tpMode: "DYNAMIC", tokyoPartialTp: true, slMinPct: 0.0065 },
      0.8,
      pre,
    );
    const risk = 101 - brackets.slPrice;
    assert.ok(brackets.tp1Price > 101);
    assert.ok(brackets.tp1Price < 101 + risk, "TP1 should be below 1R");
    assert.ok(brackets.tpPrice > brackets.tp1Price, "TP2 above TP1");
    assert.equal(brackets.partialTp, true);
    assert.equal(brackets.tpMode, "tokyo_dynamic_partial");
    const legs = resolveDynamicTpLegs(101, brackets.slPrice, "BUY", c1, c2, pre, {
      tokyoTp1Rr: 0.8,
      tokyoTp2Rr: 1.75,
    });
    assert.ok(legs.tp1 < 101 + risk);
    assert.ok(legs.tp2 > legs.tp1);
  });

  it("resolveLiquidityEntryBrackets preserves tokyo dynamic TP1", () => {
    const c1 = bar(0, 100, 101, 99.5, 100.5);
    const c2 = bar(0, 100.5, 102, 100, 101);
    const pre = { hi: 102.5, lo: 98.5, mid: 100.5, width: 4 };
    const baked = buildTokyoBrackets(101, c1, c2, "BUY", { slMode: "DYNAMIC", tpMode: "DYNAMIC" }, 0.8, pre);
    const resolved = resolveLiquidityEntryBrackets(
      { intradayLiqPartialTp: true, intradayLiqTp1Enabled: true, intradayLiqTp2Enabled: true },
      { liqBrackets: baked, action: "BUY" },
      101,
      "BUY",
    );
    assert.ok(Math.abs(resolved.tp1Price - baked.tp1Price) < 0.01);
    assert.ok(resolved.tp1Price < 101 + (101 - baked.slPrice));
  });

  it("ADAPTIVE SL widens tight structure stop to min floor", () => {
    const c1 = bar(0, 100, 100.15, 99.95, 100.1);
    const c2 = bar(0, 100.1, 100.2, 100.05, 100.18);
    const entry = 100.18;
    const tight = resolveAdaptiveSlPrice(entry, c1, c2, "BUY", 0.5, {
      slMode: "ADAPTIVE",
      slMinPct: 0.003,
      slMaxPct: 0.01,
      slSpanMult: 0.35,
    });
    assert.ok(tight < entry);
    const distPct = (entry - tight) / entry;
    assert.ok(distPct >= 0.003 - 1e-6, `expected >= 0.3% SL dist, got ${distPct}`);
  });

  it("buildTokyoBrackets sets 2R TP for long", () => {
    const c1 = bar(0, 100, 101, 99.5, 100.5);
    const c2 = bar(0, 100.5, 102, 100, 101);
    const brackets = buildTokyoBrackets(101, c1, c2, "BUY", {
      slMode: "FIRST2_RANGE",
      tpMode: "RR",
      tpRr: 2,
      tokyoPartialTp: false,
    });
    assert.ok(brackets.slPrice < 101);
    assert.ok(brackets.tpPrice > 101);
    assert.equal(brackets.rr, 2);
    const risk = 101 - brackets.slPrice;
    assert.ok(Math.abs(brackets.tpPrice - (101 + 2 * risk)) < 0.01);
  });

  it("SWEEP_HI_ONLY short targets pre-Asia low", () => {
    const pre = { hi: 102, lo: 98, mid: 100, width: 4 };
    const rejectBar = bar(0, 101.5, 102.5, 101, 101.2);
    const sweep = { side: "SELL", type: "SWEEP_HI_FADE", wick: 102.5, level: 102 };
    const brackets = buildSweepFadeBrackets(101.2, rejectBar, "SELL", sweep, pre, {
      tokyoSweepTpTarget: "PRE_LOW",
      tokyoSlBufferPct: 0.001,
    });
    assert.ok(brackets.slPrice > 101.2);
    assert.equal(brackets.tpPrice, 98);
    assert.equal(brackets.tpMode, "tokyo_sweep_fade");
  });

  it("signals only on 2nd Tokyo bar once per day", () => {
    const day = Date.UTC(2026, 0, 10, 0, 0, 0);
    const tf = 15 * 60 * 1000;
    const candles = [];
    for (let i = 0; i < 20; i++) {
      const ts = day + i * tf;
      const h = new Date(ts).getUTCHours();
      if (h >= 0 && h < 4) {
        candles.push(bar(ts, 100, 101, 99, 100.5));
      } else {
        candles.push(bar(ts, 100, 100.2, 99.8, 100));
      }
    }
    // Make 2nd session bar bullish pair
    candles[1] = bar(day + tf, 100, 101.5, 99.8, 101.2);
    const series = buildTokyoSessionSeries(candles, {
      ...TOKYO_SESSION_DEFAULTS,
      dirMode: "SECOND_MOMENTUM",
      minFirst2RangePct: 0,
    });
    const signals = series.filter(Boolean);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].action, "BUY");
    assert.equal(series[1].action, "BUY");
  });
});
