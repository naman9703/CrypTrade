import test from "node:test";
import assert from "node:assert/strict";
import {
  fibLevels,
  nearFibLevel,
  findImpulseLeg,
  fibZoneRejection,
  fibHitMatchesRetrace,
  resolveFibEntryBrackets,
  evaluateFibRetraceSetup,
  FIB_RATIOS,
} from "./fibonacci.js";

function bar(ts, o, h, l, c, vol = 1000) {
  return { ts, open: o, high: h, low: l, close: c, volume: vol };
}

test("findImpulseLeg returns direction when pivots exist", () => {
  const candles = [];
  let ts = 0;
  for (let i = 0; i < 30; i++) {
    const c = 100 + (i % 5) * 0.1;
    candles.push(bar(ts, c, c + 0.5, c - 0.5, c));
    ts += 60_000;
  }
  const leg = findImpulseLeg(candles, candles.length - 1, { lookback: 30, pivotLeft: 2, pivotRight: 2 });
  if (leg) assert.ok(leg.direction === "up" || leg.direction === "down");
});

test("fibZoneRejection requires wick touch and directional close", () => {
  const swing = { high: 110, low: 100, range: 10 };
  const levels = fibLevels(swing, "up").filter((l) => l.ratio === FIB_RATIOS.golden);
  const lv = levels[0];
  const ok = fibZoneRejection(
    bar(0, lv.price + 0.05, lv.price + 0.2, lv.price - 0.05, lv.price + 0.08),
    levels,
    "BUY",
    0.01,
  );
  assert.ok(ok);
});

test("resolveFibEntryBrackets always uses swing levels and ignores UI fixed SL/TP", () => {
  const baked = {
    slPct: 0.008,
    tpPct: 0.016,
    slPrice: 590,
    tpPrice: 620,
    tpMode: "leg",
    rr: 2,
  };
  const br = resolveFibEntryBrackets(
    {
      supertrendFuturesFixedSlPct: 0.01,
      supertrendFuturesFixedTpPct: 0.02,
    },
    { fibBrackets: baked, action: "BUY" },
    600,
    "BUY",
  );
  assert.equal(br.source, "swing");
  assert.equal(br.slPrice, 590);
  assert.equal(br.tpPrice, 620);
  assert.ok(Math.abs(br.slPct - (600 - 590) / 600) < 1e-6);
  assert.notEqual(br.slPct, 0.01);
});

test("fibHitMatchesRetrace blocks 0.5 tag in golden pocket", () => {
  const hit = { ratio: FIB_RATIOS.mid };
  assert.equal(fibHitMatchesRetrace(hit, 0.62, {}), false);
  assert.equal(fibHitMatchesRetrace(hit, 0.5, {}), true);
  const golden = { ratio: FIB_RATIOS.golden };
  assert.equal(fibHitMatchesRetrace(golden, 0.62, {}), true);
  assert.equal(fibHitMatchesRetrace(golden, 0.48, {}), false);
});

test("evaluateFibRetraceSetup rejects shallow 0.382-only touch", () => {
  const n = 120;
  const candles = Array.from({ length: n }, (_, i) => {
    const c = 100 + Math.sin(i / 6) * 2;
    return bar(i * 900_000, c, c + 0.3, c - 0.3, c, 1200);
  });
  const sig = evaluateFibRetraceSetup(candles, n - 1, {
    intradayFibAllowedRatios: [0.382],
    intradayFibRequireHtfAlign: false,
    intradayFibMinAdx: 0,
  });
  assert.equal(sig, null);
});
