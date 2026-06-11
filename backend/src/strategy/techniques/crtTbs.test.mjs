import test from "node:test";
import assert from "node:assert/strict";
import {
  isTurtleBodySoup,
  isTurtleWickSoup,
  buildCrtBrackets,
  buildCrtContext,
  buildCrtTbsSeries,
  CrtTbsDayState,
  detectPendingTbs,
  tryPendingCrtEntry,
  CRT_TBS_WARMUP,
} from "./crtTbs.js";

test("TBS requires sweep reclaim + rejection wick", () => {
  const level = 100;
  const tbsBar = { open: 99.5, high: 100.2, low: 98.8, close: 100.4, volume: 1000 };
  assert.equal(isTurtleBodySoup(tbsBar, level, "BUY", { sweepPct: 0.001, minTbsWick: 0.3, minBodyRatio: 0.2 }), true);
  const twsBar = { open: 100.5, high: 100.6, low: 98.9, close: 100.4, volume: 1000 };
  assert.equal(isTurtleWickSoup(twsBar, level, "BUY", { sweepPct: 0.001 }), true);
  assert.equal(isTurtleBodySoup(twsBar, level, "BUY", { sweepPct: 0.001, minTbsWick: 0.2, minBodyRatio: 0.1 }), false);
});

test("buildCrtBrackets targets EQ and opposite extreme", () => {
  const br = buildCrtBrackets("BUY", 98, 96.5, 110, 90, {});
  assert.ok(br);
  assert.equal(br.tp1Price, 100);
  assert.equal(br.tp2Price, 110);
  assert.ok(br.slPrice < 98);
});

test("buildCrtContext maps previous completed HTF candle", () => {
  const bucket = 4 * 60 * 60 * 1000;
  const t0 = Math.floor(Date.parse("2025-06-01T00:00:00Z") / bucket) * bucket;
  const candles = [];
  for (let i = 0; i < 20; i++) {
    candles.push({
      ts: t0 + i * 15 * 60 * 1000,
      open: 100,
      high: 105,
      low: 95,
      close: 102,
      volume: 100,
    });
  }
  const ctx = buildCrtContext(candles, { crtHtfMs: bucket });
  const last = candles.length - 1;
  assert.equal(ctx.crtHigh[last], 105);
  assert.equal(ctx.crtLow[last], 95);
});

test("pending TBS can enter on later bar when CHoCH window allows", () => {
  const opts = {
    requireChoch: false,
    intradaySmcKillzoneEnabled: false,
    premiumDiscountFilter: false,
    tradeSides: "BOTH",
    maxTradesPerDay: 2,
    minBarGap: 1,
  };
  const candles = [];
  const t0 = Date.parse("2026-06-02T13:00:00Z");
  for (let i = 0; i < 60; i++) {
    candles.push({
      ts: t0 + i * 900_000,
      open: 680,
      high: 682,
      low: 679,
      close: 681,
      volume: 1000,
    });
  }
  const tbsIdx = 50;
  const entryIdx = 51;
  // TBS at CRT low 675: sweep below + reclaim close above
  candles[tbsIdx] = {
    ts: t0 + tbsIdx * 900_000,
    open: 675.2,
    high: 677.2,
    low: 674.2,
    close: 676.8,
    volume: 2000,
  };
  candles[entryIdx] = {
    ts: t0 + entryIdx * 900_000,
    open: 676.8,
    high: 679,
    low: 676,
    close: 678.2,
    volume: 1500,
  };

  const ctx = {
    crtHigh: candles.map(() => 690),
    crtLow: candles.map(() => 675),
    crtEq: candles.map(() => 682.5),
  };
  const pre = { atrSeries: candles.map(() => 3) };
  const dayState = new CrtTbsDayState(opts);
  dayState.ensureDay(Math.floor(t0 / 86400000));

  detectPendingTbs(candles, tbsIdx, pre, ctx, dayState, opts);
  assert.ok(dayState.pending.length >= 1, "should register TBS pending");

  const entry = tryPendingCrtEntry(candles, entryIdx, pre, dayState, opts);
  assert.ok(entry, "should enter when CHoCH not required");
  assert.equal(entry.trigger, "tbs_crt_low_choch");
});

test("buildCrtTbsSeries respects warmup", () => {
  const bucket = 4 * 60 * 60 * 1000;
  const t0 = Date.parse("2025-06-01T00:00:00Z");
  const candles = [];
  for (let i = 0; i < CRT_TBS_WARMUP + 5; i++) {
    candles.push({
      ts: t0 + i * 900_000,
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 100,
    });
  }
  const { series } = buildCrtTbsSeries(candles, {
    requireChoch: false,
    intradaySmcKillzoneEnabled: false,
    premiumDiscountFilter: false,
  });
  for (let i = 0; i < CRT_TBS_WARMUP; i++) assert.equal(series[i], null);
});
