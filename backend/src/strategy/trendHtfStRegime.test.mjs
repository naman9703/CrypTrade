import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateTrendHtfStRegime,
  classifyTrendHtfStTradeOutcome,
  shouldAllowTrendHtfStEntry,
  isTrendHtfStRegimeGateEnabled,
  TREND_HTF_ST_REGIME_DEFAULTS,
  TREND_HTF_ST_MACRO_PROFILES,
} from "./trendHtfStRegime.js";

function synthCandles(n, drift = 0.001) {
  const out = [];
  let px = 100;
  const start = Date.UTC(2025, 5, 1);
  for (let i = 0; i < n; i++) {
    const ts = start + i * 15 * 60 * 1000;
    const o = px;
    px *= 1 + drift * (i % 2 === 0 ? 1 : -1);
    const c = px;
    out.push({ ts, open: o, high: Math.max(o, c) * 1.002, low: Math.min(o, c) * 0.998, close: c, volume: 1000 });
  }
  return out;
}

test("regime gate opt-in (default off)", () => {
  assert.equal(isTrendHtfStRegimeGateEnabled({}), false);
  assert.equal(isTrendHtfStRegimeGateEnabled({ trendHtfStRegimeGate: true }), true);
  assert.equal(isTrendHtfStRegimeGateEnabled({ trendHtfStRegimeGate: false }), false);
});

test("evaluateTrendHtfStRegime returns allowEntry and structuralRisk", () => {
  const candles = synthCandles(800, 0.0003);
  const r = evaluateTrendHtfStRegime(candles, 600, "BUY", {});
  assert.ok(r);
  assert.equal(typeof r.allowEntry, "boolean");
  assert.ok(["CHOP_ZONE", "TREND_OK", "MIXED"].includes(r.structuralRisk));
});

test("classifyTrendHtfStTradeOutcome", () => {
  assert.equal(
    classifyTrendHtfStTradeOutcome({ netPnl: -1, exitReason: "sl", barsHeld: 2, mfePct: 0.002 }),
    "INSTANT_SL",
  );
});

test("production defaults are frozen constants", () => {
  assert.equal(TREND_HTF_ST_MACRO_PROFILES.CHOP_SEASON.minHtfSep, 0.0008);
  assert.equal(TREND_HTF_ST_MACRO_PROFILES.TREND_SEASON.tpTrendOk, 0.03);
});
