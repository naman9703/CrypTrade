import test from "node:test";
import assert from "node:assert/strict";
import { portfolioSliceReplay, portfolioReplay, tradesToTimelineEvents } from "./portfolioReplay.js";

test("portfolioSliceReplay: equal split scales first trade 1:1 when unit start matches slice", () => {
  const events = [
    {
      ts: 1000,
      symbol: "BTCUSDT",
      rawTrade: {
        entryTs: 900,
        exitTs: 1000,
        qty: 0.1,
        entryPrice: 50_000,
        exitPrice: 51_000,
        netPnl: 10,
        grossPnl: 10,
        fees: 0,
        equityAtEntry: 50,
        marginUsdt: 50,
        allowedPoolUsdt: 50,
      },
    },
  ];
  const replay = portfolioSliceReplay({
    events,
    startingUsdt: 100,
    coinCount: 2,
    perCoinUnitStart: 50,
    startTs: 900,
  });
  assert.equal(replay.trades.length, 1);
  assert.equal(replay.trades[0].allowedPoolUsdt, 100);
  assert.equal(replay.trades[0].marginUsdt, 50);
  assert.equal(replay.trades[0].netPnl, 10);
  assert.equal(replay.trades[0].qty, 0.1);
  assert.equal(replay.finalEquity, 110);
});

test("portfolioSliceReplay: compounds shared equity and grows per-coin cap", () => {
  const events = [
    {
      ts: 1000,
      symbol: "BTCUSDT",
      rawTrade: { entryTs: 900, exitTs: 1000, qty: 1, netPnl: 10, equityAtEntry: 50, marginUsdt: 50 },
    },
    {
      ts: 2000,
      symbol: "ETHUSDT",
      rawTrade: { entryTs: 1900, exitTs: 2000, qty: 2, netPnl: 5, equityAtEntry: 50, marginUsdt: 50 },
    },
  ];
  const replay = portfolioSliceReplay({
    events,
    startingUsdt: 100,
    coinCount: 2,
    perCoinUnitStart: 50,
  });
  assert.equal(replay.trades[0].equityAtEntry, 100);
  assert.equal(replay.trades[1].equityAtEntry, 110);
  assert.equal(replay.trades[1].marginUsdt, 55);
  assert.ok(Math.abs(replay.trades[1].qty - 2.2) < 1e-9);
  assert.equal(replay.finalEquity, 115.5);
});

test("portfolioSliceReplay: margin equals equity/coinCount on every trade", () => {
  const events = [
    {
      ts: 1,
      symbol: "A",
      rawTrade: { exitTs: 1, qty: 1, netPnl: -5, equityAtEntry: 25, marginUsdt: 25 },
    },
    {
      ts: 2,
      symbol: "B",
      rawTrade: { exitTs: 2, qty: 1, netPnl: 8, equityAtEntry: 25, marginUsdt: 25 },
    },
  ];
  const replay = portfolioSliceReplay({
    events,
    startingUsdt: 100,
    coinCount: 4,
    perCoinUnitStart: 25,
  });
  for (const t of replay.trades) {
    assert.equal(t.marginUsdt, t.equityAtEntry / 4);
  }
});

test("tradesToTimelineEvents skips tp1_partial", () => {
  const ev = tradesToTimelineEvents("BTCUSDT", [
    { exitTs: 1, exitReason: "tp1_partial", netPnl: 1 },
    { exitTs: 2, exitReason: "tp", netPnl: 2, equityAtEntry: 50 },
  ]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].ts, 2);
});

test("portfolioReplay legacy R-multiple path unchanged", () => {
  const replay = portfolioReplay({
    events: [{ ts: 1, R: 2, symbol: "X", rawTrade: { exitTs: 1, netPnl: 5, equityAtEntry: 100, marginUsdt: 100 } }],
    startingUsdt: 100,
    riskFrac: 0.05,
  });
  assert.equal(replay.trades[0].netPnl, 10);
  assert.equal(replay.finalEquity, 110);
});
