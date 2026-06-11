import assert from "node:assert";
import { test } from "node:test";
import { buildRegimeSeries, REGIMES, playbookForRegime } from "./regimeEngine.js";

function mkCandle(ts, close, range = 1) {
  return {
    ts,
    open: close,
    high: close + range / 2,
    low: close - range / 2,
    close,
    volume: 100,
  };
}

function series(closes, range = 1) {
  return closes.map((c, i) => mkCandle(i * 900_000, c, range));
}

test("strong uptrend => TREND_UP", () => {
  // Steady rising price for >warmup bars.
  const closes = [];
  let p = 100;
  for (let i = 0; i < 400; i++) {
    p += 0.5; // persistent up-move builds ADX + EMA stack
    closes.push(p);
  }
  const reg = buildRegimeSeries(series(closes, 0.4));
  const last = reg[reg.length - 1];
  assert.equal(last.regime, REGIMES.TREND_UP, `got ${last.regime}`);
});

test("strong downtrend => TREND_DOWN", () => {
  const closes = [];
  let p = 500;
  for (let i = 0; i < 400; i++) {
    p -= 0.5;
    closes.push(p);
  }
  const reg = buildRegimeSeries(series(closes, 0.4));
  assert.equal(reg[reg.length - 1].regime, REGIMES.TREND_DOWN);
});

test("tight directionless zigzag => RANGE (no sustained trend)", () => {
  // Fast 4-bar zigzag around a flat mean keeps ADX low and EMAs flat.
  const closes = [];
  for (let i = 0; i < 400; i++) closes.push(100 + (i % 4 < 2 ? 0.3 : -0.3));
  const reg = buildRegimeSeries(series(closes, 0.4));
  const back = reg.slice(300);
  const nonTrend = back.filter(
    (r) => r.regime !== REGIMES.TREND_UP && r.regime !== REGIMES.TREND_DOWN,
  ).length;
  assert.ok(nonTrend > back.length * 0.7, `too many trend labels: nonTrend=${nonTrend}/${back.length}`);
});

test("sustained high ATR% => VOLATILE_AVOID", () => {
  const closes = [];
  for (let i = 0; i < 400; i++) closes.push(100 + Math.sin(i / 5));
  const candles = series(closes, 0.5);
  // Inject a sustained burst of ~3%-range bars so smoothed ATR% clears the band.
  for (let k = 380; k < 400; k++) {
    const base = candles[k].close;
    candles[k] = { ...candles[k], high: base * 1.02, low: base * 0.98, volume: 4000 };
  }
  const reg = buildRegimeSeries(candles);
  assert.equal(reg[399].regime, REGIMES.VOLATILE_AVOID, `got ${reg[399].regime}`);
});

test("liquidation-cascade proxy (vol spike + OI drop) => VOLATILE_AVOID", () => {
  const closes = [];
  for (let i = 0; i < 400; i++) closes.push(100 + (i % 4 < 2 ? 0.2 : -0.2));
  const candles = series(closes, 0.3);
  const k = 395;
  candles[k] = { ...candles[k], volume: 100000 }; // huge volume z-spike
  // OI falling ~5% over the window.
  const oi = [];
  for (let i = 0; i < 400; i++) {
    oi.push({ ts: i * 900_000, oiUsdt: i >= 390 ? 95 : 100 });
  }
  const reg = buildRegimeSeries(candles, { oi });
  assert.equal(reg[k].regime, REGIMES.VOLATILE_AVOID, `got ${reg[k].regime}`);
});

test("playbookForRegime maps regimes to playbooks", () => {
  assert.equal(playbookForRegime(REGIMES.TREND_UP), "trend");
  assert.equal(playbookForRegime(REGIMES.RANGE), "mean_reversion");
  assert.equal(playbookForRegime(REGIMES.SQUEEZE), "breakout");
  assert.equal(playbookForRegime(REGIMES.VOLATILE_AVOID), "stand_down");
});

test("confidence is within [0,1]", () => {
  const closes = [];
  let p = 100;
  for (let i = 0; i < 400; i++) {
    p += Math.sin(i / 10) * 0.5 + 0.1;
    closes.push(p);
  }
  const reg = buildRegimeSeries(series(closes, 0.5));
  for (const r of reg) {
    assert.ok(r.confidence >= 0 && r.confidence <= 1, `conf out of range: ${r.confidence}`);
  }
});
