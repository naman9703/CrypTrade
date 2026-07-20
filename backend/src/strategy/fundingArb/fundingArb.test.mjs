/**
 * Unit tests — funding arb types + signal + monitor + risk stubs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  annualizeFundingRate,
  carrySideFromRate,
  computeBasis,
  fundingIncomeBetween,
  CARRY_SIDE,
  shouldEnter,
  shouldExit,
  consecutiveSameSide,
  evaluateSymbolOpportunity,
  scanFundingOpportunities,
  capitalDeployed,
  checkMarginHealth,
  checkFundingFlip,
  verifyHedge,
  HedgeMismatchError,
} from "./index.js";

test("annualizeFundingRate — 0.01% per 8h ≈ 10.95% annualized", () => {
  const ann = annualizeFundingRate(0.0001, 8);
  assert.ok(Math.abs(ann - 10.95) < 0.05);
});

test("carrySideFromRate maps sign", () => {
  assert.equal(carrySideFromRate(0.0001), CARRY_SIDE.LONG_SPOT_SHORT_PERP);
  assert.equal(carrySideFromRate(-0.0001), CARRY_SIDE.SHORT_SPOT_LONG_PERP);
  assert.equal(carrySideFromRate(0), null);
});

test("computeBasis", () => {
  assert.ok(Math.abs(computeBasis(100, 101) - 0.01) < 1e-9);
  assert.equal(computeBasis(0, 100), null);
});

test("shouldEnter — threshold + stability", () => {
  // ~21.9% ann at 0.0002 / 8h — clears 8% but not default 25%
  const rates = [
    { ts: 1, rate: 0.0002 },
    { ts: 2, rate: 0.0002 },
  ];
  const ok = shouldEnter({
    rate: 0.0002,
    recentRates: rates,
    cfg: { minAnnualizedYieldPct: 8, stabilityIntervals: 2, avgLookback: 1 },
  });
  assert.equal(ok.enter, true);
  assert.equal(ok.side, CARRY_SIDE.LONG_SPOT_SHORT_PERP);

  const low = shouldEnter({
    rate: 0.00001,
    recentRates: [{ ts: 1, rate: 0.00001 }],
    cfg: { minAnnualizedYieldPct: 8, stabilityIntervals: 1, avgLookback: 1 },
  });
  assert.equal(low.enter, false);
  assert.equal(low.reason, "below_min_annualized");

  const unstable = shouldEnter({
    rate: 0.0002,
    recentRates: [{ ts: 1, rate: -0.0001 }, { ts: 2, rate: 0.0002 }],
    cfg: { minAnnualizedYieldPct: 8, stabilityIntervals: 2, avgLookback: 1 },
  });
  assert.equal(unstable.enter, false);
  assert.equal(unstable.reason, "unstable_streak");
});

test("shouldEnter — requires consecutive above raised threshold", () => {
  // 0.0003 ≈ 32.85% ann — needs 3 consecutive above 25%
  const high = { rate: 0.0003 };
  const mid = { rate: 0.00015 }; // ~16% — below 25%
  assert.equal(
    shouldEnter({
      rate: 0.0003,
      recentRates: [mid, high, high],
      cfg: { minAnnualizedYieldPct: 25, stabilityIntervals: 3, avgLookback: 1 },
    }).enter,
    false,
  );
  assert.equal(
    shouldEnter({
      rate: 0.0003,
      recentRates: [high, high, high],
      cfg: { minAnnualizedYieldPct: 25, stabilityIntervals: 3, avgLookback: 1 },
    }).enter,
    true,
  );
});

test("shouldExit — flip and decay", () => {
  const flip = shouldExit({
    rate: -0.0001,
    positionSide: CARRY_SIDE.LONG_SPOT_SHORT_PERP,
  });
  assert.equal(flip.exit, true);
  assert.equal(flip.reason, "funding_flip_negative");
  assert.equal(flip.hard, true);

  const hold = shouldExit({
    rate: 0.0002,
    positionSide: CARRY_SIDE.LONG_SPOT_SHORT_PERP,
    cfg: { exitAnnualizedYieldPct: 2, minHoldIntervals: 0 },
  });
  assert.equal(hold.exit, false);

  const decay = shouldExit({
    rate: 0.00001,
    positionSide: CARRY_SIDE.LONG_SPOT_SHORT_PERP,
    holdIntervals: 20,
    cfg: { exitAnnualizedYieldPct: 2, minHoldIntervals: 0 },
  });
  assert.equal(decay.exit, true);
  assert.equal(decay.reason, "yield_decay");
});

test("shouldExit — min hold blocks soft yield decay", () => {
  const blocked = shouldExit({
    rate: 0.00001,
    positionSide: CARRY_SIDE.LONG_SPOT_SHORT_PERP,
    holdIntervals: 3,
    cfg: { exitAnnualizedYieldPct: 5, minHoldIntervals: 9 },
  });
  assert.equal(blocked.exit, false);
  assert.equal(blocked.reason, "min_hold_active");

  const flipAlways = shouldExit({
    rate: -0.0001,
    positionSide: CARRY_SIDE.LONG_SPOT_SHORT_PERP,
    holdIntervals: 1,
    cfg: { minHoldIntervals: 9 },
  });
  assert.equal(flipAlways.exit, true);
  assert.equal(flipAlways.hard, true);
});

test("consecutiveSameSide", () => {
  const rates = [
    { rate: 0.0001 },
    { rate: 0.0002 },
    { rate: -0.0001 },
    { rate: 0.0001 },
    { rate: 0.0001 },
  ];
  assert.equal(consecutiveSameSide(rates, CARRY_SIDE.LONG_SPOT_SHORT_PERP), 2);
});

test("fundingIncomeBetween — short receives positive funding", () => {
  const rates = [{ ts: 1000, rate: 0.0001 }, { ts: 2000, rate: 0.0001 }];
  const income = fundingIncomeBetween("SELL", 1, 100_000, rates, 500, 2500);
  // 2 settlements * 0.0001 * 100000 = 20
  assert.ok(Math.abs(income - 20) < 1e-6);
  const longPays = fundingIncomeBetween("BUY", 1, 100_000, rates, 500, 2500);
  assert.ok(Math.abs(longPays + 20) < 1e-6);
});

test("evaluateSymbolOpportunity + scan", () => {
  const rates = [
    { ts: 1, rate: 0.0002 },
    { ts: 2, rate: 0.0002 },
    { ts: 3, rate: 0.0002 },
  ];
  const row = evaluateSymbolOpportunity({
    symbol: "BTCUSDT",
    rates,
    spotPx: 100,
    perpPx: 100.2,
    cfg: { minAnnualizedYieldPct: 8, stabilityIntervals: 2, avgLookback: 1 },
  });
  assert.equal(row.ok, true);
  assert.equal(row.enter, true);
  assert.ok(row.basis > 0);

  const scanned = scanFundingOpportunities([
    { symbol: "ETHUSDT", rates },
  ], { minAnnualizedYieldPct: 8, stabilityIntervals: 2, avgLookback: 1 });
  assert.equal(scanned.length, 1);
});

test("risk helpers", () => {
  assert.equal(capitalDeployed(10_000, 5), 12_000);
  assert.equal(checkMarginHealth({ usedMargin: 60, totalMargin: 100 }, 0.5), "REDUCE_POSITION");
  assert.equal(checkMarginHealth({ usedMargin: 40, totalMargin: 100 }, 0.5), "OK");
  assert.equal(
    checkFundingFlip({ rate: -0.001 }, CARRY_SIDE.LONG_SPOT_SHORT_PERP),
    "EXIT_SIGNAL",
  );
});

test("verifyHedge throws on mismatch", () => {
  assert.equal(verifyHedge({ filled_qty: 1 }, { filled_qty: 1 }, 1), true);
  assert.throws(
    () => verifyHedge({ filled_qty: 1 }, { filled_qty: 0.5 }, 1),
    HedgeMismatchError,
  );
});
