import test from "node:test";
import assert from "node:assert/strict";
import {
  binanceObservableAt,
  bybitObservableAt,
  observableFeaturesAt,
  l2FeaturesAt,
} from "../../src/backtest/data/observableFeatures.js";

test("binanceObservableAt uses source-prefixed columns", () => {
  const series = {
    funding: [{ ts: 1000, rate: 0.0005 }],
    oi: [{ ts: 1000, oiUsdt: 1e9, longShortRatio: 1.1 }],
  };
  const f = binanceObservableAt(series, 1500);
  assert.equal(f.binance_funding_rate, 0.0005);
  assert.equal(f.binance_has_funding, 1);
  assert.equal(f.binance_oi_usdt, 1e9);
});

test("bybitObservableAt labels cross-venue proxy fields", () => {
  const series = {
    oi: [{ ts: 1000, oiUsdt: 2e9 }],
    lsr: [{ ts: 1000, buyRatio: 0.52, sellRatio: 0.48, longShortRatio: 1.08 }],
  };
  const f = bybitObservableAt(series, 1500);
  assert.equal(f.bybit_oi_usdt, 2e9);
  assert.equal(f.bybit_has_oi, 1);
  assert.ok(f.bybit_long_short_ratio > 1);
});

test("observableFeaturesAt merges binance and bybit without mixing", () => {
  const f = observableFeaturesAt(
    {
      binance: { funding: [{ ts: 1000, rate: 0.0001 }], oi: [] },
      bybit: { oi: [{ ts: 1000, oiUsdt: 3e9 }], lsr: [] },
    },
    1500,
  );
  assert.equal(f.binance_funding_rate, 0.0001);
  assert.equal(f.bybit_oi_usdt, 3e9);
  assert.equal(f.binance_oi_usdt, null);
});

test("l2FeaturesAt keeps legacy l2_* aliases", () => {
  const series = { funding: [{ ts: 1000, rate: 0.0002 }], oi: [] };
  const f = l2FeaturesAt(series, 1500);
  assert.equal(f.l2_funding_rate, f.binance_funding_rate);
});
