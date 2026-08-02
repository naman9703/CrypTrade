import test from "node:test";
import assert from "node:assert/strict";
import {
  fundingMetricsAtTs,
  buildBacktestSnapshotFields,
  oiDeltaPct,
} from "./microEventBacktestHydration.js";
import {
  buildMicroEventRadarStatus,
  resetMicroEventRadarTapeForTests,
} from "../microEventRadarStatus.js";

test("fundingMetricsAtTs computes z-score from prior rates", () => {
  const rates = [];
  for (let i = 0; i < 90; i++) {
    rates.push({ ts: 1_000_000 + i * 3_600_000, rate: 0.0001 });
  }
  rates.push({ ts: 1_000_000 + 90 * 3_600_000, rate: 0.0005 });
  const m = fundingMetricsAtTs(rates, rates[rates.length - 1].ts);
  assert.ok(m.fundingZ != null && m.fundingZ > 2);
  assert.equal(m.crowdedSide, "extremely_long");
});

test("buildBacktestSnapshotFields aligns liqZLike with prior-window ratio", () => {
  const ts = 1_700_000_000_000;
  const liqTicks = [
    { time: ts - 120_000, side: "SELL", notionalUsd: 10_000 },
    { time: ts - 60_000, side: "SELL", notionalUsd: 5_000 },
    { time: ts - 30_000, side: "SELL", notionalUsd: 50_000 },
    { time: ts - 10_000, side: "SELL", notionalUsd: 40_000 },
  ];
  const snap = buildBacktestSnapshotFields(ts, {
    symbol: "BTCUSDT",
    liqTicks,
    liqWindowSec: 90,
    domRatio: 1.2,
    aggTrades: [],
    fundingRates: [],
    oiSeries: [],
    oiAvailableFromMs: null,
  });
  assert.equal(snap.liqDom, "longs");
  assert.ok(snap.liqZLike > 1);
  assert.equal(snap.bookGateExcluded, true);
});

test("oiDeltaPct returns null when prior sample missing", () => {
  const series = [{ ts: 1000, oi: 100 }];
  assert.equal(oiDeltaPct(series, 2000, 60_000), null);
});

test("buildMicroEventRadarStatus includes readiness gates and coins", () => {
  resetMicroEventRadarTapeForTests();
  const status = buildMicroEventRadarStatus({
    state: {
      running: true,
      manualStrategy: "MICRO_EVENT",
      symbol: "BTCUSDT",
      microEventLiveTickEnabled: true,
      supertrendFuturesTwoWay: true,
    },
    depthStatusBySymbol: {},
    positions: [],
    getTradingMode: () => "PAPER",
  });
  assert.ok(Array.isArray(status.readinessGates));
  assert.ok(status.readinessGates.some((g) => g.id === "two_way" && g.ok));
  assert.ok(Array.isArray(status.coins));
  assert.equal(status.mode, "tick");
});
