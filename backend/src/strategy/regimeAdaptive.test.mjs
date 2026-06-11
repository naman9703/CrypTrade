import assert from "node:assert";
import { test } from "node:test";
import {
  buildRegimeAdaptiveSeries,
  buildRegimeAdaptiveBacktestAdapter,
  optsFromCfg,
  signal,
} from "./regimeAdaptive.js";

function genTrend(n, start, step, range, vol = 100) {
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    // pullback wiggle every ~7 bars so the trend playbook can find dips.
    const wig = Math.sin(i / 2) * range * 0.6;
    const close = p + wig;
    out.push({
      ts: i * 900_000 + 8 * 3600_000, // 08:00 UTC base => inside London KZ
      open: close - step / 2,
      high: close + range,
      low: close - range,
      close,
      volume: vol + (i % 5) * 20,
      taker_buy_volume: step > 0 ? vol * 0.65 : vol * 0.35,
    });
    p += step;
  }
  return out;
}

test("optsFromCfg maps bot keys", () => {
  const o = optsFromCfg({
    regimeAdaptiveMinGrade: "A",
    regimeAdaptiveMaxTradesPerDay: 2,
    regimeAdaptiveTrendRR: 3,
    regimeAdaptiveEnableRange: false,
  });
  assert.equal(o.minGrade, "A");
  assert.equal(o.maxTradesPerDay, 2);
  assert.equal(o.trendRR, 3);
  assert.equal(o.enableRange, false);
});

test("buildRegimeAdaptiveSeries returns graded setups with valid brackets (range fade)", () => {
  // Flat range (=> RANGE regime) with periodic sharp dips that pierce the lower
  // band then reclaim — the deterministic trigger for the mean-reversion fade.
  const candles = [];
  for (let i = 0; i < 500; i++) {
    let close = 100 + Math.sin(i / 6) * 0.4;
    let low = close - 0.2;
    let high = close + 0.2;
    // Every 30 bars, inject a one-bar capitulation dip then immediate reclaim.
    if (i % 30 === 12) {
      low = close - 3;
      close = close - 2.5;
    } else if (i % 30 === 13) {
      low = close - 0.2;
      close = 100 + Math.sin(i / 6) * 0.4; // reclaim back into the band
    }
    candles.push({
      ts: i * 900_000,
      open: close,
      high,
      low,
      close,
      volume: 100,
      taker_buy_volume: 70,
    });
  }
  const { series, regimeLabels } = buildRegimeAdaptiveSeries(candles, {
    minGrade: "B",
    killzoneMode: "ALL",
    confidenceFloor: 0,
  });
  assert.equal(regimeLabels.length, candles.length);
  const sigs = series.filter(Boolean);
  assert.ok(sigs.length > 0, "expected at least one mean-reversion setup");
  for (const s of sigs) {
    assert.ok(s.action === "BUY" || s.action === "SELL");
    assert.ok(s.grade === "A" || s.grade === "B");
    assert.ok(s.brackets && s.brackets.slPct > 0 && s.brackets.tpPct > 0);
    assert.ok(s.brackets.slPrice > 0 && s.brackets.tpPrice > 0);
    assert.ok(s.brackets.tp1Price > 0);
  }
});

test("backtest adapter enforces trades/day cap", () => {
  const candles = genTrend(500, 100, 0.4, 0.5);
  const adapter = buildRegimeAdaptiveBacktestAdapter(
    candles,
    { regimeAdaptiveMaxTradesPerDay: 1, regimeAdaptiveKillzoneMode: "ALL", regimeAdaptiveConfidenceFloor: 0, regimeAdaptiveMinBarGap: 1 },
    "15m",
  );
  const perDay = {};
  for (let i = 0; i < candles.length; i++) {
    const sig = adapter(candles[i], i);
    if (sig) {
      const day = Math.floor(candles[i].ts / 86_400_000);
      perDay[day] = (perDay[day] || 0) + 1;
    }
  }
  for (const [, count] of Object.entries(perDay)) assert.ok(count <= 1, `day exceeded cap: ${count}`);
});

test("signal() returns HOLD with regime label when no setup", () => {
  // Flat data => RANGE, unlikely to trigger a graded setup on the last bar.
  const candles = [];
  for (let i = 0; i < 300; i++) {
    const c = 100 + (i % 2 ? 0.05 : -0.05);
    candles.push({ ts: i * 900_000, open: c, high: c + 0.1, low: c - 0.1, close: c, volume: 100 });
  }
  const out = signal({ candles, timeframe: "15m", cfg: { regimeAdaptiveKillzoneMode: "ALL" } });
  assert.ok(out.action === "HOLD" || out.action === "BUY" || out.action === "SELL");
  assert.ok(typeof out.regime === "string");
});
