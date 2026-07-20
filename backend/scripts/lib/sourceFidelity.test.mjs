import test from "node:test";
import assert from "node:assert/strict";
import { getFeatureFidelity, canPromoteFeature, SOURCE_FIDELITY } from "./sourceFidelity.js";

test("binance funding is native and promotion allowed", () => {
  const m = getFeatureFidelity("binance_funding_rate");
  assert.equal(m.fidelity, "native");
  assert.equal(m.requiresProxyValidation, false);
});

test("bybit OI requires proxy validation and blocks auto promotion", () => {
  const m = getFeatureFidelity("bybit_oi_change_4h");
  assert.equal(m.fidelity, "cross_venue_proxy");
  assert.equal(canPromoteFeature("bybit_oi_change_4h"), false);
});

test("bybit can promote only after proxy validation passes", () => {
  const proxy = { coins: { BTCUSDT: { pearsonOi: 0.92 } } };
  SOURCE_FIDELITY.bybit_oi_usdt.promotionAllowed = true;
  assert.equal(canPromoteFeature("bybit_oi_usdt", proxy), true);
  SOURCE_FIDELITY.bybit_oi_usdt.promotionAllowed = false;
});
