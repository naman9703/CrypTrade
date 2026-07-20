import test from "node:test";
import assert from "node:assert/strict";
import { l2FeaturesAt } from "../../src/backtest/data/observableFeatures.js";

test("l2FeaturesAt attaches binance funding with legacy aliases", () => {
  const series = {
    funding: [{ ts: 1000, rate: 0.0005 }],
    oi: [{ ts: 1000, oiUsdt: 1_100_000, longShortRatio: 1.2 }],
  };
  const f = l2FeaturesAt(series, 1500);
  assert.equal(f.binance_funding_rate, 0.0005);
  assert.equal(f.l2_funding_rate, 0.0005);
  assert.equal(f.binance_has_funding, 1);
});
