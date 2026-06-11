import test from "node:test";
import assert from "node:assert/strict";
import {
  barDelta,
  barDeltaMeta,
  buildCvdSeries,
  deltaImbalance,
  resolveSeriesDataTier,
} from "./orderFlow.js";
import {
  detectAbsorption,
  detectStackedDelta,
  detectCvdDivergence,
  evaluateOrderFlowAtLevel,
  evaluateGuideConfluencePass,
  orderFlowExitSignal,
  applyOrderFlowGate,
} from "./orderFlowPatterns.js";

function bar(overrides = {}) {
  return {
    ts: overrides.ts ?? 1_704_067_200_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1000,
    ...overrides,
  };
}

test("barDelta prefers aggTrade buy/sell over OHLCV proxy", () => {
  const proxyBar = bar({ close: 100.9, volume: 1000 });
  const realBar = bar({ close: 100.9, volume: 1000, buy_volume: 800, sell_volume: 200 });

  const proxyMeta = barDeltaMeta(proxyBar, { allowProxy: true });
  const realMeta = barDeltaMeta(realBar, { allowProxy: true });

  assert.equal(realMeta.tier, "aggtrade");
  assert.equal(realMeta.delta, 600);
  assert.notEqual(proxyMeta.delta, realMeta.delta);
});

test("barDelta uses taker_buy_volume when aggTrade missing", () => {
  const b = bar({ taker_buy_volume: 700, volume: 1000 });
  const m = barDeltaMeta(b, { allowProxy: false });
  assert.equal(m.tier, "taker");
  assert.equal(m.delta, 400);
});

test("barDelta returns none when proxy disabled and no real fields", () => {
  const m = barDeltaMeta(bar(), { allowProxy: false });
  assert.equal(m.tier, "none");
  assert.equal(m.delta, 0);
});

test("same OHLCV different buy/sell split yields different CVD", () => {
  const base = { open: 100, high: 101, low: 99, close: 100.5, volume: 1000 };
  const bullish = [
    bar({ ...base, ts: 1, buy_volume: 900, sell_volume: 100 }),
    bar({ ...base, ts: 2, buy_volume: 850, sell_volume: 150 }),
  ];
  const bearish = [
    bar({ ...base, ts: 1, buy_volume: 100, sell_volume: 900 }),
    bar({ ...base, ts: 2, buy_volume: 150, sell_volume: 850 }),
  ];
  const cvdBull = buildCvdSeries(bullish);
  const cvdBear = buildCvdSeries(bearish);
  assert.ok(cvdBull[1] > 0);
  assert.ok(cvdBear[1] < 0);
});

test("detectAbsorption flags high vol opposing delta with held close", () => {
  const candles = [];
  for (let i = 0; i < 25; i++) {
    candles.push(bar({ ts: i * 300_000, volume: 500, high: 101, low: 99, close: 100 }));
  }
  candles.push(
    bar({
      ts: 25 * 300_000,
      volume: 2000,
      open: 100.2,
      high: 100.4,
      low: 100.0,
      close: 100.3,
      buy_volume: 400,
      sell_volume: 1600,
    }),
  );
  const pre = {
    volumes: candles.map((c) => c.volume),
    atrSeries: candles.map(() => 2),
    cvd: buildCvdSeries(candles),
    prevDayLow: candles.map(() => 100.1),
    prevDayHigh: candles.map(() => 102),
    asianHigh: candles.map(() => 101.5),
    asianLow: candles.map(() => 99.5),
  };
  assert.equal(detectAbsorption(candles, candles.length - 1, "BUY", pre, { absorptionVolMult: 1.5, absorptionRangeAtrMult: 0.4 }), true);
});

test("detectStackedDelta requires consecutive same-sign delta bars", () => {
  const candles = [
    bar({ buy_volume: 800, sell_volume: 200 }),
    bar({ buy_volume: 750, sell_volume: 250 }),
    bar({ buy_volume: 700, sell_volume: 300 }),
  ];
  assert.equal(detectStackedDelta(candles, 2, "BUY", { minStackBars: 3, stackDeltaRatio: 0.35 }), true);
  assert.equal(detectStackedDelta(candles, 2, "SELL", { minStackBars: 3, stackDeltaRatio: 0.35 }), false);
});

test("applyOrderFlowGate vetoes when gate patterns fail", () => {
  const candles = [];
  for (let i = 0; i < 120; i++) {
    candles.push(
      bar({
        ts: 1_704_067_200_000 + i * 300_000,
        volume: 500,
        close: 100 + (i % 5) * 0.01,
      }),
    );
  }
  const pre = {
    volumes: candles.map((c) => c.volume),
    atrSeries: candles.map(() => 1.5),
    cvd: buildCvdSeries(candles, { allowProxy: true }),
    prevDayLow: candles.map(() => 98),
    prevDayHigh: candles.map(() => 102),
    asianHigh: candles.map(() => 101),
    asianLow: candles.map(() => 99),
  };
  const idx = candles.length - 1;
  const r = applyOrderFlowGate(candles, idx, "BUY", pre, {
    intradayOfAllowProxy: true,
    intradayOfRequireKeyLevel: true,
    intradayOfMinConfluence: 3,
  });
  assert.equal(r.ok, false);
});

test("resolveSeriesDataTier ranks aggTrade highest", () => {
  const candles = [bar({ buy_volume: 1, sell_volume: 1 }), bar({ volume: 1 })];
  assert.equal(resolveSeriesDataTier(candles, { allowProxy: true }), "aggtrade");
});

test("orderFlowExitSignal ignores weak delta and grace bars after entry", () => {
  const candles = [
    bar({ ts: 1, buy_volume: 100, sell_volume: 900, volume: 1000 }),
    bar({ ts: 2, buy_volume: 200, sell_volume: 800, volume: 1000 }),
    bar({ ts: 3, buy_volume: 800, sell_volume: 200, volume: 1000 }),
    bar({ ts: 4, buy_volume: 850, sell_volume: 150, volume: 1000 }),
  ];
  assert.equal(orderFlowExitSignal(candles, 1, "SELL", {}, 0), false);
  assert.equal(
    orderFlowExitSignal(candles, 3, "SELL", { intradayOfExitGraceBars: 0, intradayOfExitMinDeltaRatio: 0.35 }, 0),
    true,
  );
});

test("evaluateGuideConfluencePass rejects CVD-only without key level", () => {
  assert.equal(
    evaluateGuideConfluencePass(["cvd_divergence"], { confluenceMode: "full", allowCvdOnly: false }),
    false,
  );
  assert.equal(
    evaluateGuideConfluencePass(
      ["key_level", "delta_confirm", "absorption", "cvd_divergence"],
      { absorptionIdx: 10, requireConfirmation: true, confluenceMode: "full" },
    ),
    true,
  );
});

test("deltaImbalance uses real volumes", () => {
  const candles = [
    bar({ buy_volume: 800, sell_volume: 200 }),
    bar({ buy_volume: 700, sell_volume: 300 }),
  ];
  const d = deltaImbalance(candles, 1, 2, { allowProxy: false });
  assert.ok(d.buyPct > 0.65);
});
