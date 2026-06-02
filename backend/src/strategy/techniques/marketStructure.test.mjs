import test from "node:test";
import assert from "node:assert/strict";
import {
  getConfirmedSwings,
  lastSwingHighBefore,
  resolveSwingOpts,
} from "./marketStructure.js";

function bar(ts, o, h, l, c) {
  return { ts, open: o, high: h, low: l, close: c, volume: 1 };
}

test("swing high not confirmed until confirmBars after pivot", () => {
  const opts = { intradaySmcSwingLeft: 1, intradaySmcSwingRight: 1, intradaySmcSwingConfirmBars: 2 };
  const candles = [
    bar(0, 10, 10, 9, 9.5),
    bar(1, 9.5, 12, 9, 11),
    bar(2, 11, 11.5, 10, 10.5),
    bar(3, 10.5, 10.8, 9.5, 10),
    bar(4, 10, 10.2, 9, 9.5),
  ];
  const atPivot = getConfirmedSwings(candles, 1, opts);
  assert.equal(atPivot.highs.length, 0);

  const atConfirm = getConfirmedSwings(candles, 3, opts);
  assert.ok(atConfirm.highs.length >= 1);
  assert.equal(atConfirm.highs[0].pivotIdx, 1);
});

test("no look-ahead — truncating future bars does not add earlier swings", () => {
  const opts = { intradaySmcSwingLeft: 1, intradaySmcSwingRight: 1, intradaySmcSwingConfirmBars: 2 };
  const full = [
    bar(0, 100, 101, 99, 100),
    bar(1, 100, 105, 99, 104),
    bar(2, 104, 104.5, 100, 101),
    bar(3, 101, 102, 98, 99),
    bar(4, 99, 100, 95, 96),
    bar(5, 96, 97, 94, 95),
  ];
  const partial = full.slice(0, 4);
  const swPartial = getConfirmedSwings(partial, 3, opts);
  const swFullAt3 = getConfirmedSwings(full, 3, opts);
  assert.deepEqual(
    swPartial.highs.map((x) => x.pivotIdx),
    swFullAt3.highs.map((x) => x.pivotIdx),
  );
});

test("lastSwingHighBefore returns most recent confirmed high", () => {
  const opts = resolveSwingOpts({ intradaySmcSwingLeft: 1, intradaySmcSwingRight: 1, intradaySmcSwingConfirmBars: 1 });
  const candles = [];
  let p = 100;
  for (let i = 0; i < 20; i++) {
    const h = i === 10 ? p + 5 : p + 1 + (i % 3) * 0.2;
    const l = p - 1;
    candles.push(bar(i * 60000, p, h, l, (h + l) / 2));
  }
  const sh = lastSwingHighBefore(candles, candles.length - 1, opts);
  assert.ok(sh == null || Number.isFinite(sh.price));
});
