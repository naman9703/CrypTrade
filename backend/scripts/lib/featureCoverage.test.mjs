import test from "node:test";
import assert from "node:assert/strict";
import {
  accountFeatureColumnCoverage,
  accountGroupCoverage,
} from "./featureCoverage.js";

const sampleRows = [
  {
    entryYear: 2023,
    binance_has_funding: 1,
    binance_funding_rate: 0.0001,
    bybit_has_oi: 1,
    bybit_oi_usdt: 1e9,
    entryTs: 1_600_000_000_000,
  },
  { entryYear: 2024, binance_has_funding: 1, binance_funding_rate: 0.0002, entryTs: 1_700_000_000_000 },
];

test("accountGroupCoverage tracks bybit proxy separately", () => {
  const bybit = accountGroupCoverage(sampleRows, "bybit_positioning");
  assert.equal(bybit.fidelity, "cross_venue_proxy");
  assert.equal(bybit.meetsPromotionThreshold, false);
  assert.equal(bybit.evaluationConfidence, "proxy_exploratory");
});

test("accountFeatureColumnCoverage includes fidelity metadata", () => {
  const c = accountFeatureColumnCoverage(sampleRows, "binance_funding_rate");
  assert.equal(c.source, "binance");
  assert.equal(c.fidelity, "native");
});
