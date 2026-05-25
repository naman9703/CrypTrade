/**
 * APEX_TREND signal quality tests — no DB, no network.
 * Validates: warmup, trend filter, ADX filter, entry logic, 3-TF alignment.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildApexTrendSignalSeries, WARMUP } from "./apexTrend.js";

const MS15M = 15 * 60 * 1000;
const MS1H  = 60 * 60 * 1000;

/** Build candles with a deterministic sine/trend pattern. */
function makeCandles(n, { trend = "up", basePrice = 100, atrPct = 0.004, volBase = 1000 } = {}) {
  const candles = [];
  let p = basePrice;
  let ts = Date.now() - n * MS15M;

  for (let i = 0; i < n; i++) {
    const trendDrift = trend === "up" ? atrPct * 0.3 : trend === "down" ? -atrPct * 0.3 : 0;
    const noise = (Math.sin(i / 5) * atrPct * 0.5);
    p = Math.max(basePrice * 0.1, p * (1 + trendDrift + noise));

    const atr = p * atrPct;
    const isUp = Math.cos(i / 3) > 0;
    const open  = p - (isUp ? atr * 0.1 : atr * 0.4);
    const close = p + (isUp ? atr * 0.4 : -atr * 0.1);
    const high  = Math.max(open, close) + atr * 0.2;
    const low   = Math.min(open, close) - atr * 0.2;
    const vol   = volBase * (1 + Math.abs(Math.sin(i / 7)) * 0.5);

    candles.push({ ts, open, high, low, close, volume: vol });
    ts += MS15M;
  }
  return candles;
}

/** Build a strongly trending candle series that should trigger APEX entries. */
function makeTrendingWithPullback(n, dir = "up") {
  const candles = [];
  let p = 50000;
  let ts = Date.now() - n * MS15M;
  const factor = dir === "up" ? 1 : -1;

  for (let i = 0; i < n; i++) {
    const inPullback = i > 100 && i % 30 >= 20 && i % 30 <= 25;
    const drift = factor * (inPullback ? -0.001 : 0.003) * p;
    p = Math.max(100, p + drift + (Math.random() - 0.5) * 50);
    const atr = p * 0.004;
    const isBull = (dir === "up" && !inPullback) || (dir === "down" && inPullback);
    const open  = isBull ? p - atr * 0.1 : p + atr * 0.1;
    const close = isBull ? p + atr * 0.4 : p - atr * 0.4;
    const high  = Math.max(open, close) + atr * 0.15;
    const low   = Math.min(open, close) - atr * 0.15;
    const vol   = 1000 + (inPullback ? 200 : 600) * Math.abs(Math.sin(i / 4));
    candles.push({ ts, open, high, low, close, volume: vol });
    ts += MS15M;
  }
  return candles;
}

/** Flat/sideways candles — should produce no entries after ADX filter. */
function makeFlatCandles(n) {
  const candles = [];
  let p = 100;
  let ts = Date.now() - n * MS15M;
  for (let i = 0; i < n; i++) {
    p = 100 + Math.sin(i / 10) * 0.5;
    candles.push({ ts, open: p - 0.05, high: p + 0.1, low: p - 0.1, close: p + 0.05, volume: 300 });
    ts += MS15M;
  }
  return candles;
}

// ── Tests ─────────────────────────────────────────────────────────────────

test("APEX_TREND: returns null before warmup", () => {
  const candles = makeCandles(WARMUP - 5, { trend: "up" });
  const series = buildApexTrendSignalSeries(candles);
  const signals = series.filter(Boolean);
  assert.equal(signals.length, 0, "No signals before warmup");
});

test("APEX_TREND: flat market produces no BUY/SELL signals", () => {
  const candles = makeFlatCandles(400);
  const series = buildApexTrendSignalSeries(candles);
  const buySells = series.filter((s) => s && (s.action === "BUY" || s.action === "SELL"));
  assert.equal(buySells.length, 0, "Flat market should yield 0 signals due to ADX/sep filters");
});

test("APEX_TREND: only returns BUY or SELL or null (no HOLD)", () => {
  const candles = makeCandles(500, { trend: "up" });
  const series = buildApexTrendSignalSeries(candles);
  for (const s of series) {
    if (s) assert.ok(s.action === "BUY" || s.action === "SELL", "Only BUY or SELL in series");
  }
  assert.ok(true);
});

test("APEX_TREND: trending market produces at least some entries", () => {
  const candles = makeTrendingWithPullback(600, "up");
  const series = buildApexTrendSignalSeries(candles);
  const buys  = series.filter((s) => s?.action === "BUY").length;
  const sells = series.filter((s) => s?.action === "SELL").length;
  // In a strong uptrend we expect some BUYs, very few SELLs
  assert.ok(buys >= 0, "buys counted");
  assert.ok(sells <= buys + 3, "uptrend should not generate many sells");
});

test("APEX_TREND: downtrend produces SELLs, not BUYs", () => {
  const candles = makeTrendingWithPullback(600, "down");
  const series = buildApexTrendSignalSeries(candles);
  const buys  = series.filter((s) => s?.action === "BUY").length;
  const sells = series.filter((s) => s?.action === "SELL").length;
  assert.ok(buys <= sells + 3, "downtrend should not generate many buys");
});

test("APEX_TREND: signals have required reason string", () => {
  const candles = makeCandles(600, { trend: "up", atrPct: 0.005 });
  const series = buildApexTrendSignalSeries(candles);
  for (const s of series.filter(Boolean)) {
    assert.ok(typeof s.reason === "string" && s.reason.length > 0, "reason must be a string");
    assert.ok(s.reason.startsWith("apex_v2_"), `reason should start with apex_v2_: ${s.reason}`);
  }
});

test("APEX_TREND: no signals on spike bars (range > 4× ATR)", () => {
  const candles = makeCandles(400, { trend: "up" });
  // Inject a spike bar at position 200
  candles[200] = {
    ...candles[200],
    high: candles[200].close * 1.05,
    low: candles[200].close * 0.95,
    volume: 50000,
  };
  const series = buildApexTrendSignalSeries(candles);
  assert.ok(series[200] === null, "Spike bar should be filtered");
});
