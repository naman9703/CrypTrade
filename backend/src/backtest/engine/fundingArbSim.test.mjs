/**
 * Unit tests — dual-leg funding arb simulator.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runFundingArbSim, basisPnl, aggregateFundingArbResults } from "./fundingArbSim.js";
import { CARRY_SIDE } from "../../strategy/fundingArb/types.js";

function mkCandle(ts, close) {
  return { ts, open: close, high: close, low: close, close, volume: 1 };
}

test("basisPnl long-spot short-perp", () => {
  // Spot up 1, perp up 1 → basis pnl ≈ 0
  assert.ok(Math.abs(basisPnl(CARRY_SIDE.LONG_SPOT_SHORT_PERP, 1, 100, 100, 101, 101)) < 1e-9);
  // Spot up 2, perp up 1 → +1
  assert.ok(Math.abs(basisPnl(CARRY_SIDE.LONG_SPOT_SHORT_PERP, 1, 100, 100, 102, 101) - 1) < 1e-9);
});

test("runFundingArbSim — synthetic positive funding harvest", () => {
  const start = Date.parse("2025-01-01T00:00:00Z");
  const interval = 8 * 3600 * 1000;
  const fundingRates = [];
  const spotCandles = [];
  const perpCandles = [];
  // 12 settlements of +0.0003 (~32.85% ann) — clears 25% entry with stability=2
  for (let i = 0; i < 12; i++) {
    const ts = start + i * interval;
    fundingRates.push({ ts, rate: 0.0003 });
    spotCandles.push(mkCandle(ts, 100));
    perpCandles.push(mkCandle(ts, 100));
  }
  // Then flip to negative → exit
  for (let i = 12; i < 14; i++) {
    const ts = start + i * interval;
    fundingRates.push({ ts, rate: -0.0001 });
    spotCandles.push(mkCandle(ts, 100));
    perpCandles.push(mkCandle(ts, 100));
  }

  const sim = runFundingArbSim({
    symbol: "BTCUSDT",
    fundingRates,
    spotCandles,
    perpCandles,
    cfg: {
      minAnnualizedYieldPct: 25,
      exitAnnualizedYieldPct: 5,
      stabilityIntervals: 2,
      avgLookback: 2,
      minHoldIntervals: 0,
      feeMode: "maker",
      notionalUsdt: 10_000,
      perpLeverage: 5,
      feeStressMult: 1,
    },
  });

  assert.ok(sim.trades.length >= 1, "expected at least one carry trade");
  const t = sim.trades[0];
  assert.equal(t.carrySide, CARRY_SIDE.LONG_SPOT_SHORT_PERP);
  assert.ok(t.fundingIncome > 0, "should collect positive funding while short perp");
  assert.ok(Number.isFinite(t.netPnl));
  assert.equal(typeof sim.summary.honestyPass, "boolean");
});

test("runFundingArbSim — no entry when rates below threshold", () => {
  const start = Date.parse("2025-02-01T00:00:00Z");
  const interval = 8 * 3600 * 1000;
  const fundingRates = [];
  const spotCandles = [];
  const perpCandles = [];
  for (let i = 0; i < 10; i++) {
    const ts = start + i * interval;
    fundingRates.push({ ts, rate: 0.00001 }); // ~1.1% ann
    spotCandles.push(mkCandle(ts, 50));
    perpCandles.push(mkCandle(ts, 50));
  }
  const sim = runFundingArbSim({
    symbol: "ETHUSDT",
    fundingRates,
    spotCandles,
    perpCandles,
    cfg: { minAnnualizedYieldPct: 8, stabilityIntervals: 1 },
  });
  assert.equal(sim.trades.length, 0);
  assert.equal(sim.summary.honestyPass, false);
});

test("aggregateFundingArbResults", () => {
  const a = runFundingArbSim({
    symbol: "A",
    fundingRates: [],
    spotCandles: [],
    perpCandles: [],
  });
  const agg = aggregateFundingArbResults([a]);
  assert.deepEqual(agg.symbols, ["A"]);
  assert.equal(agg.trades, 0);
});
