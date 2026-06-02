import test from "node:test";
import assert from "node:assert/strict";
import {
  findDealingRange,
  passesPremiumDiscount,
  resolveRequirePremiumDiscount,
} from "./dealingRange.js";

function bar(ts, o, h, l, c) {
  return { ts, open: o, high: h, low: l, close: c, volume: 1000 };
}

test("findDealingRange uses lookback high/low inclusive of idx", () => {
  const candles = [
    bar(0, 100, 110, 90, 105),
    bar(60_000, 105, 120, 95, 115),
    bar(120_000, 115, 118, 100, 102),
  ];
  const dr = findDealingRange(candles, 2, { intradaySmcDealingRangeLookback: 10 });
  assert.equal(dr.high, 120);
  assert.equal(dr.low, 90);
  assert.equal(dr.equilibrium, 105);
});

test("passesPremiumDiscount — long in discount, short in premium", () => {
  const dr = { high: 120, low: 100, equilibrium: 110, range: 20 };
  assert.equal(passesPremiumDiscount("BUY", 105, dr, {}), true);
  assert.equal(passesPremiumDiscount("BUY", 115, dr, {}), false);
  assert.equal(passesPremiumDiscount("SELL", 115, dr, {}), true);
  assert.equal(passesPremiumDiscount("SELL", 105, dr, {}), false);
});

test("resolveRequirePremiumDiscount defaults on for full profile only", () => {
  assert.equal(resolveRequirePremiumDiscount({ intradaySmcIctProfile: "full" }), true);
  assert.equal(resolveRequirePremiumDiscount({ intradaySmcIctProfile: "sweep" }), false);
  assert.equal(
    resolveRequirePremiumDiscount({ intradaySmcIctProfile: "sweep", intradaySmcRequirePremiumDiscount: true }),
    true,
  );
});
